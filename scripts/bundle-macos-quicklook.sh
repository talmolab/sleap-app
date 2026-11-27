#!/usr/bin/env bash
# Build, embed, and inside-out sign the macOS Quick Look Preview and Thumbnail
# app extensions inside SLEAP.app.
#
# Usage:
#   bash scripts/bundle-macos-quicklook.sh --app <path/to/SLEAP.app> [options]
#
# Options:
#   --app <path>          Path to the built SLEAP.app bundle (required).
#   --universal           Build universal arm64 + x86_64 extension binaries
#                         (default: host architecture only).
#   --dmg <path>          Rebuild this .dmg around the updated SLEAP.app.
#   --updater-tgz <path>  Rebuild this SLEAP.app.tar.gz updater tarball (and
#                         re-sign <path>.sig when TAURI_SIGNING_PRIVATE_KEY is set).
#   --notarize            Notarize and staple SLEAP.app via xcrun notarytool
#                         before rebuilding --dmg / --updater-tgz. Uses
#                         SLEAP_NOTARY_APPLE_ID / _PASSWORD / _TEAM_ID (falling
#                         back to APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID).
#
# Signing:
#   Uses APPLE_SIGNING_IDENTITY if set and non-empty (Developer ID with hardened
#   runtime + secure timestamp), otherwise ad-hoc ("-"). When APPLE_CERTIFICATE
#   (base64 .p12) is set and the identity is not already present in the keychain,
#   imports it into a temporary keychain cleaned up on exit.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
QL_ROOT="$ROOT/src-tauri/macos/quicklook"
RUST_DIR="$QL_ROOT/slp-ql-core"
PREVIEW_SRC="$QL_ROOT/SLEAPQuickLook"
THUMB_SRC="$QL_ROOT/SLEAPQuickLookThumbnail"
ENTITLEMENTS="$PREVIEW_SRC/SLEAPQuickLook.entitlements"
HEADER="$RUST_DIR/include/slp_ql_core.h"

APP_BUNDLE=""
UNIVERSAL=0
DMG_PATH=""
UPDATER_TGZ=""
DO_NOTARIZE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP_BUNDLE="$2"; shift 2 ;;
    --universal) UNIVERSAL=1; shift ;;
    --dmg) DMG_PATH="$2"; shift 2 ;;
    --updater-tgz) UPDATER_TGZ="$2"; shift 2 ;;
    --notarize) DO_NOTARIZE=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

[ -n "$APP_BUNDLE" ] || { echo "bundle-macos-quicklook: --app is required" >&2; exit 1; }
[ -d "$APP_BUNDLE" ] || { echo "bundle-macos-quicklook: $APP_BUNDLE does not exist" >&2; exit 1; }
[ "$(uname -s)" = "Darwin" ] || { echo "bundle-macos-quicklook: macOS only" >&2; exit 1; }

SDK="$(xcrun --show-sdk-path)"
MIN_MACOS="13.0"

# Derive bundle versions from src-tauri/tauri.conf.json so the extensions match
# the host app's CFBundleShortVersionString and Apple's numeric CFBundleVersion.
RAW_VERSION="$(python3 -c "import json; print(json.load(open('$ROOT/src-tauri/tauri.conf.json'))['version'])")"
SHORT_VERSION="${RAW_VERSION%%+*}"
BUNDLE_VERSION="$(python3 -c "
import re, sys
v = sys.argv[1]
base = v.split('+', 1)[0].split('-', 1)[0]
meta = v.split('+', 1)[1] if '+' in v else ''
nums = [p for p in base.split('.') if p.isdigit()]
if meta:
    first = meta.split('.')[0]
    if first.isdigit():
        nums.append(first)
print('.'.join(nums[:4]) if nums else '1')
" "$RAW_VERSION")"

SIGN_IDENTITY="${APPLE_SIGNING_IDENTITY:--}"
if [ -z "$SIGN_IDENTITY" ]; then
  SIGN_IDENTITY="-"
fi
SIGN_OPTS=()
if [ "$SIGN_IDENTITY" != "-" ]; then
  SIGN_OPTS=(--options runtime --timestamp)
fi

WORK_DIR="$(mktemp -d)"
TEMP_KEYCHAIN=""
ORIG_KEYCHAINS=()

cleanup() {
  if [ -n "$TEMP_KEYCHAIN" ]; then
    security delete-keychain "$TEMP_KEYCHAIN" >/dev/null 2>&1 || true
    if [ ${#ORIG_KEYCHAINS[@]} -gt 0 ]; then
      security list-keychains -d user -s "${ORIG_KEYCHAINS[@]}" >/dev/null 2>&1 || true
    fi
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

# If running in CI with APPLE_CERTIFICATE (base64 .p12) and the identity is not
# already in the keychain (tauri-action deletes its temporary keychain on exit),
# import it into a temporary keychain for our inside-out signing pass.
if [ "$SIGN_IDENTITY" != "-" ] && [ -n "${APPLE_CERTIFICATE:-}" ]; then
  if ! security find-identity -v -p codesigning | grep -Fq "$SIGN_IDENTITY"; then
    echo "==> Importing APPLE_CERTIFICATE into temporary keychain..."
    TEMP_KEYCHAIN="$WORK_DIR/sleap-ql-signing.keychain-db"
    KEYCHAIN_PW="$(openssl rand -hex 24)"
    CERT_P12="$WORK_DIR/cert.p12"
    printf '%s' "$APPLE_CERTIFICATE" | base64 --decode > "$CERT_P12"

    while IFS= read -r kc; do
      kc="$(printf '%s' "$kc" | sed -E 's/^[[:space:]]*"?([^"]+)"?[[:space:]]*$/\1/')"
      [ -n "$kc" ] && ORIG_KEYCHAINS+=("$kc")
    done < <(security list-keychains -d user)

    security create-keychain -p "$KEYCHAIN_PW" "$TEMP_KEYCHAIN"
    security set-keychain-settings -lut 21600 "$TEMP_KEYCHAIN"
    security unlock-keychain -p "$KEYCHAIN_PW" "$TEMP_KEYCHAIN"
    security import "$CERT_P12" -P "${APPLE_CERTIFICATE_PASSWORD:-}" -A -t cert -f pkcs12 -k "$TEMP_KEYCHAIN"
    security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PW" "$TEMP_KEYCHAIN" >/dev/null
    security list-keychains -d user -s "$TEMP_KEYCHAIN" ${ORIG_KEYCHAINS[@]+"${ORIG_KEYCHAINS[@]}"}
  fi
fi

compile_swift_for_arch() {
  local arch="$1"
  local rust_target="$2"
  local static_lib="$3"
  local out_preview="$4"
  local out_thumb="$5"
  local swift_target="${arch}-apple-macos${MIN_MACOS}"

  echo "==> Building Rust slp-ql-core ($rust_target)..."
  (cd "$RUST_DIR" && cargo build --release --target "$rust_target")

  echo "==> Compiling SLEAPQuickLook.appex ($swift_target)..."
  swiftc \
    -O \
    -parse-as-library \
    -module-name SLEAPQuickLook \
    -target "$swift_target" \
    -sdk "$SDK" \
    -import-objc-header "$HEADER" \
    "$PREVIEW_SRC/SLPBridge.swift" \
    "$PREVIEW_SRC/SLPPreviewView.swift" \
    "$PREVIEW_SRC/PreviewViewController.swift" \
    "$static_lib" \
    -Xlinker -e -Xlinker _NSExtensionMain \
    -Xlinker -dead_strip \
    -framework Cocoa \
    -framework SwiftUI \
    -framework QuickLookUI \
    -framework CoreGraphics \
    -framework ImageIO \
    -framework UniformTypeIdentifiers \
    -o "$out_preview"

  echo "==> Compiling SLEAPQuickLookThumbnail.appex ($swift_target)..."
  swiftc \
    -O \
    -parse-as-library \
    -module-name SLEAPQuickLookThumbnail \
    -target "$swift_target" \
    -sdk "$SDK" \
    -import-objc-header "$HEADER" \
    "$PREVIEW_SRC/SLPBridge.swift" \
    "$THUMB_SRC/ThumbnailProvider.swift" \
    "$static_lib" \
    -Xlinker -e -Xlinker _NSExtensionMain \
    -Xlinker -dead_strip \
    -framework Cocoa \
    -framework QuickLookThumbnailing \
    -framework CoreGraphics \
    -framework ImageIO \
    -framework UniformTypeIdentifiers \
    -o "$out_thumb"
}

PREVIEW_EXT="$APP_BUNDLE/Contents/PlugIns/SLEAPQuickLook.appex"
THUMB_EXT="$APP_BUNDLE/Contents/PlugIns/SLEAPQuickLookThumbnail.appex"
rm -rf "$PREVIEW_EXT" "$THUMB_EXT"
mkdir -p \
  "$PREVIEW_EXT/Contents/MacOS" "$PREVIEW_EXT/Contents/Resources" \
  "$THUMB_EXT/Contents/MacOS" "$THUMB_EXT/Contents/Resources"

cp "$PREVIEW_SRC/Info.plist" "$PREVIEW_EXT/Contents/Info.plist"
cp "$THUMB_SRC/Info.plist" "$THUMB_EXT/Contents/Info.plist"

for plist in "$PREVIEW_EXT/Contents/Info.plist" "$THUMB_EXT/Contents/Info.plist"; do
  /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $SHORT_VERSION" "$plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUNDLE_VERSION" "$plist"
done

if [ "$UNIVERSAL" -eq 1 ]; then
  compile_swift_for_arch "arm64" "aarch64-apple-darwin" \
    "$RUST_DIR/target/aarch64-apple-darwin/release/libslp_ql_core.a" \
    "$WORK_DIR/SLEAPQuickLook.arm64" \
    "$WORK_DIR/SLEAPQuickLookThumbnail.arm64"

  compile_swift_for_arch "x86_64" "x86_64-apple-darwin" \
    "$RUST_DIR/target/x86_64-apple-darwin/release/libslp_ql_core.a" \
    "$WORK_DIR/SLEAPQuickLook.x86_64" \
    "$WORK_DIR/SLEAPQuickLookThumbnail.x86_64"

  echo "==> Creating universal Mach-O extension binaries (arm64 + x86_64)..."
  lipo -create \
    "$WORK_DIR/SLEAPQuickLook.arm64" \
    "$WORK_DIR/SLEAPQuickLook.x86_64" \
    -output "$PREVIEW_EXT/Contents/MacOS/SLEAPQuickLook"
  lipo -create \
    "$WORK_DIR/SLEAPQuickLookThumbnail.arm64" \
    "$WORK_DIR/SLEAPQuickLookThumbnail.x86_64" \
    -output "$THUMB_EXT/Contents/MacOS/SLEAPQuickLookThumbnail"
else
  HOST_ARCH="$(uname -m)"
  if [ "$HOST_ARCH" = "arm64" ]; then
    HOST_RUST_TARGET="aarch64-apple-darwin"
  else
    HOST_RUST_TARGET="x86_64-apple-darwin"
  fi
  compile_swift_for_arch "$HOST_ARCH" "$HOST_RUST_TARGET" \
    "$RUST_DIR/target/$HOST_RUST_TARGET/release/libslp_ql_core.a" \
    "$PREVIEW_EXT/Contents/MacOS/SLEAPQuickLook" \
    "$THUMB_EXT/Contents/MacOS/SLEAPQuickLookThumbnail"
fi

chmod +x \
  "$PREVIEW_EXT/Contents/MacOS/SLEAPQuickLook" \
  "$THUMB_EXT/Contents/MacOS/SLEAPQuickLookThumbnail"

# Inside-out code signing: sandboxed app extensions MUST be signed first with
# their own App Sandbox entitlements, and SLEAP.app signed last WITHOUT --deep
# (so the outer app's signature does not overwrite the extensions' sandbox
# entitlements).
echo "==> Signing Quick Look extensions and SLEAP.app inside-out (identity: $SIGN_IDENTITY)..."
codesign --force --sign "$SIGN_IDENTITY" ${SIGN_OPTS[@]+"${SIGN_OPTS[@]}"} \
  --entitlements "$ENTITLEMENTS" \
  "$PREVIEW_EXT"

codesign --force --sign "$SIGN_IDENTITY" ${SIGN_OPTS[@]+"${SIGN_OPTS[@]}"} \
  --entitlements "$ENTITLEMENTS" \
  "$THUMB_EXT"

codesign --force --sign "$SIGN_IDENTITY" ${SIGN_OPTS[@]+"${SIGN_OPTS[@]}"} \
  "$APP_BUNDLE"

echo "==> Verifying signatures and sandbox entitlements..."
codesign --verify --strict --verbose=2 "$PREVIEW_EXT"
codesign --verify --strict --verbose=2 "$THUMB_EXT"
codesign --verify --deep --strict --verbose=2 "$APP_BUNDLE"
if [ "$UNIVERSAL" -eq 1 ]; then
  codesign --verify --deep --strict --arch arm64 --verbose=2 "$APP_BUNDLE"
  codesign --verify --deep --strict --arch x86_64 --verbose=2 "$APP_BUNDLE"
fi

for ext in "$PREVIEW_EXT" "$THUMB_EXT"; do
  ent="$(codesign -d --entitlements - "$ext" 2>&1 || true)"
  case "$ent" in
    *"com.apple.security.app-sandbox"*) ;;
    *) echo "ERROR: $(basename "$ext") is missing com.apple.security.app-sandbox entitlement" >&2; exit 1 ;;
  esac
done

if [ "$DO_NOTARIZE" -eq 1 ]; then
  NOTARY_ID="${SLEAP_NOTARY_APPLE_ID:-${APPLE_ID:-}}"
  NOTARY_PW="${SLEAP_NOTARY_PASSWORD:-${APPLE_PASSWORD:-}}"
  NOTARY_TEAM="${SLEAP_NOTARY_TEAM_ID:-${APPLE_TEAM_ID:-}}"
  [ -n "$NOTARY_ID" ] && [ -n "$NOTARY_PW" ] && [ -n "$NOTARY_TEAM" ] || {
    echo "ERROR: --notarize requires SLEAP_NOTARY_APPLE_ID/PASSWORD/TEAM_ID (or APPLE_ID/PASSWORD/TEAM_ID)" >&2
    exit 1
  }
  echo "==> Notarizing SLEAP.app..."
  APP_ZIP="$WORK_DIR/SLEAP.app.zip"
  ditto -c -k --keepParent "$APP_BUNDLE" "$APP_ZIP"
  xcrun notarytool submit "$APP_ZIP" \
    --apple-id "$NOTARY_ID" \
    --password "$NOTARY_PW" \
    --team-id "$NOTARY_TEAM" \
    --wait --timeout 30m
  xcrun stapler staple "$APP_BUNDLE"
  xcrun stapler validate "$APP_BUNDLE"
fi

if [ -n "$DMG_PATH" ]; then
  echo "==> Rebuilding DMG at $DMG_PATH..."
  DMG_STAGE="$WORK_DIR/dmg-stage"
  mkdir -p "$DMG_STAGE"
  ditto "$APP_BUNDLE" "$DMG_STAGE/$(basename "$APP_BUNDLE")"
  ln -s /Applications "$DMG_STAGE/Applications"
  rm -f "$DMG_PATH"
  hdiutil create \
    -volname "SLEAP" \
    -srcfolder "$DMG_STAGE" \
    -ov \
    -format UDZO \
    "$DMG_PATH"
  if [ "$SIGN_IDENTITY" != "-" ]; then
    codesign --force --sign "$SIGN_IDENTITY" --timestamp "$DMG_PATH"
  fi
fi

if [ -n "$UPDATER_TGZ" ]; then
  echo "==> Rebuilding updater tarball at $UPDATER_TGZ..."
  rm -f "$UPDATER_TGZ" "${UPDATER_TGZ}.sig"
  COPYFILE_DISABLE=1 tar -czf "$UPDATER_TGZ" -C "$(dirname "$APP_BUNDLE")" "$(basename "$APP_BUNDLE")"
  if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
    echo "==> Re-signing updater tarball..."
    (cd "$ROOT" && bunx tauri signer sign "$UPDATER_TGZ")
  fi
fi

echo "==> Done bundling Quick Look extensions into $APP_BUNDLE"
ls -lh \
  "$PREVIEW_EXT/Contents/MacOS/SLEAPQuickLook" \
  "$THUMB_EXT/Contents/MacOS/SLEAPQuickLookThumbnail"
