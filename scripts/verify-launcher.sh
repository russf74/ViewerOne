#!/usr/bin/env bash
# CI check: launcher files exist and app builds at v6+
set -euo pipefail
cd "$(dirname "$0")/.."

test -f ViewerOne-Launch.vbs
test -f ViewerOne-Launch-Silent.cmd
test -f scripts/launch-viewerone.ps1

ver=$(node -p "require('./package.json').version")
major=$(node -p "require('./package.json').version.split('.')[0]")
if [ "$major" -lt 6 ]; then echo "FAIL: expected v6+, got $ver"; exit 1; fi

npm run build >/dev/null
test -f out/main/index.js

echo "launcher-verify: OK (v$ver)"
