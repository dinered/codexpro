#!/bin/sh
set -eu
exec node --test "$(dirname "$0")/sync.test.mjs"
