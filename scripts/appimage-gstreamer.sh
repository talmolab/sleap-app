#!/usr/bin/env bash
#
# Pick the GStreamer plugins the Linux AppImage bundles, and check what it got.
#
#   bash scripts/appimage-gstreamer.sh stage <dir>        # before `tauri build`
#   bash scripts/appimage-gstreamer.sh verify <AppImage>  # after it
#
# Why this exists: the AppImage bundles WebKitGTK and GStreamer's *core*
# libraries (linuxdeploy follows them via ldd), but GStreamer *plugins* are
# dlopen'd, so ldd never sees them. Without bundled plugins the AppImage's
# GStreamer (1.20, from the ubuntu-22.04 runner) loads the user's system plugins
# instead. On a newer distro those need newer GStreamer symbols
# (gst_query_new_selectable, gst_message_writable_details, ...), fail to load,
# and every video errors out as an unsupported codec -- even plain H.264 MP4.
#
# `bundle.linux.appimage.bundleMediaFramework` in tauri.conf.json fixes that by
# running linuxdeploy-plugin-gstreamer, which copies EVERY file in
# $GSTREAMER_PLUGINS_DIR into the AppImage and points GST_PLUGIN_SYSTEM_PATH at
# them. The runner's full plugin dir would drag in GPL plugins (faad, x265,
# mpeg2enc, mplex, resindvd, dtsdec from plugins-bad) and FFmpeg's libavcodec
# (gst-libav), all loaded *in-process* -- unlike the ffmpeg sidecar, which runs
# at arm's length (see src-tauri/binaries/FFMPEG_LICENSE_NOTICE.md). So `stage`
# copies an allowlist into a separate dir and exports GSTREAMER_PLUGINS_DIR to
# it; H.264 is decoded by openh264dec (Cisco OpenH264, BSD), never avdec_h264.

set -euo pipefail

# Each entry is one plugin; `a|b` takes the first that exists, for names that
# changed across GStreamer versions (1.22 merged videoconvert + videoscale into
# videoconvertscale). The CI runner is 1.20, so the first name is what ships.
PLUGINS=(
  # core + playback pipeline (WebKit's <video> and WebCodecs both use these)
  coreelements typefindfunctions playback app pbtypes
  "videoconvert|videoconvertscale" "videoscale|videoconvertscale" videorate
  videofilter opengl debugutilsbad autodetect
  # audio (only exercised by videos that carry an audio track)
  audioconvert audioresample volume audioparsers alsa pulseaudio opus vorbis ogg
  # containers + video codecs
  isomp4 matroska videoparsersbad openh264 vpx
)

# Must never end up in the AppImage: GPL and/or FFmpeg-backed.
DENY_RE='libgst(libav|x264|x265|faad|mpeg2enc|mplex|resindvd|dtsdec|a52dec|mpeg2dec)\.so|libav(codec|format|util)\.so|libx26[45]\.so|libfaad\.so'

die() { echo "::error::$*" >&2; exit 1; }

system_plugins_dir() {
  local d="/usr/lib/$(uname -m)-linux-gnu/gstreamer-1.0"
  [ -d "$d" ] || d=/usr/lib/gstreamer-1.0
  [ -d "$d" ] || die "no GStreamer plugin directory found"
  echo "$d"
}

stage() {
  local dest="$1" src name found alt
  src="$(system_plugins_dir)"
  rm -rf "$dest" && mkdir -p "$dest"
  for name in "${PLUGINS[@]}"; do
    found=""
    IFS='|' read -ra alts <<<"$name"
    for alt in "${alts[@]}"; do
      if [ -f "$src/libgst$alt.so" ]; then found="$src/libgst$alt.so"; break; fi
    done
    [ -n "$found" ] || die "GStreamer plugin '$name' not found in $src -- is its package installed?"
    cp -f "$found" "$dest/"
  done
  echo "staged $(ls "$dest" | wc -l) GStreamer plugins from $src into $dest:"
  ls "$dest"
  if [ -n "${GITHUB_ENV:-}" ]; then
    echo "GSTREAMER_PLUGINS_DIR=$dest" >>"$GITHUB_ENV"
  else
    echo "export GSTREAMER_PLUGINS_DIR=$dest   # set this before 'tauri build'"
  fi
}

verify() {
  local appimage root bundled expected
  appimage="$(readlink -f "$1")"
  [ -f "$appimage" ] || die "AppImage not found: $1"
  tmp="$(mktemp -d)"   # global, so the EXIT trap can still see it
  trap 'rm -rf "$tmp"' EXIT
  (cd "$tmp" && "$appimage" --appimage-extract >/dev/null)
  root="$tmp/squashfs-root"

  [ -f "$root/apprun-hooks/linuxdeploy-plugin-gstreamer.sh" ] ||
    die "AppImage has no GStreamer AppRun hook -- bundleMediaFramework did not run"
  [ -x "$root/usr/lib/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner" ] ||
    die "AppImage has no bundled gst-plugin-scanner"

  # Exactly the staged allowlist, nothing more (the plugin copies every file in
  # GSTREAMER_PLUGINS_DIR, so an unset variable shows up here as ~200 plugins).
  bundled="$(cd "$root/usr/lib/gstreamer-1.0" && ls libgst*.so | sort)"
  expected="$(ls "${GSTREAMER_PLUGINS_DIR:?GSTREAMER_PLUGINS_DIR is not set}" | sort)"
  if [ "$bundled" != "$expected" ]; then
    diff <(echo "$expected") <(echo "$bundled") || true
    die "bundled GStreamer plugins differ from the staged allowlist (diff above: < staged, > bundled)"
  fi

  local bad
  bad="$(cd "$root" && find . -type f | grep -E "$DENY_RE" || true)"
  [ -z "$bad" ] || die "AppImage contains GPL / FFmpeg-backed libraries:"$'\n'"$bad"

  echo "ok: AppImage bundles $(echo "$bundled" | wc -l) allowlisted GStreamer plugins, no GPL/FFmpeg libs"
}

case "${1:-}" in
  stage)  stage "${2:?usage: $0 stage <dir>}" ;;
  verify) verify "${2:?usage: $0 verify <AppImage>}" ;;
  *) echo "usage: $0 stage <dir> | verify <AppImage>" >&2; exit 2 ;;
esac
