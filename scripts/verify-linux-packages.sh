#!/usr/bin/env bash
#
# Check where the Linux bundles put the bundled ffmpeg / ffprobe (#507).
#
#   bash scripts/verify-linux-packages.sh <bundle-dir>
#   # e.g. src-tauri/target/release/bundle
#
# On Linux the tools ship as Tauri *resources* (tauri.linux.conf.json), so they
# must sit at the root of the resource dir, where the app runs them from
# (`$RESOURCE/ffmpeg`, see src-tauri/src/bundled_tools.rs):
# - .deb and .rpm: /usr/lib/SLEAP/{ffmpeg,ffprobe}, executable, and NOTHING
#   named ffmpeg/ffprobe in /usr/bin -- that is what clashed with the distro's /
#   RPM Fusion's ffmpeg.
# - .AppImage: usr/lib/SLEAP/{ffmpeg,ffprobe} inside the image, executable
#   (and no stray usr/bin copy the app would never use).
#
# Needs: dpkg-deb (always on Ubuntu) and rpm (`apt-get install rpm`).

set -euo pipefail

B="${1:?usage: $0 <bundle-dir>}"
PRIVATE=/usr/lib/SLEAP
fail=0
err() { echo "::error::$*"; fail=1; }

one() { # dir glob -> the single matching file
  local f
  f="$(find "$B/$1" -maxdepth 1 -type f -name "$2" 2>/dev/null | head -1)"
  [ -n "$f" ] || { echo "::error::no $2 under $B/$1" >&2; exit 1; }
  printf '%s\n' "$f"
}

# check <label> <listing>: listing lines are "<perms> <path>" (path absolute).
check() {
  local label="$1" listing="$2" tool line
  for tool in ffmpeg ffprobe; do
    line="$(printf '%s\n' "$listing" | awk -v p="$PRIVATE/$tool" '$2 == p' | head -1)"
    if [ -z "$line" ]; then
      err "$label: $PRIVATE/$tool is missing"
    elif [[ "${line%% *}" != -rwx* ]]; then
      err "$label: $PRIVATE/$tool is not executable ($line)"
    else
      echo "ok   $label: $line"
    fi
    if printf '%s\n' "$listing" | awk '{print $2}' | grep -qx "/usr/bin/$tool"; then
      err "$label: still installs /usr/bin/$tool (clashes with the system ffmpeg)"
    else
      echo "ok   $label: no /usr/bin/$tool"
    fi
  done
}

# --- .deb ---------------------------------------------------------------
DEB="$(one deb '*.deb')"
echo "== $(basename "$DEB")"
# dpkg-deb -c: "-rwxr-xr-x root/root 123 2024-01-01 00:00 ./usr/lib/SLEAP/ffmpeg"
DEB_LIST="$(dpkg-deb -c "$DEB" | awk '{p=$6; sub(/^\./, "", p); print $1, p}')"
check deb "$DEB_LIST"

# --- .rpm ---------------------------------------------------------------
RPM="$(one rpm '*.rpm')"
echo "== $(basename "$RPM")"
command -v rpm >/dev/null || { echo "::error::rpm is not installed (apt-get install rpm)"; exit 1; }
RPM_LIST="$(rpm -qp --nosignature --qf '[%{FILEMODES:perms} %{FILENAMES}\n]' "$RPM")"
check rpm "$RPM_LIST"

# --- .AppImage ------------------------------------------------------------
APPIMAGE="$(one appimage '*.AppImage')"
echo "== $(basename "$APPIMAGE")"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
chmod +x "$APPIMAGE"
appimage="$(cd "$(dirname "$APPIMAGE")" && pwd)/$(basename "$APPIMAGE")"
(cd "$tmp" && "$appimage" --appimage-extract >/dev/null)
for tool in ffmpeg ffprobe; do
  f="$tmp/squashfs-root$PRIVATE/$tool"
  if [ -x "$f" ] && [ -f "$f" ]; then
    echo "ok   AppImage: ${PRIVATE#/}/$tool"
  else
    err "AppImage: ${PRIVATE#/}/$tool is missing or not executable"
  fi
  if [ -e "$tmp/squashfs-root/usr/bin/$tool" ]; then
    err "AppImage: unexpected usr/bin/$tool (the app runs ${PRIVATE#/}/$tool)"
  fi
done

[ "$fail" = 0 ] || exit 1
echo "Linux packages: bundled ffmpeg/ffprobe are where they should be."
