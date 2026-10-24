# Verified deployment — 2026-10-24

Browser and router are running on VM108; native provider `codexpro-browser`
is available in Paseo as **ChatGPT (Chrome)**, model `chatgpt`. A new Paseo
conversation receives its own persistent Chrome tab. The operator completed
manual ChatGPT login. No real ChatGPT prompt was submitted during acceptance;
the first operator-initiated response remains unverified.

- Runtime source: `e04c76b0f607c9dbf145b648c38893e1a243857b`.
- Browser/router image: `sha256:a36ac8dc2761da676ed9823559b4a5fdd9b0fbfd4dcb7d1c2b69ee1a2d9cc90b`.
- Installed provider source: `7c53c216a2c7013af8eb44f7476ecc65d0a71d6d`; provider source unchanged at runtime revision.
- Viewer: http://192.168.11.241:6081/vnc.html?autoconnect=1&resize=scale
- Profile volume: `codexpro-reference_profile` at `/home/node/profile`.
- State: host `/opt/stacks/paseo-beta/paseo-home/.paseo/codexpro`, Paseo `/home/paseo/.paseo/codexpro`, router `/data` (only this dedicated RW bind).

Target Chrome Stable156 passed the local two-chat scenario: four loopback
synthetic sends, cancellation without sending, independent conversations,
router/session restart and closed-tab recovery. Nonroot validation read1805
static files and loaded runtime dependencies. Actual browser was healthy with
zero restarts/OOM; router was running with a fresh shared ready heartbeat.
Country-only container egress returned **DE**. Native plugin/provider/model
catalogs were checked. No Paseo or logged-in browser restart was needed for
router activation.

A browser restart after manual login has not been performed. Persistent volume
configuration and tab recovery do not prove authentication survives that restart.

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
