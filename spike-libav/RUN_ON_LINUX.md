# Run this perf test on your Linux machine via Claude Code

On the Linux box (which already has the `sleap-app` repo cloned), open Claude Code
in the repo and **paste the prompt below**. It drives the whole test and reports the
numbers back to you.

> The harness auto-runs on page load and renders a results table + an engine banner.
> The goal is a number from **WebKitGTK** (Epiphany / GNOME Web) — the same engine the
> Tauri desktop app uses — because that predicts the real app. A Chromium number is a
> useful but optimistic upper bound.

---

## 📋 Paste this into Claude Code on the Linux machine

```
I need to run a WASM-video-decoder performance spike and report the numbers. Context:
we built a custom libav.js (FFmpeg) H.264 software decoder for sleap-app so Linux
desktop users (Tauri/WebKitGTK, which often can't decode H.264 natively) can view MP4
videos. Correctness is already proven byte-exact on macOS. This test measures decode
SPEED on this Linux machine. Everything is self-contained in the `spike-libav/`
directory on the `spike/libav-linux-perf` branch.

Please do the following and report back a concise summary:

1. Check out the branch and enter the spike:
     git fetch origin spike/libav-linux-perf
     git checkout spike/libav-linux-perf
     cd spike-libav

2. Install deps and start the dev server in the BACKGROUND (do not block):
     bun install   (fall back to `npm install` if bun is missing)
     bun run dev    (serves http://localhost:5199 ; fall back to `npm run dev`)
   Wait until http://localhost:5199 responds.

3. REPRESENTATIVE number (WebKitGTK — this is the one that matters). Epiphany / GNOME
   Web uses WebKitGTK, the same engine as the Tauri app:
     - Ensure Epiphany is installed: `epiphany-browser --version` ; if missing,
       `sudo apt install -y epiphany-browser` (ask me first if it needs sudo).
     - Launch it at the page:  `epiphany-browser http://localhost:5199 &`
     - Wait ~25 seconds for the harness to finish (it decodes 720p + 1080p).
     - Capture the window so you can read the results: try `gnome-screenshot -f
       /tmp/perf.png` (or `scrot /tmp/perf.png`, or `import -window root /tmp/perf.png`).
     - Read /tmp/perf.png and transcribe: the top banner (should say "WebKitGTK ✓"),
       the correctness maxΔ, and for BOTH 720p and 1080p the "decode fps (libav)" and
       "seek ms avg/worst (libav)".

4. QUICK upper-bound number (Chromium, optional but nice): if you have browser
   automation available (e.g. the agent-browser CLI, or Playwright/Chromium), open
   http://localhost:5199, wait ~25s, and read the text of the `#verdict` and `#log`
   DOM elements. Label these numbers as "Chromium — optimistic, not representative".

5. Report back, clearly, a small table:
     resolution | engine (WebKitGTK/Chromium) | sequential fps | jump-to-frame ms (avg/worst)
   plus the correctness maxΔ (should be 0) and this machine's CPU model
   (`lscpu | grep 'Model name'`).

Notes:
- If Epiphany won't screenshot headlessly, just launch it and tell me to screenshot
  the page manually — the table is self-explanatory.
- The dev server must keep running while the page loads; stop it when done.
- Don't worry about the "native ref" column being blank — that's expected if this
  machine's WebKitGTK lacks the native H.264 codec (the exact gap we're fixing).
```

---

## Or run it manually (no Claude Code)

```bash
git fetch origin spike/libav-linux-perf && git checkout spike/libav-linux-perf
cd spike-libav && bun install && bun run dev
# open http://localhost:5199 in Epiphany, screenshot the results
```

Send the screenshot / numbers back and we'll decide whether single-threaded WASM
decode is fast enough (and whether to enable the threaded build) before wiring it
into `sleap-io.js`.
