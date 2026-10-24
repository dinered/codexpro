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
new SSH/credential is required. Actual mounting, plugin installation and router
start await exact config/source/image review and live bind confirmation.

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

Pending real Chrome acceptance: two local synthetic conversations through the
native provider and reference engine, alternating turns, cancel, profile/router
restart and closed-tab recovery. Unit checks cover persistence, trace-matched
results and refusal of cross-chat navigation. No real ChatGPT prompt is
inferred from synthetic acceptance or plugin installation.

## Rollback

Disable only codexpro-browser and stop only the new router. Keep its state,
registry, journals, results and the original browser profile. Browser/manual
viewer continue independently. No down-v, prune, unrelated service change or
chat-state deletion.
