# Testing the libav.js H.264 software-decoder fallback (Linux)

This branch (`feat/linux-h264-decode-app`) wires the WASM H.264 software decoder
into the app so Linux/WebKitGTK users whose system can't decode H.264 in hardware
see MP4 video instead of blank frames. It pairs with the sleap-io.js branch
`feat/linux-h264-wasm-decode` (the decoder itself).

Goal of the test: confirm, in the **real Tauri app on Linux**, that (1) the
fallback actually decodes MP4 video, (2) colors look correct, (3) speed is
acceptable, and (4) there's **no regression** when native decode is available.

## Prerequisite: the io sibling (not published yet)

The decoder lives in sleap-io.js, which isn't published with these changes yet, so
the app must use a **local sibling checkout** (Vite auto-detects `../sleap-io.js`).

```bash
# next to your sleap-app checkout:
git clone https://github.com/talmolab/sleap-io.js   # skip if already present
cd sleap-io.js
git fetch origin && git checkout feat/linux-h264-wasm-decode
bun install && bun run build          # builds dist/ that the app consumes
```

## App setup

```bash
cd ../sleap-app
git fetch origin && git checkout feat/linux-h264-decode-app
bun install
bun add file:../sleap-io.js           # link the local io sibling (do NOT commit this)
```

## Run the test

Your Linux machine **can** decode H.264 natively, so to actually exercise our WASM
decoder you must **force** it (otherwise the app correctly uses native decode):

```bash
VITE_FORCE_LIBAV_H264=1 bun run tauri:dev
```

Then open a project that uses an **external MP4** video and check:

- ✅ A toast appears: **"Using software video decoding"**.
- ✅ The video **renders** (frames visible, not blank).
- ✅ **Colors look correct** — no washed-out / over-contrasty look (this validates
  the SPS-colorspace fix for the WebKitGTK color shift).
- ✅ **Playback and jump-to-frame** feel usable (roughly the spike numbers:
  ~1080p should scrub, seeks a few hundred ms).

## Confirm zero regression (important)

Run it again **without** forcing — plain `bun run tauri:dev` — and open the same
MP4 project. Because this machine has native H.264:

- ✅ **No** "software decoding" toast.
- ✅ Video plays via native decode exactly as before (the WASM decoder never loads).

That confirms macOS/Windows/Linux-with-codec are untouched.

## Automating with Claude Code

Paste this into Claude Code on the Linux machine:

```
Test the libav H.264 software-decoder fallback in the SLEAP desktop app end to end.
Context: the decoder is in sleap-io.js branch feat/linux-h264-wasm-decode (not
published, use a local sibling checkout) and wired into the app on branch
feat/linux-h264-decode-app. Do this and report what you see:

1. Sibling io: clone talmolab/sleap-io.js next to sleap-app if missing; in it,
   `git fetch && git checkout feat/linux-h264-wasm-decode && bun install && bun run build`.
2. App: `git fetch && git checkout feat/linux-h264-decode-app && bun install &&
   bun add file:../sleap-io.js`.
3. Launch FORCING the fallback: `VITE_FORCE_LIBAV_H264=1 bun run tauri:dev`. Wait for
   the window. Use the tauri-pilot CLI (see .claude/skills/tauri-pilot) to drive it:
   open a project with an external MP4 video, screenshot the video panel, and read
   `tauri-pilot logs`. Confirm: a "Using software video decoding" toast, the video
   frames actually render (not blank), colors look natural, and jump-to-frame works.
   Note decode timing if visible.
4. Relaunch WITHOUT forcing (`bun run tauri:dev`), open the same project, and confirm
   NO toast + video still plays (native path, zero regression).
5. Report: does the fallback render correct-looking video? colors ok? speed ok? any
   console errors? plus this machine's CPU (`lscpu | grep 'Model name'`).
```

Report back the screenshots / observations and we'll finalize (then publish io and
bump the app dep to merge).
