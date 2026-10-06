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
exec bun run tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}' "$@"
