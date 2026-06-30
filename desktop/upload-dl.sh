#!/usr/bin/env bash
# Upload built installers + electron-updater feed files to the server's /dl,
# which is bind-mounted into the app container and served at
# https://dialogmsg.xyz/dl/ (so downloads + auto-update work).
#
# Usage:
#   ./upload-dl.sh /path/to/ssh-key            # uses defaults below
#   SSH_KEY=~/key SERVER=ubuntu@1.2.3.4 ./upload-dl.sh
#
# Run it after `npm run dist` (and after dropping any CI-built mac/android
# artifacts into desktop/dist/).

set -euo pipefail

SSH_KEY="${1:-${SSH_KEY:-$HOME/Desktop/ssh-key-2026-06-29.key}}"
SERVER="${SERVER:-ubuntu@89.168.31.113}"
REMOTE_DIR="${REMOTE_DIR:-/home/ubuntu/dl}"
DIST="$(cd "$(dirname "$0")" && pwd)/dist"

if [ ! -d "$DIST" ]; then
  echo "No dist/ folder — run 'npm run dist' first." >&2
  exit 1
fi

# Installers + update feeds. Missing patterns are skipped silently.
shopt -s nullglob
FILES=(
  "$DIST"/*.AppImage
  "$DIST"/*.deb
  "$DIST"/*.pacman
  "$DIST"/*.exe
  "$DIST"/*.dmg
  "$DIST"/*-mac.zip
  "$DIST"/*.apk
  "$DIST"/latest*.yml
)

if [ ${#FILES[@]} -eq 0 ]; then
  echo "Nothing to upload in $DIST" >&2
  exit 1
fi

echo "Uploading ${#FILES[@]} file(s) to $SERVER:$REMOTE_DIR"
printf '  %s\n' "${FILES[@]##*/}"
scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "${FILES[@]}" "$SERVER:$REMOTE_DIR/"
echo "Done. Live at https://dialogmsg.xyz/dl/"
