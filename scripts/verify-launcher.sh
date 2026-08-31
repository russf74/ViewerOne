#!/usr/bin/env bash
# CI check: launcher files exist, VBScript Run() is parenthesized, app builds at v6+
set -euo pipefail
cd "$(dirname "$0")/.."

test -f ViewerOne-Launch.vbs
test -f ViewerOne-Launch-Silent.cmd
test -f ViewerOne-Launch.cmd
test -f ViewerOne-Fix.cmd
test -f scripts/launch-viewerone.ps1
test -f scripts/fix-viewerone.ps1
test -f scripts/repair-shortcuts.ps1

# Capturing WScript.Shell.Run's return value requires parentheses.
# "code = sh.Run cmd, 0, True" compiles as "Expected end of statement".
if grep -nE '=\s*[A-Za-z][A-Za-z0-9_]*\.Run[[:space:]]+[^(]' ViewerOne-Launch.vbs scripts/*.vbs; then
  echo "FAIL: VBScript assignment to .Run must use parentheses: x = sh.Run(cmd, 0, True)"
  exit 1
fi

# PowerShell/batch launchers must stay ASCII so Windows-1252 does not turn
# dashes into parse errors (that was the fix-viewerone.ps1 "unexpected token" bug).
python3 - <<'PY'
from pathlib import Path
files = [
  'ViewerOne-Launch.vbs',
  'ViewerOne-Launch-Silent.cmd',
  'ViewerOne-Launch.cmd',
  'ViewerOne-Fix.cmd',
  'scripts/launch-viewerone.ps1',
  'scripts/fix-viewerone.ps1',
  'scripts/repair-shortcuts.ps1',
]
bad = False
for rel in files:
    raw = Path(rel).read_bytes()
    for i, b in enumerate(raw):
        if b in (9, 10, 13) or 32 <= b <= 126:
            continue
        print(f'FAIL: non-ASCII byte {b} in {rel} offset {i}')
        bad = True
        break
if bad:
    raise SystemExit(1)
PY

ver=$(node -p "require('./package.json').version")
major=$(node -p "require('./package.json').version.split('.')[0]")
if [ "$major" -lt 6 ]; then echo "FAIL: expected v6+, got $ver"; exit 1; fi

npm run build >/dev/null
test -f out/main/index.js

echo "launcher-verify: OK (v$ver)"
