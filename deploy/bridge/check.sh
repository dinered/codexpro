#!/bin/sh
# Isolated source-copy validation; never touches Mac WIP or runs live browsers.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo=$(CDPATH= cd -- "$here/../.." && pwd)
app=$(mktemp -d /tmp/codexpro-reference-check-XXXXXX)
cp -R "$repo/docs/mydocs/z.ai/download/bridge-reference/." "$app/"
git -C "$app" apply --unidiff-zero "$here/read-page.patch"
git -C "$app" apply --unidiff-zero "$here/shutdown.patch"
git -C "$app" apply --unidiff-zero "$here/h1-fixture.patch"
cd "$app"
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run typecheck
BRIDGE_APP="$app" node --test "$here/serialization.test.mjs"
printf 'Validation copy retained: %s\n' "$app"
