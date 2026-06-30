#!/usr/bin/env bash
# Generate a SELF-SIGNED Windows code-signing certificate (.pfx) for Dialog.
#
# This lets builds be signed so the pipeline works end-to-end, but a self-signed
# cert is NOT trusted by Windows SmartScreen — users will still see the
# "Unknown publisher" warning. For real trust, replace this .pfx with a
# CA-issued Authenticode certificate (the CN must stay "Dialog Messanger App"
# to match win.publisherName).
#
# Usage:  ./scripts/gen-win-cert.sh [output.pfx] [password]
set -euo pipefail

OUT="${1:-$(cd "$(dirname "$0")/.." && pwd)/dialog-selfsign.pfx}"
PASS="${2:-dialog}"
CN="Dialog Messanger App"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" \
  -subj "/CN=${CN}/O=${CN}" \
  -addext "extendedKeyUsage=codeSigning" \
  -addext "basicConstraints=critical,CA:FALSE" 2>/dev/null

openssl pkcs12 -export -out "$OUT" \
  -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
  -name "$CN" -passout "pass:${PASS}"

echo "Wrote $OUT (password: ${PASS})"
echo "Build signed with:"
echo "  CSC_LINK=\"$OUT\" CSC_KEY_PASSWORD=\"$PASS\" npm run dist:win"
