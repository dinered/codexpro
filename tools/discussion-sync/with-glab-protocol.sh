#!/bin/sh
set -eu

if [ "$#" -lt 3 ]; then
  printf 'usage: %s HOST http|https COMMAND [ARG ...]\n' "$0" >&2
  exit 2
fi
host=$1
protocol=$2
shift 2
case "$host" in ''|*[!A-Za-z0-9.-]*) printf 'invalid GitLab API hostname\n' >&2; exit 2 ;; esac
case "$protocol" in http|https) ;; *) printf 'invalid GitLab API protocol\n' >&2; exit 2 ;; esac

config_dir=$(mktemp -d)
chmod 0700 "$config_dir"
config_file="$config_dir/config.yml"
cleanup() {
  rm -f "$config_file"
  rmdir "$config_dir"
}
trap cleanup EXIT HUP INT TERM
umask 077
printf 'check_update: false\nhosts:\n  %s:\n    api_protocol: %s\n' "$host" "$protocol" > "$config_file"
export GLAB_CONFIG_DIR="$config_dir"
export GLAB_SEND_TELEMETRY=false

set +e
"$@"
status=$?
exit "$status"
