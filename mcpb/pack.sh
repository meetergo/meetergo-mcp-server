#!/usr/bin/env bash
# Pack the Claude Desktop extension (.mcpb) from the built server.
#
# A .mcpb is a zip of manifest + entry + production node_modules that Claude
# Desktop installs with one click — the token is asked for in the install UI
# (user_config, stored as sensitive), so nobody edits JSON by hand.
#
# Run from the repo root via: pnpm nx run mcp-server:bundle-extension
set -euo pipefail

PKG_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$(mktemp -d)"
OUT="${1:-$PKG_DIR/dist-extension/meetergo.mcpb}"

test -f "$PKG_DIR/dist/index.js" || {
  echo "dist/index.js missing — run: pnpm nx build mcp-server" >&2
  exit 1
}

mkdir -p "$(dirname "$OUT")"
cp "$PKG_DIR/mcpb/manifest.json" "$PKG_DIR/mcpb/icon.png" "$STAGE/"
cp -r "$PKG_DIR/dist" "$STAGE/dist"
cp "$PKG_DIR/package.json" "$PKG_DIR/package-lock.json" "$STAGE/"
# Production deps only, pinned by the lockfile — the bundle must run on a
# machine that has never heard of this repo, with exactly the tree we tested.
(cd "$STAGE" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null)
npx -y @anthropic-ai/mcpb pack "$STAGE" "$OUT"
rm -rf "$STAGE"
echo "packed: $OUT"
