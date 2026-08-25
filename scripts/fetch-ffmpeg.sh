#!/usr/bin/env bash
#
# Vendor the bundled ffmpeg + ffprobe sidecars into src-tauri/binaries/.
#
#   bash scripts/fetch-ffmpeg.sh                       # host triple (local dev)
#   bash scripts/fetch-ffmpeg.sh universal-apple-darwin
#   bun run fetch:ffmpeg x86_64-pc-windows-msvc
#
# Why this exists: tauri.conf.json declares
#   "externalBin": ["binaries/ffmpeg", "binaries/ffprobe"]
# so `tauri build` panics ("resource path binaries/ffmpeg-<triple> doesn't
# exist") unless the per-target-triple binaries are present. They are large and
# platform-specific, so binaries/ is .gitignore'd and populated here instead --
# from CI before the build, or by a developer before `tauri:dev`.
#
# The desktop transcode fallback (src/lib/transcode/) only accepts a PERMISSIVE
# H.264 encoder -- libopenh264 (BSD) or h264_videotoolbox (macOS, an OS
# framework) -- never libx264 (GPL). So the sources below are chosen to carry
# libopenh264:
#   - Windows / Linux : BtbN FFmpeg-Builds, the *lgpl* variant (libopenh264, no
#                       libx264). These platforms have no videotoolbox, so a
#                       libopenh264 build is the only permissive option.
#   - macOS           : martin-riedl.de static builds (arm64 + amd64), lipo-
#                       merged into one universal binary. These are GPL builds,
#                       bundled as an arm's-length CLI sidecar (a separate
#                       process, never linked), so they do not relicense the
#                       app's own code -- see binaries/FFMPEG_LICENSE_NOTICE.md.
#
# Overridable for pinning/mirroring: FFMPEG_BTBN_TAG, FFMPEG_MARTINRIEDL_BASE.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$SCRIPT_DIR/../src-tauri/binaries"

TRIPLE="${1:-}"
if [ -z "$TRIPLE" ]; then
  if command -v rustc >/dev/null 2>&1; then
    TRIPLE="$(rustc -Vv | sed -n 's/^host: //p')"
  fi
fi
if [ -z "$TRIPLE" ]; then
  echo "usage: fetch-ffmpeg.sh <target-triple>   (or install rustc for host auto-detect)" >&2
  echo "  supported: x86_64-unknown-linux-gnu | x86_64-pc-windows-msvc |" >&2
  echo "             universal-apple-darwin | aarch64-apple-darwin | x86_64-apple-darwin" >&2
  exit 2
fi

BTBN_TAG="${FFMPEG_BTBN_TAG:-latest}"
BTBN_BASE="https://github.com/BtbN/FFmpeg-Builds/releases/download/${BTBN_TAG}"
MR_BASE="${FFMPEG_MARTINRIEDL_BASE:-https://ffmpeg.martin-riedl.de}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

log()  { printf '  %s\n' "$*" >&2; }
fail() { printf 'fetch-ffmpeg: %s\n' "$*" >&2; exit 1; }

fetch() { # url dest
  log "downloading $(basename "$2") <- $1"
  curl -fL --retry 3 --retry-delay 2 --connect-timeout 30 -o "$2" "$1" \
    || fail "download failed: $1"
}

extract() { # archive destdir  (handles .tar.xz and .zip across mac/linux/windows)
  mkdir -p "$2"
  case "$1" in
    *.tar.xz|*.txz) tar -xJf "$1" -C "$2" ;;
    *.zip)
      if command -v unzip >/dev/null 2>&1; then
        unzip -q -o "$1" -d "$2"
      elif command -v powershell.exe >/dev/null 2>&1; then
        # Git Bash on the Windows runner: no unzip, but PowerShell is on PATH.
        powershell.exe -NoProfile -Command \
          "Expand-Archive -Force -Path '$(cygpath -w "$1")' -DestinationPath '$(cygpath -w "$2")'"
      else
        tar -xf "$1" -C "$2"   # bsdtar (macOS / Windows System32) extracts zip
      fi ;;
    *) fail "unknown archive type: $1" ;;
  esac
}

# Resolve martin-riedl's latest versioned download URL for a tool by scraping the
# index (their paths are timestamp_gitref, with no stable "latest" alias).
mr_url() { # arch(arm64|amd64) tool(ffmpeg|ffprobe)
  local rel
  rel="$(curl -fsSL "$MR_BASE/" \
    | grep -oE "/download/macos/$1/[^\"']+/$2\.zip" | head -n1)" || true
  [ -n "$rel" ] || fail "could not resolve martin-riedl macOS/$1/$2 URL from $MR_BASE"
  printf '%s%s\n' "$MR_BASE" "$rel"
}

mr_tool() { # arch tool outfile  (download + extract flat single-file zip)
  fetch "$(mr_url "$1" "$2")" "$TMP/$2-$1.zip"
  extract "$TMP/$2-$1.zip" "$TMP/$2-$1.d"
  # martin-riedl zips contain a single flat binary named exactly <tool>.
  cp "$TMP/$2-$1.d/$2" "$3"
}

btbn() { # variant(win64|linux64) archive-ext  -> extracts */bin/<tool>[.exe]
  local dir="$TMP/btbn"
  fetch "$BTBN_BASE/ffmpeg-master-latest-$1-lgpl.$2" "$TMP/btbn.$2"
  extract "$TMP/btbn.$2" "$dir"
  echo "$dir"
}

mkdir -p "$DEST"
log "target triple: $TRIPLE"
log "dest: $DEST"

case "$TRIPLE" in
  x86_64-unknown-linux-gnu)
    d="$(btbn linux64 tar.xz)"
    cp "$d"/*/bin/ffmpeg  "$DEST/ffmpeg-$TRIPLE"
    cp "$d"/*/bin/ffprobe "$DEST/ffprobe-$TRIPLE"
    ;;
  x86_64-pc-windows-msvc)
    d="$(btbn win64 zip)"
    cp "$d"/*/bin/ffmpeg.exe  "$DEST/ffmpeg-$TRIPLE.exe"
    cp "$d"/*/bin/ffprobe.exe "$DEST/ffprobe-$TRIPLE.exe"
    ;;
  aarch64-apple-darwin|x86_64-apple-darwin)
    arch=arm64; [ "$TRIPLE" = x86_64-apple-darwin ] && arch=amd64
    mr_tool "$arch" ffmpeg  "$DEST/ffmpeg-$TRIPLE"
    mr_tool "$arch" ffprobe "$DEST/ffprobe-$TRIPLE"
    ;;
  universal-apple-darwin)
    command -v lipo >/dev/null 2>&1 || fail "lipo not found (universal build needs macOS)"
    for tool in ffmpeg ffprobe; do
      mr_tool arm64 "$tool" "$TMP/$tool.arm64"
      mr_tool amd64 "$tool" "$TMP/$tool.amd64"
      lipo -create "$TMP/$tool.arm64" "$TMP/$tool.amd64" -output "$DEST/$tool-$TRIPLE"
    done
    ;;
  *)
    fail "unsupported target triple: $TRIPLE"
    ;;
esac

# Executable bit (lost through zip on some extractors; harmless on Windows).
chmod +x "$DEST"/ffmpeg-"$TRIPLE"* "$DEST"/ffprobe-"$TRIPLE"* 2>/dev/null || true

FFMPEG_BIN="$(ls "$DEST"/ffmpeg-"$TRIPLE"* | head -n1)"
FFPROBE_BIN="$(ls "$DEST"/ffprobe-"$TRIPLE"* | head -n1)"
[ -s "$FFMPEG_BIN" ]  || fail "ffmpeg binary missing/empty: $FFMPEG_BIN"
[ -s "$FFPROBE_BIN" ] || fail "ffprobe binary missing/empty: $FFPROBE_BIN"
log "wrote $(basename "$FFMPEG_BIN") + $(basename "$FFPROBE_BIN")"

# Runtime assertion -- only when the fetched binary can execute on THIS host
# (always true in CI, where each runner fetches its own triple). Catches a source
# that silently stopped shipping a permissive H.264 encoder before it ships.
host_can_run() {
  case "$(uname -s)" in
    Linux)              [ "$TRIPLE" = x86_64-unknown-linux-gnu ] ;;
    Darwin)             case "$TRIPLE" in *apple-darwin) return 0 ;; *) return 1 ;; esac ;;
    MINGW*|MSYS*|CYGWIN*) [ "$TRIPLE" = x86_64-pc-windows-msvc ] ;;
    *) return 1 ;;
  esac
}
if host_can_run; then
  log "asserting encoder + ffprobe run on this host..."
  "$FFPROBE_BIN" -version >/dev/null 2>&1 || fail "ffprobe failed to run: $FFPROBE_BIN"
  if ! "$FFMPEG_BIN" -hide_banner -encoders 2>/dev/null \
       | grep -qE '\blibopenh264\b|\bh264_videotoolbox\b'; then
    fail "bundled ffmpeg has no permissive H.264 encoder (need libopenh264 or h264_videotoolbox)"
  fi
  log "ok: permissive H.264 encoder present, ffprobe runs"
else
  log "skipping run-assertion (cross-fetched $TRIPLE on $(uname -s))"
fi

log "done."
