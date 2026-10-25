#!/bin/sh
# Isolated source-copy validation; never touches Mac WIP or runs live browsers.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo=$(CDPATH= cd -- "$here/../.." && pwd)
app=$(mktemp -d /tmp/codexpro-reference-check-XXXXXX)
cp -R "$repo/docs/mydocs/z.ai/download/bridge-reference/." "$app/"
git -C "$app" apply --unidiff-zero "$here/read-page.patch"
git -C "$app" apply --unidiff-zero "$here/idle-control.patch"
git -C "$app" apply --unidiff-zero "$here/shutdown.patch"
git -C "$app" apply --unidiff-zero "$here/router-step.patch"
git -C "$app" apply --unidiff-zero "$here/send-label.patch"
cp -R "$here/runtime" "$app/deployment"
cd "$app"
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run typecheck
node -e 'const fs=require("node:fs");const c=JSON.parse(fs.readFileSync("tsconfig.json","utf8"));c.include.push("deployment/**/*.ts");fs.writeFileSync("tsconfig.deploy.json",JSON.stringify(c));'
npm exec tsc -- --project tsconfig.deploy.json
BRIDGE_APP="$app" node --test "$here/serialization.test.mjs" "$here/tab-bindings.test.mjs" "$here/provider-engine.test.mjs"
printf 'Validation copy retained: %s\n' "$app"
