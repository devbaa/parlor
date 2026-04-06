#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_TRIPLE="${TAURI_TARGET_TRIPLE:-$(cd "$REPO_ROOT/desktop/src-tauri" && cargo -vV | sed -n 's/^host: //p')}"

if [[ -z "$TARGET_TRIPLE" ]]; then
  echo "Unable to resolve target triple." >&2
  exit 1
fi

BIN_NAME="parlor-backend-${TARGET_TRIPLE}"
if [[ "$TARGET_TRIPLE" == *"windows"* || "$TARGET_TRIPLE" == *"msvc"* ]]; then
  BIN_NAME="${BIN_NAME}.exe"
fi

cd "$REPO_ROOT/src"

uv run --with pyinstaller pyinstaller \
  --noconfirm \
  --onefile \
  --name "$BIN_NAME" \
  --distpath "$REPO_ROOT/src/bin" \
  --workpath "$REPO_ROOT/.build/pyinstaller/work" \
  --specpath "$REPO_ROOT/.build/pyinstaller/spec" \
  server.py

echo "Built sidecar: $REPO_ROOT/src/bin/$BIN_NAME"
