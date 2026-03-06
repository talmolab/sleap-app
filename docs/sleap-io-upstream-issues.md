# sleap-io.js Upstream Issues

> **Issues 1–7 were resolved in `@talmolab/sleap-io.js` v0.2.0.**
> Workarounds in sleap-label-web have been removed. See PRs #43–#49 in sleap-io.js.

> **Issues 8–9 were resolved in v0.2.1.**
> Browser bundler stubs for `skia-canvas` and `child_process` removed. Duck-typed
> predicted instance detection replaced with `instanceof PredictedInstance`.

---

## 1. `saveSlp` / `writeSlp` is Node-only — no browser SLP writing

**Status**: ✅ Fixed in PR #48. `saveSlpToBytes(labels): Promise<Uint8Array>` is now exported.

**Workaround removed**: Deleted `src/lib/slpWriter.ts` (477 lines). `src/lib/saveProject.ts` now imports `saveSlpToBytes` directly from `@talmolab/sleap-io.js`.

---

## 2. Serialization internals not exported or composable

**Status**: ✅ Resolved by PR #48. `saveSlpToBytes` handles the full serialization pipeline, so downstream code no longer needs to reimplement any serialization functions.

---

## 3. `Labels.find()` basename fallback incorrectly matches videos in .pkg.slp

**Status**: ✅ Fixed in PR #44. `Labels.find()` now uses strict matching by default. `matchesPath` splits on both `/` and `\\`.

**Workaround removed**: All `labels.labeledFrames.filter()` video+frameIdx lookups have been replaced with `labels.find({ video, frameIdx })`.

---

## 4. `Mp4BoxVideoBackend` constructor hangs on non-fetchable URLs

**Status**: ✅ Fixed in PR #43. Constructor now accepts `string | File | Blob`. When `File`/`Blob` is passed, it sets `fileBlob` directly and skips the network fetch.

**Workaround removed**: `assignVideoBackend()` in `src/lib/resolveVideos.ts` now uses `new Mp4BoxVideoBackend(file)` directly instead of the `Object.create` hack.

---

## 5. `openSource()` HEAD-then-GET is fragile

**Status**: ✅ Fixed in PR #43. `openSource()` now uses a single `GET` with `Range: bytes=0-0` instead of a HEAD request.

---

## 6. `Video.shape` and `Video.fps` are getter-only (no setter)

**Status**: ✅ Fixed in PR #45. `Video.shape` and `Video.fps` now have setters that store to a private backing field.

**Workaround removed**: `(video as any).shape = ...` casts in `resolveVideos.ts` replaced with direct `video.shape = ...` assignment.

---

## 7. `Point.score` missing from base `Point` type

**Status**: ✅ Fixed in PR #45. `Point` type now includes optional `score?: number`.

**Workaround removed**: `(point as any).score` casts are no longer needed (the local `slpWriter.ts` that had them was deleted entirely).

---

## 8. Browser bundler requires manual stubs for `skia-canvas` and `child_process`

**Status**: ✅ Fixed in v0.2.1. Package now has a `"browser"` conditional export that excludes Node-only modules.

**Workaround removed**: Deleted `src/lib/stubs/skia-canvas.ts` and `src/lib/stubs/child_process.ts`. Removed corresponding `resolve.alias` entries from `vite.config.ts`.

---

## 9. `PredictedInstance` duck-typing required `"score" in inst` checks

**Status**: ✅ Fixed in v0.2.1. `PredictedInstance` is properly exported as a class extending `Instance`, enabling `instanceof` checks.

**Workaround removed**: All `"score" in inst` duck-typing and `(inst as unknown as { score: number }).score` casts replaced with `inst instanceof PredictedInstance` and direct `inst.score` access. `clonePoints()` now preserves `point.score`. `cloneInstances()` constructs proper `PredictedInstance` objects.

---

## Remaining Notes

- **`fs`/`os`/`path` build warnings**: Vite emits warnings about Node built-in modules being externalized from a shared chunk in sleap-io.js. These are harmless — the browser entry point doesn't use them, but they exist in a shared chunk for the Node entry point. The `module` stub for h5wasm is still required.
- **`VideosPanel` limitation**: Adding standalone videos to an existing project still requires more plumbing in sleap-io.js (no dedicated API beyond `labels.videos.push()`).

---

## Summary

| # | Issue | Status | Fixed in |
|---|-------|--------|----------|
| 1 | `saveSlp`/`writeSlp` is Node-only | ✅ Fixed | v0.2.0 PR #48 |
| 2 | Serialization internals not exported | ✅ Fixed | v0.2.0 PR #48 |
| 3 | `Labels.find()` basename fallback | ✅ Fixed | v0.2.0 PR #44 |
| 4 | `Mp4BoxVideoBackend` constructor hangs | ✅ Fixed | v0.2.0 PR #43 |
| 5 | `openSource()` HEAD-then-GET fragile | ✅ Fixed | v0.2.0 PR #43 |
| 6 | `Video.shape`/`fps` getter-only | ✅ Fixed | v0.2.0 PR #45 |
| 7 | `Point.score` missing from base type | ✅ Fixed | v0.2.0 PR #45 |
| 8 | Browser bundler stubs required | ✅ Fixed | v0.2.1 |
| 9 | `PredictedInstance` duck-typing | ✅ Fixed | v0.2.1 |
