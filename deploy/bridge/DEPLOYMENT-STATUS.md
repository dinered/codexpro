# Verified deployment — 2026-10-24

Browser and router were last verified running on VM108; native provider `codexpro-browser`
is available in Paseo as **ChatGPT (Chrome)**, model `chatgpt`. A new Paseo
conversation receives its own persistent Chrome tab. The operator completed
manual ChatGPT login. Synthetic acceptance submitted no real ChatGPT prompts. The first operator
message received a reply in Chrome, but exposed a URL-binding race before
forwarding to Paseo. Router corrections are now deployed. One distinct authorized
native message in **ChatGPT — рабочий чат** received the answer `работает` in
Paseo and completed with native status `idle` and protocol acknowledgement.
Its task text exactly matched ordinary user input, without agent metadata.
Earlier failed/cancelled messages were retained and were not replayed.

- Browser source: `e04c76b0f607c9dbf145b648c38893e1a243857b`.
- Browser image: `sha256:a36ac8dc2761da676ed9823559b4a5fdd9b0fbfd4dcb7d1c2b69ee1a2d9cc90b`.
- Router source: `d928d7a0b9c546a9862601437a634ee2a0df630a` (subsequent documentation changes do not change this running image).
- Router image: `sha256:e4bbe3a1ea90904acb00ee41a61271bd1258dd25508eb98a1f318131de25d345`.
- Installed provider source: `7c53c216a2c7013af8eb44f7476ecc65d0a71d6d`; provider source unchanged at runtime revision.
- Viewer: http://192.168.11.241:6081/vnc.html?autoconnect=1&resize=scale
- Profile volume: `codexpro-reference_profile` at `/home/node/profile`.
- State: host `/opt/stacks/paseo-beta/paseo-home/.paseo/codexpro`, Paseo `/home/paseo/.paseo/codexpro`, router `/data` (only this dedicated RW bind).

Target Chrome Stable 156 passed the local two-chat scenario: four loopback
synthetic sends, cancellation without sending, independent conversations,
router/session restart and closed-tab recovery. Nonroot validation read 1805
static files and loaded runtime dependencies. Browser is healthy with one
historical restart and no OOM; router is running with zero restarts and a fresh
shared ready heartbeat. Browser container ID and restart count stayed unchanged
through these router replacements. Its last restart at 17:02:31 UTC predates
this preparation; the trigger is unknown.
Country-only container egress returned **DE**. Native plugin/provider/model
catalogs were checked. No Paseo or logged-in browser restart was needed for
router activation or the subsequent router-only URL-race fix.

Login persistence across a browser restart has not been verified. The successful
live message establishes authentication for the current session.

## Deployed corrections and acceptance

The running router includes the exact `Send` button-label alias and a bounded first-URL
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

Inactive saved tabs are now restored only when their chat has runnable work.
An old inactive tab on the platform home page therefore does not block a new
chat at router startup. A pending stale chat still fails closed before sending;
target/origin/conversation/exclusivity checks remain enforced.

The completion overlay accepts the current `Start Voice` idle control only when
it is visible and enabled, the visible composer is empty, and assistant text is
present. Stable-answer, no-stop and no-streaming checks still apply. The Send
path remains supported. Seven selector/completion checks and TypeScript pass;
the actual Chrome 156 image passes the updated two-chat fixture, including
Voice idle, cancellation, restart, closed-tab recovery and stale-tab negatives.

The reviewed guarded helper replaced only the router and passed readiness,
actual source hashes, exact image/configuration/bind checks, unchanged browser
identity/restart count, and all five previous acknowledged-turn snapshots.
The distinct live acceptance then delivered its answer and completed in Paseo.
Browser/profile/state, earlier failed turns and paused packaging work remain
preserved. General agent-message metadata filtering remains separate issue #6;
ordinary native input was used for this acceptance.

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
Latest records are `voice-idle-review-packet.json`, `voice-idle-apply-exit.json`,
`voice-idle-independent-containers.json`, `voice-idle-router-image-files.txt`,
`voice-idle-history-after.json` and `live-acceptance-voice-idle.json`. The running
configuration SHA-256 is `fab0cc65c5dbd820c74edb657881e6689c4c691994fcef531832528afee7f24b`;
override SHA-256 is `4641c6fc46cbdbd9cadac1ad65679790b17bc0948daa390d7babf7d1f0a0a38a`.
