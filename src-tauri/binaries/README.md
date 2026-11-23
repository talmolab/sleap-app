# Bundled ffmpeg/ffprobe sidecars (legacy-codec transcode fallback)

The desktop app transcodes videos whose codec WebCodecs can't decode
(Xvid/DivX = MPEG-4 ASP, WMV3/VC-1, MPEG-1/2, 10-bit HEVC) into a plain H.264
MP4 once, caches it, and opens that through the normal hardware path. The
transcode runs in **bundled ffmpeg + ffprobe sidecars** so it needs no external
install and honors the "label without the training stack" goal. The
transcode/cache logic lives in `src/lib/transcode/` (unit tested), and the
sidecars are wired in via `externalBin` in `tauri.conf.json` + a scoped
`shell:allow-execute` capability (`capabilities/default.json` and the inlined
localhost capability in `src/lib.rs`).

## The binaries are fetched, never committed

`ffmpeg-<triple>` / `ffprobe-<triple>` are large and platform-specific, so they
are `.gitignore`'d and populated by **`scripts/fetch-ffmpeg.sh`**:

```bash
bun run fetch:ffmpeg                       # host triple (before `bun run tauri:dev`)
bun run fetch:ffmpeg universal-apple-darwin
bash scripts/fetch-ffmpeg.sh x86_64-pc-windows-msvc
```

CI runs this automatically in `.github/workflows/build.yml` (the "Vendor ffmpeg
sidecars" step, before "Build Tauri app"), once per platform using the matrix's
`sidecar-triple`. Without it, `tauri build` panics with
`resource path binaries/ffmpeg-<triple> doesn't exist`.

Tauri resolves `Command.sidecar("binaries/ffmpeg", …)` to `binaries/ffmpeg-<target-triple>`.
For the macOS `--target universal-apple-darwin` build that suffix is
`universal-apple-darwin` (a `lipo` of both arches), **not** the host arch. Get a
host triple with `rustc -Vv | grep host`.

| Tauri target | File the script writes |
|--------------|------------------------|
| `x86_64-unknown-linux-gnu` | `ffmpeg-x86_64-unknown-linux-gnu` |
| `x86_64-pc-windows-msvc` | `ffmpeg-x86_64-pc-windows-msvc.exe` |
| `universal-apple-darwin` | **all three**: `ffmpeg-aarch64-apple-darwin` + `ffmpeg-x86_64-apple-darwin` (one per compile leg) + the lipo'd `ffmpeg-universal-apple-darwin` (for bundling) |
| `aarch64-apple-darwin` / `x86_64-apple-darwin` | single-arch (local dev) |

> The universal build genuinely needs all three per tool: Tauri's `build.rs`
> resolves a **per-arch** sidecar for each of the two compile legs, and the
> bundler then copies the pre-merged **universal** one into the `.app`. Missing a
> per-arch file panics at compile; missing the universal file fails at
> "copy external binaries" during bundling.

## Linux: shipped as resources, not sidecars (#507)

`externalBin` always places sidecars next to the main binary. For the `.deb` /
`.rpm` that is `/usr/bin`, which made the packages install a system-wide
`/usr/bin/ffmpeg` that clashed with the distro's (or RPM Fusion's) own ffmpeg.
So on Linux, `tauri.linux.conf.json` (merged over `tauri.conf.json` on Linux
only) empties `externalBin` and ships the two tools as **resources** at the root
of Tauri's resource dir:

| Build | Where ffmpeg/ffprobe are | On the system PATH? |
|-------|--------------------------|---------------------|
| `.deb`, `.rpm` | `/usr/lib/SLEAP/` | no (private) |
| `.AppImage` | `usr/lib/SLEAP/` inside the image | no |
| `tauri dev` (Linux) | `src-tauri/target/<profile>/` (tauri-build copies resources there) | no |
| macOS / Windows | sidecars next to the app binary (unchanged) | no |

`/usr/lib/SLEAP` is Tauri's resource dir for the package (it already holds the
app's other resources, and the rpm owns it); Debian allows `/usr/lib/<pkg>` for
a package's internal executables, Fedora's libexecdir equivalent.

The Linux `resources` map replaces the base list, so it repeats the base
resources at their usual paths — keep the two in sync.

Because `externalBin` is empty on Linux, the shell plugin refuses **every**
`Command.sidecar(...)` there. So on Linux (`src/bundled_tools.rs`,
`src/lib/transcode/ffmpegCommand.ts`):

- the frontend always uses the scoped `bundled-ffmpeg` / `bundled-ffprobe`
  shell entries, whose `cmd` is `$RESOURCE/<tool>`;
- the resource dir is prepended to the `PATH` of the processes the app launches
  (sleap-nn, sleap-io, …), never to the user's own shell.

The resource sources name the `x86_64-unknown-linux-gnu` triple — the only
Linux target `fetch-ffmpeg.sh` supports. CI checks the built bundles with
`scripts/verify-linux-packages.sh`.

## Encoder / license policy

The transcode router only accepts a **permissive** H.264 encoder — `libopenh264`
(Cisco, BSD) or `h264_videotoolbox` (macOS OS framework) — never `libx264`
(GPL). `scripts/fetch-ffmpeg.sh` sources builds accordingly and **asserts** the
encoder is present after download, failing the build if a source ever stops
shipping it:

- **Windows / Linux** — [BtbN/FFmpeg-Builds] *lgpl* variant (LGPL, libopenh264).
- **macOS** — [ffmpeg.martin-riedl.de] arm64 + amd64 (GPL builds; bundled as an
  arm's-length CLI sidecar, so they don't relicense the app's own code).

License + corresponding-source details are in
[`FFMPEG_LICENSE_NOTICE.md`](./FFMPEG_LICENSE_NOTICE.md), which ships in the
bundle via `bundle.resources`.

## Notes
- Frame-exactness is guaranteed by `-fps_mode passthrough` (see
  `src/lib/transcode/transcodeArgs.ts`) — verified in the spike (10→10, 500→500
  frame parity), so SLEAP labels stay aligned to the original video.
- The video's ORIGINAL path stays in the `.slp`; the cache path lives only in
  `backendMetadata` (see `src/lib/resolveVideos.ts`).

[BtbN/FFmpeg-Builds]: https://github.com/BtbN/FFmpeg-Builds
[ffmpeg.martin-riedl.de]: https://ffmpeg.martin-riedl.de
