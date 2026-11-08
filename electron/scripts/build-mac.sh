#!/usr/bin/env bash
# Release build of the macOS app: Developer ID signed + notarized (npm run build:mac).
#
# Signing uses a keychain of its own, not the login keychain, so codesign never stops on a
# password prompt. One-time setup on the build machine (done 2026-11-09):
#   ~/Library/Keychains/fractal-signing.keychain-db  holds "Developer ID Application: kensuke imaizumi (TBCWF5T26D)"
#                                                     and the notarytool profile "fractal-notary"
#   ~/.fractal-signing/keychain-password              its password (chmod 600)
# Override with FRACTAL_SIGNING_KEYCHAIN / FRACTAL_SIGNING_KEYCHAIN_PASSWORD_FILE / APPLE_KEYCHAIN_PROFILE.
set -euo pipefail
cd "$(dirname "$0")/.."

KEYCHAIN="${FRACTAL_SIGNING_KEYCHAIN:-$HOME/Library/Keychains/fractal-signing.keychain-db}"
PASSWORD_FILE="${FRACTAL_SIGNING_KEYCHAIN_PASSWORD_FILE:-$HOME/.fractal-signing/keychain-password}"
PROFILE="${APPLE_KEYCHAIN_PROFILE:-fractal-notary}"

[ -f "$KEYCHAIN" ] || { echo "signing keychain not found: $KEYCHAIN" >&2; exit 1; }
[ -f "$PASSWORD_FILE" ] || { echo "keychain password file not found: $PASSWORD_FILE" >&2; exit 1; }
security unlock-keychain -p "$(cat "$PASSWORD_FILE")" "$KEYCHAIN"

# Without a notary profile electron-builder only warns and ships an un-notarized app — refuse instead.
xcrun notarytool history --keychain "$KEYCHAIN" --keychain-profile "$PROFILE" >/dev/null \
    || { echo "notarytool profile '$PROFILE' not usable in $KEYCHAIN (run notarytool store-credentials)" >&2; exit 1; }

npm run compile
ELECTRON_RUN_AS_NODE= CSC_KEYCHAIN="$KEYCHAIN" APPLE_KEYCHAIN="$KEYCHAIN" APPLE_KEYCHAIN_PROFILE="$PROFILE" \
    npx electron-builder --mac --config electron-builder.config.js "$@"
