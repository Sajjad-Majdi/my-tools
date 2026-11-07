#!/usr/bin/env bash
# Back up all my tools to the private GitHub repo in one step.
# browser-bridge lives in ~/.claude/browser-bridge (Chrome loads the extension from there), so its sources are copied in first.
set -euo pipefail
cd "$(dirname "$0")"
BB="$HOME/.claude/browser-bridge"
mkdir -p browser-bridge/extension browser-bridge/src
cp "$BB/bb.py" "$BB/drive.py" browser-bridge/
cp "$BB/src/main.rs" browser-bridge/src/
cp "$BB/extension/bg.js" "$BB/extension/manifest.json" "$BB/extension/config.example.js" browser-bridge/extension/
git add -A
if git diff --cached --quiet; then echo "nothing to back up"; exit 0; fi
git commit -q -m "Backup $(date +%F)"
git push -q origin main
echo "backed up: $(git log -1 --format=%h)"
