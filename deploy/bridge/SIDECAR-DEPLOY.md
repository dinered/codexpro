# Deploy the separate browser/router containers

The chosen runtime is the existing Paseo container with its native provider,
a separate Chrome/noVNC container, and a separate protocol-v3 bridge container.
Paseo is not rebuilt or restarted. The paused all-in-Paseo draft is not used.

Run `scripts/deploy-sidecars-host.sh <full-source-sha> prepare` on VM108 through
the operator's existing trusted SSH access. The helper reads the running Paseo
home bind, exports only the reviewed Git archive from its existing staging
repository, builds the exact image and writes a non-secret review packet to
`data/codexpro-deploy-20261024/sidecar-image-review.txt` in the First Mate home.
It starts no services in prepare mode.

After independent image/config review, run the same helper with
`<full-source-sha> start-browser <reviewed-image-id>`. It verifies source/image
identity and the existing profile volume before recreating only the scoped
browser. The viewer is `http://192.168.11.241:6081/vnc.html`. CDP/raw VNC stay
internal. The bridge profile is opt-in with restart:no; startup/challenge failures
require explicit operator resume. Keep its dedicated state and browser profile.

The deployed target-image per-chat fixture, viewer/manual login, DE egress,
provider/model discovery and shared ready heartbeat have passed. See
[DEPLOYMENT-STATUS.md](DEPLOYMENT-STATUS.md) for exact deployed identities.
One distinct authorized native message received a real reply in Paseo and
completed after the router corrections. Later consecutive messages exposed
stale-answer delivery while the new text remained in the composer. General live
acceptance is open in [issue #7](http://gitlab.home.arpa/ai-company/codexpro/-/work_items/7);
that correction is not deployed. Login persistence across a browser
restart remains unverified. These updates preserved the browser container ID
and its existing restart count.
Source CI is a smoke job; it does not perform these deployment checks. The local
headless per-chat scenario already passed and should not be repeated as a
substitute for target-image acceptance.

Rollback stops only the new bridge/browser services, preserving their profile
and state. Never use down-v/prune or remove another service. Mac is installation
transport/viewer only; it is not needed for the running browser/router.
