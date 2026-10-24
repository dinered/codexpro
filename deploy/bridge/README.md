# Docker pilot: ordinary Chrome and bridge reference

Candidate configuration; first live start requires First Mate review. Source is
reference commit `9c556b1833cdad6589c85506605cd2ea4d156882`. The snapshot under
`docs/mydocs/z.ai/download/bridge-reference` stays unchanged. The only runtime
overlay makes `readPage` self-contained when Playwright serializes it.

## Processes and access

`browser` starts Google Chrome Stable separately from Playwright, with a new
dedicated persistent profile. Xvnc/Openbox provide its display; noVNC 1.7.0 and
websockify 0.13.0 show that same display in the operator's Chrome tab. Viewer
archives and Chrome package are SHA-256 pinned in Dockerfile. The existing
harness-home Chrome/Xvnc pattern and its seccomp policy are reused, without
its agent credentials, home volume or browser profiles.

Only `127.0.0.1:6081` on the Docker host is published. VNC5900 and CDP9222
are loopback-only *inside* the container. No Docker socket or host home is
mounted. Browser access uses the existing SSH route, without new credentials,
firewall/DNS rules or a LAN/public listener:

```sh
# On Captain's Mac. Existing alias; local port 6081 must be free.
ssh -N -o RemoteCommand=none -o RequestTTY=no -o ForwardAgent=no \
  -o ExitOnForwardFailure=yes -L 127.0.0.1:6081:127.0.0.1:6081 harness-home
# Open in ordinary Chrome on Mac:
# http://127.0.0.1:6081/vnc.html?autoconnect=1&resize=remote
```

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
candidate does not certify VM108's ChatGPT egress. Never include credentials
in that variable or command-line URLs.

## Manual takeover and bridge lifecycle

The reference is a protocol-v3 bridge plus a CLI client, not a registered Paseo
provider plugin. Codex CLI and the upstream codexpro MCP server are not runtime
dependencies. A compatible provider adapter or explicit CLI spool producer is
needed for actual Paseo turns; do not connect the old protocol-v2 provider.

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

Reference challenge/login failures stop the bridge. The display/Chrome remain
available for the operator. A bridge exit must not cause automatic retries or
new messages; do not change its restart policy to work around this.

## Validation and outstanding gates

The deployment serialization test fails on the untouched source with
`visibleIn is not defined`, and passes with the overlay. Reference TypeScript
checks pass. The final isolated validation copy passes all 64 source tests,
including the 120-case H1 crash/recovery model, plus both serialization tests.
The source snapshot remains unchanged. h1-fixture.patch affects validation
only: it gives real filesystem I/O event-loop time while advancing the manual
clock in H1 and the lease test, and settles H1 workers before temporary-spool
cleanup. It is never applied to the runtime image. Earlier fixture failures
remain recorded in the task evidence. Browser and bridge acceptance still
require the live checks below; a passing source suite does not establish them.

```sh
# Creates and retains an isolated copy with runtime and test-fixture overlays.
sh deploy/bridge/check.sh
```

The reviewed image built successfully and the initial browser reached healthy
with zero restarts. It was then stopped cleanly (exit0, no OOM) because physical
PVE MemAvailable fell below the 3GiB acceptance floor; the new image and profile
are retained. The immediate manual readiness probe ran before CDP was listening;
Docker health passed once startup completed. There is no completed noVNC,
session-persistence or bridge-lifecycle acceptance yet.

Planned live acceptance after capacity recovers and review: browser health, loopback-only bindings,
same local fixture/tab through CDP and noVNC, dedicated-profile persistence
across a controlled browser restart, manual stop/resume with no task loops.
`lifecycle.test.mjs` is a pending local-fixture regression for operator stop,
startup error and synthetic challenge; it verifies process exit, zero submissions
and survival of the separately launched Chrome. Run it inside the reviewed
browser container with Node after capacity is available. `operator-fixture.mjs`
provides the local page for noVNC/CDP input identity and profile persistence:
run its `serve` mode, then `set`, restart only this browser, restart the fixture
server, then use `check`. Fixture origin is container-loopback port8049; it is
never published. These helpers are prepared, syntax checked and have not yet
run against Chrome.

Do not use real ChatGPT prompts as smoke. Operator login is a separate manual
step, not synthetic-test evidence.

## Rollback and preserved data

```sh
docker compose --profile bridge stop bridge
docker compose stop browser
```

Keep `codexpro-reference_profile` and `codexpro-reference_spool` volumes; never
use down-v/prune, remove profile locks/data, or downgrade Chrome on the same
profile. No other container/volume is in scope. Inspect any current queue
before restarting; reference journal/idempotency decisions remain unchanged.
