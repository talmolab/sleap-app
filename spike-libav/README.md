# libav.js H.264 — Linux decode-perf spike

A throwaway harness to measure how fast our custom **libav.js (FFmpeg) H.264 WASM
decoder** runs on Linux hardware, plugged into `mediabunny` exactly as it will be
in `sleap-io.js`.

Why: on Linux desktop (Tauri → WebKitGTK) many machines can't decode H.264 via
native WebCodecs, so MP4 videos render as blank frames. The fix is a WASM software
decoder. Correctness is already proven **byte-exact vs native on macOS**; the one
thing macOS can't tell us is **decode speed on Linux**. That's what this measures.

## ⚠️ Which browser to use

Open the harness in **Epiphany / GNOME Web** — it uses **WebKitGTK, the same engine
the Tauri desktop app uses on Linux**, so its numbers predict the real app. Chrome/
Chromium/Firefox use a faster engine and will read optimistically (the page tells you
which engine it detected).

```bash
sudo apt install epiphany-browser   # if you don't have it
```

## Run it

```bash
cd spike-libav
bun install          # or: npm install
bun run dev          # or: npm run dev   → serves http://localhost:5199
```

Then open **http://localhost:5199** in Epiphany. It auto-runs and shows a results
table:

- **decode fps (libav)** — sequential decode throughput (playback/scrubbing). ≥30 = realtime.
- **seek ms avg/worst (libav)** — jump-to-frame latency (the main labeling interaction).
- **native ref** — the browser's own decoder, shown only for comparison. On a
  WebKitGTK box that lacks the H.264 codec this may be missing/blank — that's the
  very gap we're fixing.
- **Correctness maxΔ** — should be `0` (byte-exact vs native on the square-pixel clip).

Screenshot the page (or copy the table + the top banner that says which engine it
detected) and send it back.

## What "good" looks like

Rough targets for a usable labeling experience (WebKitGTK, single-threaded — the
conservative floor; the real app can use the faster threaded build):

- Sequential ≥ ~30 fps at your typical resolution → smooth playback.
- Jump-to-frame under a few hundred ms → responsive labeling.

Test clips are `testsrc2` (full-frame motion = harder than typical behavior video,
so this is a conservative estimate), 720p + 1080p, GOP 50.
