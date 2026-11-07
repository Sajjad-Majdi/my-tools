#!/usr/bin/env bash
# Publish one zip per tool as a GitHub release, so an agent can set up a single tool without cloning the repo.
# Each tool has a fixed release tag (its folder name); re-running replaces the zip, so the download link never changes:
#   https://github.com/<owner>/<repo>/releases/download/<tool>/<tool>.zip
# Usage: bash release.sh            (all tools)
#        bash release.sh flow-mcp   (one tool)
set -euo pipefail
cd "$(dirname "$0")"
TOOLS="browser-bridge fastdesk tg-mcp claude-mods persian-guard idmdl flow-mcp gemini-web aparat"
[ $# -gt 0 ] && TOOLS="$*"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
for t in $TOOLS; do
  [ -d "$t" ] || { echo "no such tool: $t"; exit 1; }
  git archive --format=zip -o "$tmp/$t.zip" HEAD "$t"     # committed files only: no local config, cookies or logs
  if gh release view "$t" >/dev/null 2>&1; then
    gh release upload "$t" "$tmp/$t.zip" --clobber >/dev/null
    gh release edit "$t" --notes-file "$t/README.md" >/dev/null
  else
    gh release create "$t" "$tmp/$t.zip" --title "$t" --notes-file "$t/README.md" >/dev/null
  fi
  echo "released $t"
done
