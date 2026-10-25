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

After checking the exact image/config within the operator work order, run the helper with
`<full-source-sha> start-browser <reviewed-image-id>`. It verifies source/image
identity and the existing profile volume before recreating only the scoped
browser. The viewer is `http://192.168.11.241:6081/vnc.html`. CDP/raw VNC stay
internal. The bridge profile is opt-in with restart:no; startup/challenge failures
require explicit operator resume. Keep its dedicated state and browser profile.

The deployed target-image per-chat fixture, viewer/manual login, DE egress,
provider/model discovery and shared ready heartbeat have passed. See
[DEPLOYMENT-STATUS.md](DEPLOYMENT-STATUS.md) for exact deployed identities.
The `52a07ce` correction for [issue #7](http://gitlab.home.arpa/ai-company/codexpro/-/work_items/7)
is installed. Two consecutive authorized native messages, including multiline
input, received distinct expected answers in Chrome and Paseo, with trace-matched
acknowledgements. The ineffective-second-send case passed in a packaged synthetic
regression; no uncertain real message was retried. Login persistence across a browser
restart remains unverified. These updates preserved the browser container ID
and its existing restart count.
For a router-only replacement, retain the browser image and container and use
the prepared immutable override with `up -d --no-deps --no-build --pull never bridge`.
Render with `--profile bridge config --format json` so the review packet includes
the opt-in router. Verify fresh ready heartbeat and an empty runnable queue.
On this host, check state existence through `docker exec -u paseo paseo-beta`,
rather than changing permissions to traverse the private state from the host user.
Reuse an existing exact source stage after manifest verification; the prepare
helper deliberately refuses to overwrite it.

Source CI is a smoke job; it does not perform these deployment checks. The local
headless per-chat scenario already passed and should not be repeated as a
substitute for target-image acceptance.

Rollback stops only the new bridge/browser services, preserving their profile
and state. Never use down-v/prune or remove another service. Direct `ssh codexpro-vm108` from Paseo is available; Mac and CT107 are not
needed for this route or for the running browser/router.
