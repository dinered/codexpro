# Verified deployment — 2026-10-24

Browser and router were last verified running on VM108; native provider `codexpro-browser`
is available in Paseo as **ChatGPT (Chrome)**, model `chatgpt`. A new Paseo
conversation receives its own persistent Chrome tab. The operator completed
manual ChatGPT login. Synthetic acceptance submitted no real ChatGPT prompts. The first operator
message received a reply in Chrome, but exposed a URL-binding race before
forwarding to Paseo. The first router fix is deployed, but a clean-chat message
subsequently hit the same guard. End-to-end forwarding remains unaccepted.
The original messages were not replayed.

- Browser source: `e04c76b0f607c9dbf145b648c38893e1a243857b`.
- Browser image: `sha256:a36ac8dc2761da676ed9823559b4a5fdd9b0fbfd4dcb7d1c2b69ee1a2d9cc90b`.
- Router source: `f486ec7fe535f4f8571a1376cc7adc990886dbc6`.
- Router image: `sha256:8163947441f8b76ebe1d0b9b41dde73e87e8b3b2e8c6eaeba3f036949cea1abb`.
- Installed provider source: `7c53c216a2c7013af8eb44f7476ecc65d0a71d6d`; provider source unchanged at runtime revision.
- Viewer: http://192.168.11.241:6081/vnc.html?autoconnect=1&resize=scale
- Profile volume: `codexpro-reference_profile` at `/home/node/profile`.
- State: host `/opt/stacks/paseo-beta/paseo-home/.paseo/codexpro`, Paseo `/home/paseo/.paseo/codexpro`, router `/data` (only this dedicated RW bind).

Target Chrome Stable 156 passed the local two-chat scenario: four loopback
synthetic sends, cancellation without sending, independent conversations,
router/session restart and closed-tab recovery. Nonroot validation read 1805
static files and loaded runtime dependencies. Actual browser was healthy with
zero restarts/OOM; router was running with a fresh shared ready heartbeat.
Country-only container egress returned **DE**. Native plugin/provider/model
catalogs were checked. No Paseo or logged-in browser restart was needed for
router activation or the subsequent router-only URL-race fix.

The fix handles the first conversation URL appearing between two checks, after
send intent was persisted. Same-target/origin and cross-chat exclusivity checks
remain enforced. Five binding tests and a target-image fixture with a75ms URL
transition delay passed. Failed task/result/journal files were retained unchanged.

A browser restart after manual login has not been performed. Persistent volume
configuration and tab recovery do not prove authentication survives that restart.

## Prepared correction; deployment pending

The candidate includes the exact `Send` button-label alias and a bounded first-URL
settling wait: up to two seconds after persisted send intent, with target and
origin checked on every sample. Only the home page or an exclusively claimed
canonical conversation may pass. Existing conversation bindings remain immutable;
login/challenge paths and unsent transitions fail immediately. Rejection diagnostics
contain reason flags, without conversation URLs or message contents.

Eleven binding/selector tests and deployment TypeScript checking pass. A fresh
local Chromium fixture passes four synthetic sends across two chats, cancellation
without sending, router restart and closed-tab recovery, including an intermediate
`/c/` path on the first send. This reproduces a possible failure mechanism; the
live failure-time path was not captured and its cause remains unconfirmed.

The combined candidate has not been built or activated on VM108. Existing Mac SSH
access is unavailable; direct SSH lacks established host trust. The repeatable
prepare-only helper and validation evidence are retained in the First Mate record
directory. Actual immutable image/configuration review and target Chrome acceptance
must precede router replacement. The deployed revision/images listed above remain
the last verified identities. Browser/login/state and the paused packaging
alternative are preserved.

## Manual takeover and restart behavior

Browser uses `restart: unless-stopped`; router deliberately uses `restart: no`.
A router exit, host reboot, or explicit stop requires an explicit router start.
No automatic challenge retry or queue resumption is promised.

Before manual browsing/CAPTCHA, stop only the router on VM108:

```sh
docker stop codexpro-reference-bridge-1
```

Complete manual interaction in the viewer. Review retained queue/state before
resuming; then explicitly start that same router:

```sh
docker start codexpro-reference-bridge-1
```

Router readiness is a fresh `state: ready` entry in the shared `router.json`;
its provider rejects sends while that heartbeat is stale or stopped. Keep the
profile and state on rollback. Do not remove volumes, clear locks or use down-v.
Mac is an administration/viewer client, not a runtime dependency.

## Evidence

The First Mate record directory `data/codexpro-deploy-20261024/` retains
`e04c76b-sidecar-image-review.txt`, `router-effective-config.json`,
`target-per-chat-browser.txt`, `browser-live-readback.json`,
`browser-egress-country.txt`, `router-container-readback.json` and
`router-live-readback.json`. Original permission failures and corrected
archive/validator counterfactuals are preserved alongside the successful results.
