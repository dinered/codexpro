#!/bin/bash
# Run on the Docker host via the Mac's existing SSH alias. No new SSH key needed.
# --apply recreates ONLY the existing Paseo service and interrupts its sessions.
set -euo pipefail
umask 077
revision=${1:-}
action=${2:---prepare}
container=${3:-paseo-beta}
source_repo=/tmp/codexpro-main-sync-20261022-zpryx6/repo
lan_ip=192.168.11.241
[[ "$revision" =~ ^[a-f0-9]{40}$ ]] || { echo 'First argument must be the reviewed full source commit SHA.' >&2; exit 2; }
[[ "$action" = --prepare || "$action" = --apply ]] || { echo 'Use --prepare or --apply.' >&2; exit 2; }
[[ "$container" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || exit 2
command -v docker >/dev/null
command -v ip >/dev/null
command -v ss >/dev/null
command -v python3 >/dev/null
[[ "$(docker inspect --format '{{.State.Running}}' "$container")" = true ]] || { echo 'Paseo is not running; preserved unchanged.' >&2; exit 1; }
label() { docker inspect --format "{{index .Config.Labels \"$1\"}}" "$container"; }
project=$(label com.docker.compose.project)
service=$(label com.docker.compose.service)
workdir=$(label com.docker.compose.project.working_dir)
config_files=$(label com.docker.compose.project.config_files)
[[ "$project" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ && "$service" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || { echo 'Missing valid live Compose labels.' >&2; exit 1; }
[[ "$workdir" = /* && -d "$workdir" && -n "$config_files" && "$config_files" != '<no value>' ]] || { echo 'Live Compose paths unavailable.' >&2; exit 1; }
base_image=$(docker inspect --format '{{.Image}}' "$container")
base_user=$(docker image inspect --format '{{.Config.User}}' "$base_image")
base_user=${base_user:-root}
base_workdir=$(docker image inspect --format '{{.Config.WorkingDir}}' "$base_image")
base_workdir=${base_workdir:-/}
[[ "$base_image" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 1
[[ "$(docker exec -u paseo "$container" paseo --version)" = 0.12.0 ]] || { echo 'This reviewed installer requires the existing Paseo0.12.0 image.' >&2; exit 1; }
docker exec -u paseo "$container" test -x /usr/local/bin/paseo-docker-entrypoint
docker exec -u paseo "$container" git -C "$source_repo" cat-file -e "$revision^{commit}"
[[ "$(docker exec -u paseo "$container" git -C "$source_repo" rev-parse "$revision^{commit}")" = "$revision" ]] || exit 1
ip -4 -o address show | awk -v ip="$lan_ip" '{split($4,a,"/"); if(a[1]==ip) found=1} END {exit !found}' || { echo 'Reviewed LAN address is not assigned to this host.' >&2; exit 1; }
# Existing loopback-only sidecar6081 may remain; a LAN/wildcard listener conflicts.
if ss -H -ltn | awk -v endpoint="$lan_ip:6081" '$4==endpoint || $4=="0.0.0.0:6081" || $4=="*:6081" || $4=="[::]:6081" {found=1} END {exit !found}'; then
  echo 'LAN6081 is occupied; existing listeners preserved.' >&2; exit 1
fi
available_kb=$(df -Pk "$workdir" | awk 'END {print $4}')
(( available_kb >= 10 * 1024 * 1024 )) || { echo 'At least10GiB free disk is required before the build.' >&2; exit 1; }
# Never replace an unknown custom security policy with the browser policy.
security=$(docker inspect --format '{{json .HostConfig.SecurityOpt}}' "$container")
[[ "$security" = null || "$security" = '[]' ]] || { echo 'Existing custom container security policy needs review; preserved.' >&2; exit 1; }

stage=$(mktemp -d "$workdir/codexpro-paseo-${revision:0:8}.XXXXXX")
echo "Preserved build/recovery directory: $stage"
docker exec -u paseo "$container" git -C "$source_repo" archive --format=tar "$revision" \
  docs/mydocs/z.ai/download/bridge-reference deploy/bridge | tar -xf - -C "$stage"
image="paseo-codexpro:$revision"
base_tag="paseo-codexpro-base:${base_image#sha256:}"
docker image tag "$base_image" "$base_tag"
[[ "$(docker image inspect --format '{{.Id}}' "$base_tag")" = "$base_image" ]] || exit 1
policy="$stage/deploy/bridge/seccomp_profile.json"
override="$stage/paseo-codexpro.override.json"
rollback_override="$stage/paseo-rollback.override.json"
IFS=, read -r -a files <<< "$config_files"
compose=(docker compose --project-name "$project" --project-directory "$workdir")
for file in "${files[@]}"; do
  [[ -f "$file" ]] || { echo 'A live Compose source file is missing.' >&2; exit 1; }
  compose+=(-f "$file")
done
validator="$stage/deploy/bridge/scripts/validate-paseo-compose.py"
initial_digest=$(python3 "$validator" "$container" "$base_image" "${compose[@]}")
# Only known scoped values are written. Existing environment/mounts/command stay in original files.
python3 - "$override" "$rollback_override" "$service" "$image" "$policy" "$base_image" <<'PY'
import json,sys
out,rollback,service,image,policy,base=sys.argv[1:]
patch={"image":image,"entrypoint":["/usr/local/bin/codexpro-paseo-entrypoint"],
       "ports":[{"target":6081,"published":"6081","host_ip":"192.168.11.241","protocol":"tcp"}],
       "shm_size":"256m","stop_grace_period":"60s","security_opt":["seccomp="+policy]}
with open(out,"w") as f: json.dump({"services":{service:patch}},f,indent=2)
with open(rollback,"w") as f: json.dump({"services":{service:{"image":base}}},f,indent=2)
print("Scoped Compose override:")
print(json.dumps({"services":{service:patch}},indent=2))
PY
# Preserve an exact command, not expanded Compose environment/credential values.
rollback="$stage/rollback.sh"
{ printf '#!/bin/bash\nset -euo pipefail\n'; printf '%q ' "${compose[@]}" -f "$rollback_override" up -d --no-deps --no-build --pull never "$service"; printf '\n'; } > "$rollback"
chmod 700 "$rollback"
"${compose[@]}" -f "$override" config --quiet

docker build --pull=false --build-arg "PASEO_BASE_IMAGE=$base_tag" \
  --build-arg "PASEO_BASE_USER=$base_user" --build-arg "PASEO_BASE_WORKDIR=$base_workdir" \
  --label "org.codexpro.source=$revision" --label "org.codexpro.base=$base_image" \
  -f "$stage/deploy/bridge/Dockerfile.paseo" -t "$image" "$stage"
image_id=$(docker image inspect --format '{{.Id}}' "$image")
[[ "$(docker image inspect --format '{{.Id}}' "$base_tag")" = "$base_image" ]] || { echo "Pinned base tag changed during build." >&2; exit 1; }
printf 'Exact source: %s\nBase image: %s\nBuilt image: %s\nRollback: %s\n' "$revision" "$base_image" "$image_id" "$rollback"
# Run only isolated image checks, without mounting profiles/home or starting the daemon.
docker run --rm --network none --entrypoint bash "$image" -n /usr/local/bin/codexpro-paseo-entrypoint
docker run --rm --network none --entrypoint python3 "$image" -c 'import ast; ast.parse(open("/opt/codexpro/supervise.py").read())'
docker run --rm --network none --entrypoint google-chrome-stable "$image" --version
if [[ "$action" != --apply ]]; then
  echo 'Prepared only. No existing service restarted.'
  echo "To apply, rerun this installer with the same full source SHA and --apply; it repeats preservation/drift gates."
  echo 'After applying, install the provider with the command in INSTALL-IN-PASEO.md.'
  exit 0
fi
# Ensure another actor did not update the running source container during this build.
[[ "$(docker inspect --format '{{.Image}}' "$container")" = "$base_image" ]] || { echo 'Running image changed during preparation; no restart performed.' >&2; exit 1; }
CODEXPRO_EXPECTED_CONFIG_HASH="$initial_digest" python3 "$validator" "$container" "$base_image" "${compose[@]}" >/dev/null
[[ "$(docker image inspect --format '{{.Id}}' "$image")" = "$image_id" ]] || { echo "Candidate image tag changed; no restart performed." >&2; exit 1; }
echo 'APPLY: recreating only Paseo now; active sessions will be interrupted. Data mounts are retained.'
"${compose[@]}" -f "$override" up -d --no-deps --no-build --pull never "$service"
ready=false
for attempt in {1..60}; do
  if docker exec -u paseo "$container" curl -fsS --max-time 1 -o /dev/null http://127.0.0.1:9223/json/version && \
     docker exec -u paseo "$container" curl -fsS --max-time 1 -o /dev/null http://127.0.0.1:6081/vnc.html && \
     docker exec -u paseo "$container" paseo daemon status --json >/dev/null; then
    ready=true; break
  fi
  sleep 2
done
if [[ "$ready" != true ]]; then
  printf 'Readiness incomplete. No automatic rollback or data deletion. Run if needed: %s\n' "$rollback" >&2
  exit 1
fi
[[ "$(docker inspect --format '{{.Image}}' "$container")" = "$image_id" ]] || { echo 'Unexpected applied image identity.' >&2; exit 1; }
docker exec -u paseo "$container" paseo plugin install /opt/codexpro/provider --id codexpro-browser --json
docker exec -u paseo "$container" paseo plugin ls --json
printf '\nInstalled in Paseo. Open: http://%s:6081/vnc.html?autoconnect=1\n' "$lan_ip"
printf 'Manual ChatGPT login is next; no test prompts were sent.\nRollback retains all data: %s\n' "$rollback"
