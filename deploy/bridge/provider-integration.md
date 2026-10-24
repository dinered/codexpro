# Native Paseo provider and persistent chat bindings

Candidate for the accepted one-tab-per-Paseo-chat contract. The existing
protocol-v2 plugin under tools/paseo-plugin stays unchanged. This provider uses
the supported direct-provider interface and protocol-v3 task/alive/cancel/result/
ack files. It advertises text messages and session persistence only.

## Exact shared-state proposal

The verified historical Docker metadata maps host
`/opt/stacks/paseo-beta/paseo-home` to `/home/paseo` in Paseo. Confirm that exact
bind remains live before applying this candidate. Create only the dedicated
subdirectory below, UID/GID1000 and mode0700:

- Paseo: `/home/paseo/.paseo/codexpro`
- Docker host: `/opt/stacks/paseo-beta/paseo-home/.paseo/codexpro`
- Only the new router service: `/data`

No broad home/workspace mount enters the router, and no new mount or restart
is needed for Paseo. The router bind has create_host_path:false, so a missing
or wrong source cannot silently become a root-owned directory. Browser profile
stays in its original dedicated volume. No Docker socket, host listener or
new SSH/credential is required. Actual mounting, plugin installation and router startup have been reviewed and
verified; see [DEPLOYMENT-STATUS.md](DEPLOYMENT-STATUS.md) for the deployed identities.

The native plugin default state path matches the dedicated Paseo subdirectory;
CODEXPRO_STATE_DIR can select a separately reviewed existing path. Plugins are
already globally enabled on the affected0.12.0 Docker daemon. Install this
reviewed local plugin only after its protocol/type checks and state mapping
pass; no daemon restart is needed.

## Routing and lifecycle

A new Paseo session gets a random persistent chat key; the key is returned in
native provider persistence. Session restore reuses that key. Every chat has
its own registry entry, spool and saved Chrome target/conversation URL. An
existing domain-matching operator tab is never selected as a fallback.
Missing tabs reopen only the saved conversation, with no fresh-chat fallback
when a previous send has an unresolved URL. Manual navigation to a different
conversation blocks the next send. The saved state contains routing metadata,
not browser credentials.

One serial router shares a single Pacer across chats and calls one reference
Bridge queue step at a time; the original journal/lease/cancel/result engine
remains in use. The router-step overlay exposes that existing step without
rewriting it. Heartbeat ready/paused status lets the provider reject messages
when the router is stopped. Challenge/fatal errors pause the router; Compose
restart remains no. Shutdown disconnects CDP while leaving Chrome and tabs
open. Stop the router before manual interaction, and resume explicitly.

Isolated real-browser acceptance passed in local headless Chrome for
Testing155.0.8059.12: two native sessions, four local synthetic sends, queued
cancellation without sending, router/session restart and closed-tab recovery.
The same per-chat scenario also passed on deployed Google Chrome Stable156;
noVNC/manual login, DE egress and shared ready heartbeat are verified. Login
persistence across a browser restart remains untested. Unit checks cover persistence, trace-matched
results and refusal of cross-chat navigation. No real ChatGPT prompt is
inferred from synthetic acceptance or plugin installation.

## Rollback

Disable only codexpro-browser and stop only the new router. Keep its state,
registry, journals, results and the original browser profile. Browser/manual
viewer continue independently. No down-v, prune, unrelated service change or
chat-state deletion.

## Reproducible checks and pending live acceptance

From the repository root, in the reviewed source:

```sh
npm --prefix deploy/bridge/paseo-plugin ci --ignore-scripts --no-audit --no-fund
npm --prefix deploy/bridge/paseo-plugin test
npm --prefix deploy/bridge/paseo-plugin run typecheck
# BRIDGE_APP is an isolated reference copy with the three runtime overlays.
BRIDGE_APP=/path/to/patched/app node --test deploy/bridge/tab-bindings.test.mjs deploy/bridge/provider-engine.test.mjs
```

The native-provider tests include close/reopen while task publication is pending,
connection teardown, registration teardown, simultaneous chats and a foreign
trace response. Binding checks refuse duplicate target or conversation claims
across persisted keys and serialize claim updates under the router's flock.
The provider-engine fixture exchanges actual v3 files with the reference engine
and proves its single shared Pacer limits sends across two chats.

`per-chat-browser.test.mjs` passed against isolated local Chrome for Testing.
It overrides the platform profile to a dedicated container-loopback HTTP fixture;
its start URL, all conversation URLs and synthetic sends stay on that origin.
It exercises two native sessions, four synthetic sends, queued cancellation,
router/session restart and closed-tab restoration. It also passed against the reviewed deployed target image. The earlier
real-Chrome shutdown fixture passed all three cases; that does not substitute
for this per-chat acceptance.

After the live bind and new image are reviewed, the supported pinned install is:

```sh
paseo plugin install http://gitlab.home.arpa/ai-company/codexpro.git \
  --path deploy/bridge/paseo-plugin --ref <reviewed-source-sha> \
  --id codexpro-browser --json
paseo plugin ls --json
```

Require the exact plugin running, native provider/catalog discovery and the
synthetic scenario on the intended daemon. Do not restart Paseo or read/reuse
its credential stores. The installed provider is pinned to7c53c216a2c7013af8eb44f7476ecc65d0a71d6d;
its source is unchanged at the deployed e04c76b image revision. Installation
and model discovery were verified without restarting Paseo.
