#!/usr/bin/env bash
# Build the desktop installers on a developer machine, from a fresh clone.
#
#   bun run tauri:build:local [extra `tauri build` args]
#
# Differs from `bun run tauri:build` (what CI runs) in two ways:
#   - fetches the ffmpeg/ffprobe sidecars first if they are missing; without
#     them `tauri build` panics ("resource path binaries/ffmpeg-<triple>
#     doesn't exist"). See src-tauri/binaries/README.md.
#   - skips updater artifacts. tauri.conf.json sets createUpdaterArtifacts, which
#     signs them with TAURI_SIGNING_PRIVATE_KEY -- a release secret only CI has --
#     so a local build would otherwise end in an error after the installers are
#     already written.
#   - on macOS, bundles and inside-out signs the Quick Look Preview & Thumbnail
#     app extensions inside SLEAP.app (and rebuilds the .dmg if produced).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."

command -v rustc >/dev/null 2>&1 || { echo "tauri-build-local: rustc not found (install Rust first)" >&2; exit 1; }
TRIPLE="$(rustc -Vv | sed -n 's/^host: //p')"

if ! ls "$ROOT/src-tauri/binaries/ffmpeg-$TRIPLE"* >/dev/null 2>&1 \
   || ! ls "$ROOT/src-tauri/binaries/ffprobe-$TRIPLE"* >/dev/null 2>&1; then
  echo "tauri-build-local: ffmpeg sidecars missing for $TRIPLE, fetching..."
  bash "$SCRIPT_DIR/fetch-ffmpeg.sh" "$TRIPLE"
fi

cd "$ROOT"
bun run tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}' "$@"

if [ "$(uname -s)" = "Darwin" ]; then
  UNIVERSAL_ARGS=()
  PROFILE="release"
  TARGET_PREFIX=""
  for arg in "$@"; do
    if [ "$arg" = "--debug" ] || [ "$arg" = "-d" ]; then
      PROFILE="debug"
    elif [ "$arg" = "universal-apple-darwin" ]; then
      TARGET_PREFIX="universal-apple-darwin/"
      UNIVERSAL_ARGS=(--universal)
    fi
  done
  BUNDLE_DIR="$ROOT/src-tauri/target/${TARGET_PREFIX}${PROFILE}/bundle"
  APP="$BUNDLE_DIR/macos/SLEAP.app"
  if [ -d "$APP" ]; then
    DMG="$(find "$BUNDLE_DIR/dmg" -maxdepth 1 -type f -name '*.dmg' ! -name 'rw.*' 2>/dev/null | head -1 || true)"
    DMG_ARGS=()
    [ -n "$DMG" ] && DMG_ARGS=(--dmg "$DMG")
    bash "$SCRIPT_DIR/bundle-macos-quicklook.sh" \
      --app "$APP" \
      ${UNIVERSAL_ARGS[@]+"${UNIVERSAL_ARGS[@]}"} \
      ${DMG_ARGS[@]+"${DMG_ARGS[@]}"}
  fi
fi
