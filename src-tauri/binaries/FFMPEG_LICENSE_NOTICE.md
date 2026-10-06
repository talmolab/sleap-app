# Bundled FFmpeg — license & source notice

The SLEAP desktop app bundles the **ffmpeg** and **ffprobe** command-line tools
as sidecars, used only to transcode videos whose codec the browser/WebView
cannot decode (Xvid/DivX, WMV/VC-1, MPEG-1/2, 10-bit HEVC) into a plain H.264
MP4 for labeling. They are invoked as **separate processes** (arm's-length CLI
calls via Tauri's shell plugin); no FFmpeg library is linked into the app, so
FFmpeg's license does not extend to SLEAP's own code.

FFmpeg is © the FFmpeg developers. Its full license texts ship with each build
and are available at <https://ffmpeg.org>. The per-platform builds SLEAP vendors:

| Platform | Source | License | H.264 encoder |
|----------|--------|---------|---------------|
| Windows (x86_64) | [BtbN/FFmpeg-Builds] `…-win64-lgpl` | **LGPL v2.1+** (`--enable-version3`, no `--enable-gpl`) | libopenh264 (Cisco, BSD) |
| Linux (x86_64) | [BtbN/FFmpeg-Builds] `…-linux64-lgpl` | **LGPL v2.1+** | libopenh264 (Cisco, BSD) |
| macOS (universal) | [ffmpeg.martin-riedl.de] arm64 + amd64, lipo-merged | **GPL v2+** (`--enable-gpl`) | libopenh264 + h264_videotoolbox |

The macOS builds are GPL-licensed. Because ffmpeg is bundled and run as a
standalone executable — not linked — this satisfies the GPL for the ffmpeg
binary itself without affecting the license of the rest of the application. The
complete corresponding source for these builds is available from:

- FFmpeg: <https://ffmpeg.org/download.html> (and the git revision embedded in
  each binary's `-version` output / `versions.txt`)
- OpenH264 (Cisco, BSD): <https://github.com/cisco/openh264>
- Build recipes: <https://github.com/BtbN/FFmpeg-Builds> and
  <https://ffmpeg.martin-riedl.de>

The binaries themselves are not committed to this repository; they are fetched
at build time by `scripts/fetch-ffmpeg.sh`, which pins the encoder policy
(permissive libopenh264 / videotoolbox only — never GPL-only libx264 as the
active encoder) and fails the build if a source stops providing it.

[BtbN/FFmpeg-Builds]: https://github.com/BtbN/FFmpeg-Builds
[ffmpeg.martin-riedl.de]: https://ffmpeg.martin-riedl.de
