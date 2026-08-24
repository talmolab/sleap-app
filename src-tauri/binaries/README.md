# Bundled ffmpeg sidecar (legacy-codec transcode fallback)

The desktop app transcodes videos whose codec WebCodecs can't decode
(Xvid/DivX = MPEG-4 ASP, WMV3/VC-1, MPEG-1/2, 10-bit HEVC) into a plain H.264
MP4 once, caches it, and opens that through the normal hardware path. The
transcode runs in a **bundled ffmpeg sidecar** so it needs no external install
and honors the "label without the training stack" goal.

The transcode/cache logic already lives in `src/lib/transcode/` and is unit
tested. What remains is **vendoring the binaries and turning the wiring on** —
the steps below. They are intentionally NOT applied yet, because adding
`externalBin` without the binaries present breaks `tauri build`.

## 1. Obtain per-platform ffmpeg builds (libopenh264, permissive)

Use a build compiled with **`libopenh264`** (BSD) as the H.264 encoder — NOT
`libx264` (GPL). This matches CVAT's choice and keeps our bundle permissively
licensed (libavcodec is LGPL). One binary per Tauri target triple:

| Platform | Target triple (example) | File to drop here |
|----------|-------------------------|-------------------|
| macOS (Apple Silicon) | `aarch64-apple-darwin` | `ffmpeg-aarch64-apple-darwin` |
| macOS (Intel) | `x86_64-apple-darwin` | `ffmpeg-x86_64-apple-darwin` |
| Windows | `x86_64-pc-windows-msvc` | `ffmpeg-x86_64-pc-windows-msvc.exe` |
| Linux | `x86_64-unknown-linux-gnu` | `ffmpeg-x86_64-unknown-linux-gnu` |

Tauri resolves `Command.sidecar("binaries/ffmpeg", …)` to
`binaries/ffmpeg-<target-triple>` at build time (see `FFMPEG_SIDECAR` in
`src/lib/transcode/transcodeDepsTauri.ts`). Get the target triple with
`rustc -Vv | grep host`.

> If we also want native codec **probing** (recommended, so a large legacy file
> never gets materialized into the WebView just to detect its codec), bundle a
> matching `ffprobe-<target-triple>` too and add a second `externalBin` entry.

## 2. Declare the sidecar in `tauri.conf.json`

```jsonc
// bundle: { … }
"externalBin": ["binaries/ffmpeg"]   // + "binaries/ffprobe" if probing natively
```

## 3. Grant the shell permission (capability sync — THREE surfaces)

Per the project's capability-sync rule, a shell/sidecar permission must be
added everywhere a capability is defined, or it silently fails only in bundles:

- `src-tauri/capabilities/default.json`
- the inlined **localhost** capability (bundled builds serve from
  `http://localhost`; grep `lib.rs` / capabilities for the localhost capability)
- `build.rs` ACL, if the project enumerates permissions there

Add a scoped execute permission (do NOT grant unrestricted `shell:allow-execute`):

```jsonc
{
  "identifier": "shell:allow-execute",
  "allow": [
    { "name": "binaries/ffmpeg", "sidecar": true, "args": true }
  ]
}
```

## 4. Turn on the router branch

Wire `src/lib/resolveVideos.ts` `createBackendForPath` to probe the codec and,
when `codecNeedsTranscode()` is true, call `transcodeToMp4()` with
`createTauriTranscodeDeps()` and open the returned MP4 via the normal Mp4Box
path. See the marked integration point in that file. Keep the video's ORIGINAL
path in the `.slp` (store the cache path only in `backendMetadata`).

## Notes
- `.gitignore` the binaries themselves (they're large / platform-specific);
  fetch them in CI or a setup script. This README + `.gitkeep` keep the dir.
- Frame-exactness is guaranteed by `-fps_mode passthrough` (see
  `transcodeArgs.ts`) — verified in the spike (10→10, 500→500 frame parity), so
  SLEAP labels stay aligned to the original.
