#!/bin/bash
# Run on VM108 via the operator's existing SSH access. Never restarts Paseo.
# prepare builds/reviews only; start-browser requires its independently reviewed image ID.
set -euo pipefail
umask 077
source_sha=${1:-}
mode=${2:-prepare}
expected_image=${3:-}
[[ "$source_sha" =~ ^[a-f0-9]{40}$ ]] || { echo 'Pass the reviewed full source SHA.' >&2; exit 2; }
[[ "$mode" = prepare || "$mode" = start-browser ]] || exit 2
if [[ "$mode" = start-browser ]]; then
  [[ "$expected_image" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'Pass the reviewed immutable image ID.' >&2; exit 2; }
fi
container=paseo-beta
repo=/tmp/codexpro-main-sync-20261022-zpryx6/repo
lan_ip=192.168.11.241
command -v docker >/dev/null
command -v ip >/dev/null
ip -4 -o addr show | awk -v ip="$lan_ip" '{split($4,a,"/"); if(a[1]==ip) found=1} END {exit !found}' || { echo 'Reviewed host address is absent.' >&2; exit 1; }
[[ "$(docker inspect --format '{{.State.Running}}' "$container")" = true ]] || exit 1
home_bind=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/home/paseo"}}{{if .RW}}{{.Source}}{{end}}{{end}}{{end}}' "$container")
[[ -n "$home_bind" && "$home_bind" = /* && -d "$home_bind" ]] || { echo 'Live persistent Paseo home bind unavailable.' >&2; exit 1; }
state_dir="$home_bind/.paseo/codexpro"
export BRIDGE_IMAGE_TAG="$source_sha" BRIDGE_VIEWER_BIND_IP="$lan_ip" BRIDGE_STATE_HOST_DIR="$state_dir"
# Direct guest egress was the reviewed route; do not inherit an operator shell proxy.
export CHROME_PROXY_SERVER=
base="$HOME/codexpro-reference-pilot"
mkdir -p "$base"
stage="$base/source-$source_sha"
if [[ "$mode" = prepare ]]; then
  [[ ! -e "$stage" ]] || { echo "Preserved staging already exists: $stage; review/reuse manually, never overwritten." >&2; exit 1; }
  available_kb=$(df -Pk "$base" | awk 'END {print $4}')
  (( available_kb >= 10 * 1024 * 1024 )) || { echo 'At least10GiB free disk required before build.' >&2; exit 1; }
  docker exec -u paseo "$container" git -C "$repo" cat-file -e "$source_sha^{commit}"
  mkdir -m 700 "$stage"
  docker exec -u paseo "$container" git -C "$repo" archive --format=tar "$source_sha" docs/mydocs/z.ai/download/bridge-reference deploy/bridge | tar --same-permissions -xf - -C "$stage"
  printf '%s\n' "$source_sha" > "$stage/SOURCE_SHA"
  docker exec -u paseo "$container" sh -c 'umask 077; mkdir -p /home/paseo/.paseo/codexpro; chmod 700 /home/paseo/.paseo/codexpro'
fi
[[ -f "$stage/SOURCE_SHA" && "$(cat "$stage/SOURCE_SHA")" = "$source_sha" ]] || { echo 'Prepared source identity does not match.' >&2; exit 1; }
cd "$stage/deploy/bridge"
compose=(docker compose --env-file /dev/null -f compose.yaml)
"${compose[@]}" config --quiet
if [[ "$mode" = prepare ]]; then
  "${compose[@]}" build browser
  image_id=$(docker image inspect --format '{{.Id}}' "codexpro-reference:$source_sha")
  # Read every static runtime tree and load dependencies as the default nonroot user.
  # No browser, profile/state mount, network access or real prompt is involved.
  docker run --rm -i --network none --entrypoint node "$image_id" --input-type=module \
    < scripts/check-image-access.mjs > "$stage/runtime-access.txt" 2>&1 || { cat "$stage/runtime-access.txt"; exit 1; }
  cat "$stage/runtime-access.txt"
  printf '%s\n' "$image_id" > "$stage/IMAGE_ID"
  printf '{"services":{"browser":{"image":"%s"},"bridge":{"image":"%s"}}}\n' "$image_id" "$image_id" > "$stage/image.override.json"
  "${compose[@]}" -f "$stage/image.override.json" config --format json > "$stage/effective-config.json"
  sha256sum compose.yaml seccomp_profile.json "$stage/image.override.json" > "$stage/CONFIG.sha256"
  printf '%s\n' "$state_dir" > "$stage/STATE_BIND"
  # Only scoped, non-secret image/config fields are copied to the review packet.
  packet="$stage/review.txt"
  {
    printf 'SOURCE=%s\nIMAGE=%s\nLAN_VIEWER=%s:6081\nSTATE_BIND=%s\n' "$source_sha" "$image_id" "$lan_ip" "$state_dir"
    docker image inspect --format 'User={{.Config.User}} Cmd={{json .Config.Cmd}}' "$image_id"
    docker run --rm --network none --entrypoint node "$image_id" --version
    docker run --rm --network none --entrypoint google-chrome-stable "$image_id" --version
    cat "$stage/runtime-access.txt"
    sha256sum Dockerfile compose.yaml seccomp_profile.json supervise.py health.py scripts/check-image-access.mjs
  } > "$packet"
  docker exec -i -u paseo "$container" sh -c 'cat > /workspace/company/firstmate/data/codexpro-deploy-20261024/sidecar-image-review.txt' < "$packet"
  docker exec -i -u paseo "$container" sh -c 'cat > /workspace/company/firstmate/data/codexpro-deploy-20261024/sidecar-effective-config.json' < "$stage/effective-config.json"
  cat "$packet"
  printf 'Prepared only; no browser/router restart. After independent image review:\n'
  printf 'bash %q %q start-browser %q\n' "$stage/deploy/bridge/scripts/deploy-sidecars-host.sh" "$source_sha" "$image_id"
  exit 0
fi
sha256sum --check --status "$stage/CONFIG.sha256" || { echo 'Prepared config/policy changed; startup refused.' >&2; exit 1; }
[[ "$(cat "$stage/STATE_BIND")" = "$state_dir" ]] || { echo 'Live Paseo home mapping changed; startup refused.' >&2; exit 1; }
[[ "$(cat "$stage/IMAGE_ID")" = "$expected_image" ]] || { echo 'Recorded reviewed image differs.' >&2; exit 1; }
[[ "$(docker image inspect --format '{{.Id}}' "codexpro-reference:$source_sha")" = "$expected_image" ]] || { echo 'Image tag moved; startup refused.' >&2; exit 1; }
# Keep the existing project/profile identity; never stop or delete unrelated containers.
if docker inspect codexpro-reference-browser-1 >/dev/null 2>&1; then
  [[ "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' codexpro-reference-browser-1)" = codexpro-reference ]] || exit 1
  [[ "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/home/node/profile"}}{{.Name}}{{end}}{{end}}' codexpro-reference-browser-1)" = codexpro-reference_profile ]] || { echo 'Existing profile volume differs; preserved unchanged.' >&2; exit 1; }
fi
compose+=(-f "$stage/image.override.json")
"${compose[@]}" config --quiet
"${compose[@]}" up -d --no-deps --no-build --pull never --wait --wait-timeout 60 browser
[[ "$(docker inspect --format '{{.Image}}' codexpro-reference-browser-1)" = "$expected_image" ]] || exit 1
[[ "$(docker inspect --format '{{json .HostConfig.PortBindings}}' codexpro-reference-browser-1)" = '{"6080/tcp":[{"HostIp":"192.168.11.241","HostPort":"6081"}]}' ]] || { echo 'Unexpected viewer mapping; inspect before further acceptance.' >&2; exit 1; }
"${compose[@]}" exec -T browser python3 /opt/bridge/health.py
"${compose[@]}" ps
printf 'Browser ready: http://%s:6081/vnc.html?autoconnect=1&resize=remote\nRouter remains opt-in; no ChatGPT prompts sent.\n' "$lan_ip"
