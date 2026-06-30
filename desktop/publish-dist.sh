#!/usr/bin/env bash
# Publish built installers + electron-updater feed files to the public
# Dialog-dist repo as a GitHub Release. This is what makes the download page
# links work and lets installed apps auto-update.
#
# Prereqs: `gh auth login` (account with push access to Dialog-dist).
# Usage:
#   cd desktop && npm run dist        # build (also grab CI mac/android into dist/)
#   ./publish-dist.sh                 # publishes a release tagged from package.json
#
# The tag is v<version-from-package.json>, which must match VERSION in
# public/js/downloads-data.js so the download links resolve.

set -euo pipefail

REPO="${DIST_REPO:-VanylixCODER/Dialog-dist}"
DIST="$(cd "$(dirname "$0")" && pwd)/dist"
VERSION="$(node -p "require('$(cd "$(dirname "$0")" && pwd)/package.json').version")"
TAG="v${VERSION}"

if [ ! -d "$DIST" ]; then
  echo "No dist/ — run 'npm run dist' first." >&2
  exit 1
fi

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
  echo "Nothing to publish in $DIST" >&2
  exit 1
fi

echo "Publishing ${#FILES[@]} file(s) to $REPO @ $TAG:"
printf '  %s\n' "${FILES[@]##*/}"

# Create the release if it doesn't exist yet, then upload (clobber to re-publish).
if ! gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  gh release create "$TAG" --repo "$REPO" --title "Dialog ${VERSION}" \
    --notes "Dialog ${VERSION} — desktop & Android installers."
fi
gh release upload "$TAG" --repo "$REPO" --clobber "${FILES[@]}"

echo "Done → https://github.com/${REPO}/releases/tag/${TAG}"
