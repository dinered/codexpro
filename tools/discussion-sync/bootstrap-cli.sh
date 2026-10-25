#!/bin/sh
set -eu

# Pinned official CLI releases. Digests are copied from the immutable upstream
# release checksum assets; downloads and binaries stay inside the CI workspace.
GH_VERSION=2.103.2
GLAB_VERSION=1.103.0

verify_sha256() {
  file=$1
  expected=$2
  label=$3
  actual=$(sha256sum "$file" | awk '{print $1}')
  if [ "$actual" != "$expected" ]; then
    printf 'discussion-sync CLI bootstrap: checksum mismatch for %s\n' "$label" >&2
    return 1
  fi
}

select_arch() {
  case "$1" in
    x86_64|amd64) printf amd64 ;;
    aarch64|arm64) printf arm64 ;;
    *) printf 'discussion-sync CLI bootstrap: unsupported Linux architecture %s\n' "$1" >&2; return 1 ;;
  esac
}

if [ "${1:-}" = --self-test ]; then
  verify_sha256 /dev/null e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 empty-file
  if verify_sha256 /dev/null 0000000000000000000000000000000000000000000000000000000000000000 mismatch-fixture 2>/dev/null; then
    printf 'discussion-sync CLI bootstrap: mismatch self-test unexpectedly passed\n' >&2
    exit 1
  fi
  [ "$(select_arch x86_64)" = amd64 ]
  [ "$(select_arch aarch64)" = arm64 ]
  if select_arch unsupported >/dev/null 2>&1; then
    printf 'discussion-sync CLI bootstrap: unsupported architecture self-test unexpectedly passed\n' >&2
    exit 1
  fi
  printf 'discussion-sync CLI bootstrap self-test passed\n'
  exit 0
fi

if [ "${1:-}" != --run ] || [ "$#" -lt 2 ]; then
  printf 'usage: %s --run COMMAND [ARG ...]\n       %s --self-test\n' "$0" "$0" >&2
  exit 2
fi
shift

command -v perl >/dev/null 2>&1 || { printf 'discussion-sync CLI bootstrap: required runtime perl missing\n' >&2; exit 1; }
for tool in curl sha256sum awk tar; do
  command -v "$tool" >/dev/null 2>&1 || { printf 'discussion-sync CLI bootstrap: required bootstrap utility %s missing\n' "$tool" >&2; exit 1; }
done

repo_dir=${CI_PROJECT_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)}
bin_dir=${DISCUSSION_SYNC_BIN_DIR:-$repo_dir/.ci-tools/bin}
mkdir -p "$bin_dir"
arch=$(select_arch "$(uname -m)")

install_pinned() {
  name=$1
  version=$2
  url=$3
  expected=$4
  archive=$5
  member=$6
  destination=$7
  strip_components=$8
  download="$bin_dir/$archive"
  partial="$download.part"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --retry 2 --connect-timeout 15 --max-time 180 "$url" --output "$partial"
  verify_sha256 "$partial" "$expected" "$name $version $archive"
  mv "$partial" "$download"
  tar --extract --gzip --file "$download" --directory "$bin_dir" \
    "--strip-components=$strip_components" --no-same-owner --no-same-permissions "$member"
  [ -x "$bin_dir/$destination" ] || { printf 'discussion-sync CLI bootstrap: extracted %s is not executable\n' "$name" >&2; return 1; }
}

case "$arch" in
  amd64)
    gh_sha=62ccf747115ddc61237efffdde66a3c8f70ba249433dc64f70801089b59c59c8
    glab_sha=6264d0de9e3b8f8bcafd368dfeaa19948ae680372a206b0b21038b1daabfaf58
    ;;
  arm64)
    gh_sha=4c3e99a50bd8b181a3fe9d69b25dd978bac768148d88f01507c6b4d1ef61a443
    glab_sha=100811e68f405531254f35b074d42afee3c9e4350855a9a528207170066a65cb
    ;;
esac

install_pinned gh "$GH_VERSION" \
  "https://github.com/cli/cli/releases/download/v$GH_VERSION/gh_${GH_VERSION}_linux_${arch}.tar.gz" \
  "$gh_sha" "gh_${GH_VERSION}_linux_${arch}.tar.gz" \
  "gh_${GH_VERSION}_linux_${arch}/bin/gh" gh 2
install_pinned glab "$GLAB_VERSION" \
  "https://gitlab.com/gitlab-org/cli/-/releases/v$GLAB_VERSION/downloads/glab_${GLAB_VERSION}_linux_${arch}.tar.gz" \
  "$glab_sha" "glab_${GLAB_VERSION}_linux_${arch}.tar.gz" \
  "bin/glab" glab 1

PATH="$bin_dir:$PATH"
export PATH
exec "$@"
