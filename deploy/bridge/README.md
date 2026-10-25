# Docker pilot: ordinary Chrome and bridge reference

Deployed pilot; see [DEPLOYMENT-STATUS.md](DEPLOYMENT-STATUS.md) for verified runtime and remaining checks. Reference source is
reference commit `9c556b1833cdad6589c85506605cd2ea4d156882`. The snapshot under
`docs/mydocs/z.ai/download/bridge-reference` stays unchanged. Runtime overlays make `readPage` self-contained when Playwright serializes
it and disconnect the bridge-owned CDP connection when the process completes.
Chrome and its operator tabs remain open independently of bridge shutdown.

## Processes and access

`browser` starts Google Chrome Stable separately from Playwright, with a new
dedicated persistent profile. Xvnc/Openbox provide its display; noVNC 1.7.0 and
websockify 0.13.0 show that same display in the operator's Chrome tab. Viewer
archives and Chrome package are SHA-256 pinned in Dockerfile. The existing
harness-home Chrome/Xvnc pattern and its seccomp policy are reused, without
its agent credentials, home volume or browser profiles.

The noVNC viewer is published on VM108's LAN address, `192.168.11.241:6081`,
as requested for the same direct LAN access as harness-home. Open this URL in
Chrome from a device on the local network:

http://192.168.11.241:6081/vnc.html?autoconnect=1&resize=scale

`BRIDGE_VIEWER_BIND_IP` defaults to that exact LAN address; verify it is still
assigned to the Docker host before applying the configuration. CDP9222 and
raw VNC5900 stay loopback-only inside the container. The viewer uses the same
browser display and dedicated profile. This mapping needs no SSH tunnel,
Docker socket, host-home mount or firewall/DNS change. The LAN mapping is deployed; the operator confirmed the same Chrome screen and completed manual login.

This is the remote Chrome's screen, not a second authenticated browser session.
Captain manually navigates, logs in and handles CAPTCHA. No passwords, cookies
or profiles are extracted/copied. Ordinary Chrome does not guarantee ChatGPT
will accept the session. Existing TigerVNC is a fallback, not this browser UI.

## Reviewable build/start

Use a dedicated checkout on VM108, never the Mac view or another stack. Record
the exact reviewed Git SHA as `BRIDGE_IMAGE_TAG`; `docker compose` requires it.
Only this pilot may be touched. A 1.5GiB total/1CPU cap is an estimate from the
resource audit, not capacity certification; avoid simultaneous OmO pilots.
Keep image/build/profile footprint within 4GiB and guest free disk above 10GiB.
Check physical PVE MemAvailable before and during acceptance; keep at least
3GiB available and stop only this pilot if the reserve drops below that floor
or sustained memory pressure/degradation appears. Guest free memory alone
does not establish physical-host capacity.

```sh
cd deploy/bridge
export BRIDGE_IMAGE_TAG=<exact-reviewed-git-sha>
export BRIDGE_VIEWER_BIND_IP=192.168.11.241
docker compose config --quiet
docker compose build browser
# Record immutable image ID and installed Chrome/Node versions before startup.
# First Mate reviews concrete config/image before the next command.
docker compose up -d --no-build --pull never --wait --wait-timeout 50 browser
docker compose ps
docker compose exec -T browser python3 /opt/bridge/health.py
```

Startup opens `about:blank` only and does not run the bridge. Before navigating
ChatGPT, confirm the approved existing network egress: project instructions
require FOREIGN_STRICT. `CHROME_PROXY_SERVER` accepts a verified existing proxy;
this package does not create a proxy/tunnel or change host routing. The
deployed container returned DE in the country-only egress check. Never include credentials
in that variable or command-line URLs.

## Manual takeover and bridge lifecycle

The deployment includes a native Paseo0.12.x text provider candidate under
`paseo-plugin/` and a serial protocol-v3 router under `runtime/`. See
[provider-integration.md](provider-integration.md) for the exact dedicated shared
state mapping, review gates and limitations. Every Paseo conversation retains
its own ChatGPT tab/conversation binding. The original protocol-v2 provider
stays unchanged and must not be connected to this router. Codex CLI and the
upstream codexpro MCP server are not runtime dependencies.

The bridge service is opt-in, has no automatic restart and holds an exclusive
spool lock. First verify an empty dedicated spool and the same visible session;
never point it at old demo/live task directories. Browser health alone is not
bridge readiness or accepted ChatGPT automation.

```sh
# Only after First Mate reviews the candidate and Captain completes login.
docker compose --profile bridge up -d bridge
docker compose logs --tail=50 bridge
# Before interacting manually with the remote Chrome:
docker compose --profile bridge stop bridge
# Captain takes over in noVNC; there is no CAPTCHA bypass or login retry loop.
# Resume explicitly only after the session is ready and queue state reviewed:
docker compose --profile bridge start bridge
```

A real-Chrome local fixture reproduced hanging processes after operator stop,
startup error and a synthetic challenge. The shutdown overlay fixes all three:
the process exits, sends zero messages, and leaves Chrome and its tab alive.
The meaningful before/after regression is `lifecycle.test.mjs`; all three cases
pass with the overlay. Reference challenge/login failures stop the bridge. The display/Chrome remain
available for the operator. A bridge exit must not cause automatic retries or
new messages; do not change its restart policy to work around this.

## Validation and outstanding gates

The deployment serialization test fails on the untouched source with
`visibleIn is not defined`, and passes with the overlay. Reference TypeScript
checks include the reference suite with the 120-case H1 crash/recovery model,
the patched source and deployment types, and the serialization fixtures.
The reference test harness gives real filesystem I/O event-loop time while
advancing the manual clock in H1 and the lease test, and settles H1 workers
before temporary-spool cleanup. These fixture corrections are checked into the
reference tests; no separate h1-fixture overlay is required. Earlier fixture failures
remain recorded in the task evidence. Browser and bridge acceptance still
require the live checks below; a passing source suite does not establish them.

```sh
# Creates and retains an isolated copy with the deployment overlays.
sh deploy/bridge/check.sh
```

The deployed Chrome Stable156 image and router have verified immutable image
identity, healthy/running status and the reviewed state/port mappings. Browser
has one earlier restart of unknown cause; the current router has zero restarts.
Router replacements preserved the browser ID and restart count. The existing
Mac SSH route was restored and used for router startup.

The three real-Chrome lifecycle cases passed with the shutdown overlay: stop,
startup error and synthetic challenge exit without submissions while preserving
Chrome. The operator confirmed viewer input and manual login. Login persistence
across a browser/container restart remains unverified.

The prepared `per-chat-browser.test.mjs` passed in isolated local Chrome for
Testing155.0.8059.12 (headless), against a loopback HTTP fixture. It ran four
synthetic sends through the native provider, reference engine and real browser:
two conversations kept distinct targets/URLs, a queued cancellation sent nothing,
router/session restart retained bindings and a closed tab recovered the same
conversation. This is local integration evidence, not acceptance of the target
Google Chrome Stable156 image or the deployed noVNC endpoint.

The minimal local environment initially lacked fonts: a contenteditable field
contained the inserted HTML but returned empty innerText, so TEXT_MISMATCH
blocked sending. Adding the same fonts-liberation package used by the image to
isolated temporary staging fixed the counterfactual; the exact scenario then
passed without source or assertion changes. System packages stayed unchanged.

The same per-chat scenario also passed against the deployed Chrome Stable156
image: four loopback sends, cancellation without a send, isolation, router/session
restart and closed-tab recovery. Native provider/model discovery, DE egress and
the actual shared router heartbeat passed. After the URL-binding, inactive-tab
startup and modern idle-control corrections, one distinct authorized native
message received its real answer in Paseo and completed. Its task text contained
only ordinary user input. Login persistence across a browser restart remains
unverified; see the exact runtime and acceptance evidence in
[DEPLOYMENT-STATUS.md](DEPLOYMENT-STATUS.md).
`operator-fixture.mjs` uses container-loopback port8049, which stays unpublished.

Do not use real ChatGPT prompts as smoke. Operator login is a separate manual
step, not synthetic-test evidence.

## Rollback and preserved data

```sh
docker compose --profile bridge stop bridge
docker compose stop browser
```

Keep `codexpro-reference_profile`, any earlier spool volume and the dedicated
provider/router state bind; never
use down-v/prune, remove profile locks/data, or downgrade Chrome on the same
profile. No other container/volume is in scope. Inspect any current queue
before restarting; reference journal/idempotency decisions remain unchanged.
