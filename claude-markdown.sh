#!/usr/bin/env bash
# Launch the claude-markdown Electron app from any directory.
# The app opens with the calling shell's working directory as its default cwd.
#
# Usage:
#   ./claude-markdown.sh            # open with current directory
#   cd ~/projects/foo && claude-markdown.sh   # open with ~/projects/foo
#
# Add this file (or a symlink) to your PATH for system-wide access.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON="$SCRIPT_DIR/node_modules/.bin/electron"
MAIN="$SCRIPT_DIR/out/main/index.js"

if [[ ! -f "$MAIN" ]]; then
  echo "error: app not built — run 'pnpm build' in $SCRIPT_DIR first." >&2
  exit 1
fi

# exec replaces this shell process with electron, inheriting $PWD and $TERM
# so the app detects the correct working directory and terminal context.
exec "$ELECTRON" "$MAIN" "$@"
