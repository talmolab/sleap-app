#!/usr/bin/env bash
# Download the pinned sendme binary for macOS into ../bin/sendme.
# Pinned to v0.36.0 so both machines run the SAME iroh-blobs protocol version.
set -euo pipefail

VER="v0.36.0"
ARCH="$(uname -m)"
case "$ARCH" in
  arm64 | aarch64) A="darwin-aarch64" ;;
  x86_64)          A="darwin-x86_64" ;;
  *) echo "unknown arch: $ARCH" >&2; exit 1 ;;
esac

URL="https://github.com/n0-computer/sendme/releases/download/${VER}/sendme-${VER}-${A}.tar.gz"
cd "$(dirname "$0")/.."
mkdir -p bin
echo "downloading $URL"
curl -fsSL "$URL" | tar xz -C bin
# The tarball may nest the binary in a folder; normalise to bin/sendme.
if [ ! -x bin/sendme ]; then
  found="$(find bin -name sendme -type f | head -1)"
  [ -n "$found" ] && mv "$found" bin/sendme
fi
chmod +x bin/sendme
./bin/sendme --version
echo "OK -> ./bin/sendme"
