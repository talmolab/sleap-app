// Stub for `skia-canvas`, a Node-only native canvas library.
//
// As of @talmolab/sleap-io.js@0.4.0, the new Norpix StreamPix `.seq` video
// backend lazily does `await import("skia-canvas")` as a *fallback* image
// decoder for when no browser image API is available (see `makeImageData` /
// `decodeEncoded` in sleap-io.js). Those calls are guarded by runtime checks
// for `ImageData` / `createImageBitmap` / `OffscreenCanvas`, all of which exist
// in real browsers and in the Tauri WebView2 — so the skia-canvas path is dead
// code in every build target this app ships.
//
// The problem is purely at build time: Rollup/Vite statically resolves the
// dynamic `import("skia-canvas")`, pulls in `skia-canvas/lib/browser.js`, and
// that file dynamically imports `jszip` (not a dependency of this app), which
// fails to resolve and breaks `bun run build`. Aliasing `skia-canvas` to this
// empty module in vite.config.ts keeps the bundler from walking into it.
export {};
