/**
 * Streaming embedded pkg.slp save (Phase 3 orchestration).
 *
 * Desktop-only save path for a `Labels` whose videos carry embedded images
 * (`video.hasEmbeddedImages`): writes the small "structure" half (labels graph,
 * skeletons, tracks, `videos_json`, etc — no embedded image bytes) on the main
 * thread, then appends the big embedded-image half in a Web Worker straight to
 * disk via the write B-seam (`StreamingH5Writer.openAppend` +
 * `appendEmbeddedVideos`). This avoids ever materializing a many-GB embedded
 * project in the ~4 GB wasm heap.
 *
 * DATA SAFETY: never writes in place. Everything is staged into a sibling temp
 * file; the original `sourcePath` is opened read-only (via the native range
 * reader) and never touched. Only after the temp file is independently
 * verified (reopened via the range READER — a path completely separate from
 * the writer's own bookkeeping) is it atomically renamed over `destPath`. Any
 * failure before that rename leaves the original file at `destPath` (if any)
 * untouched, and best-effort truncates the temp so a partial file can never be
 * mistaken for a valid save.
 */
import {
  saveSlpStructureToBytes,
  buildSerializableEmbedPlan,
  StreamingH5Writer,
  StreamingH5File,
  type RangeSink,
  type RangeSource,
  type Labels,
  type SerializableEmbedPlan,
} from "@talmolab/sleap-io.js";
import {
  writeOpen,
  writeOpenAppend,
  writeAt,
  readAt,
  truncateFile,
  writeClose,
  renameFile,
} from "./nativeWrite";
import { fileSize, readRange } from "./nativeRange";

// Same derivation as loadProject.ts / writeBridgeSpike.ts: h5wasm must be served
// same-origin so the streaming Worker can load it under cross-origin isolation
// (COEP blocks the default cross-origin CDN importScripts).
const H5WASM_URL =
  typeof location !== "undefined" ? `${location.origin}/h5wasm/h5wasm.js` : undefined;

export interface SaveEmbeddedPkgStreamingOptions {
  /** Same semantics as `saveSlpToBytes`'s `embed` option. Defaults to `false`
   * (re-save/preserve: already-embedded videos are auto-preserved without
   * re-encoding). */
  embed?: boolean | string;
}

/** Build a fresh, collision-resistant sibling temp path for `destPath`. */
function tempPathFor(destPath: string): string {
  const suffix =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `${destPath}.sleap-tmp-${suffix}`;
}

/**
 * Best-effort temp cleanup on failure. There is no native delete/unlink command
 * on the write B-seam yet, so this can't remove the file from disk — it
 * reopens (which recreates + truncates via `writeOpen`) and immediately closes
 * it, leaving an empty stub rather than a partial/corrupt file. Never throws;
 * a cleanup failure must not mask the original error.
 */
async function cleanupTempBestEffort(tempPath: string): Promise<void> {
  try {
    await writeOpen(tempPath);
    await writeClose();
  } catch {
    // Best-effort only. The original destination was never touched regardless
    // of whether this cleanup succeeds — that invariant only depends on the
    // rename below never having run.
  }
}

/**
 * Open the temp file in append mode (preserving the structure bytes already
 * written) and stream-copy every planned video's stored embedded images from
 * `sourcePath` into it, via the dual-bridge `StreamingH5Writer`. Always closes
 * both the worker and the native write handle, even on failure.
 */
async function appendEmbeddedVideosToTemp(
  plan: SerializableEmbedPlan,
  tempPath: string,
  sourcePath: string
): Promise<void> {
  await writeOpenAppend(tempPath);
  const writer = new StreamingH5Writer();
  try {
    const destSize = await fileSize(tempPath);
    const sourceSize = await fileSize(sourcePath);

    const destSink: RangeSink = {
      writeAt: (o, b) => writeAt(o, b),
      readAt: (o, l) => readAt(o, l),
      truncate: (l) => truncateFile(l),
      close: () => writeClose(),
    };
    const source: RangeSource = {
      size: sourceSize,
      readRange: (o, l) => readRange(sourcePath, o, l),
    };

    await writer.openAppend(destSink, tempPath, destSize, source, sourcePath, H5WASM_URL);
    const res = await writer.appendEmbeddedVideos(plan.entries);
    if (res.success !== true) {
      throw new Error(
        `saveEmbeddedPkgStreaming: appendEmbeddedVideos failed: ${
          res.error ?? JSON.stringify(res)
        }`
      );
    }
    console.log(
      `[saveEmbeddedPkgStreaming] appended ${plan.entries.length} video(s) ` +
        `(perVideo=${JSON.stringify(res.perVideo)})`
    );
  } finally {
    // Belt-and-suspenders close, mirroring writeBridgeSpike.ts's pattern: close
    // the worker first, then the native handle. Both are best-effort so a
    // "already closed" error on either can't mask a real failure above.
    await writer.close().catch(() => {});
    await writeClose().catch(() => {});
  }
}

/**
 * Independently verify the freshly-appended temp file by REOPENING it via the
 * range reader (`StreamingH5File` / `RangeSource`) — a path completely separate
 * from the writer's own bookkeeping. For every planned entry, asserts the
 * destination's `video{i}/frame_numbers` length matches the number of frames
 * that were supposed to be copied. Throws (rather than returning false) on any
 * mismatch — including the "planned N, wrote 0" case — so the caller's
 * temp-cleanup + no-rename path always runs.
 */
async function verifyAppendedTemp(
  plan: SerializableEmbedPlan,
  tempPath: string
): Promise<void> {
  const size = await fileSize(tempPath);
  const source: RangeSource = {
    size,
    readRange: (o, l) => readRange(tempPath, o, l),
  };
  const reader = new StreamingH5File();
  await reader.openRange(source, { h5wasmUrl: H5WASM_URL });
  try {
    for (const entry of plan.entries) {
      const group = `video${entry.videoIndex}`;
      const meta = await reader.getDatasetMeta(`${group}/frame_numbers`);
      const got = meta.shape[0] ?? 0;
      const expected = entry.frameNumbers.length;
      if (got !== expected) {
        throw new Error(
          `saveEmbeddedPkgStreaming: verify failed for ${group}: ` +
            `frame_numbers has ${got} entries, expected ${expected} ` +
            `(partial/corrupt append — original left untouched)`
        );
      }
    }
  } finally {
    await reader.close().catch(() => {});
  }
}

/**
 * Save `labels` to `destPath`, preserving embedded images already stored in
 * `sourcePath`, without ever materializing the embedded image data in the main
 * thread's wasm heap.
 *
 * Desktop (Tauri) only — requires cross-origin isolation (SharedArrayBuffer)
 * for the write B-seam's Worker bridge. Throws on ANY failure; the original
 * file at `destPath` (if any) is guaranteed untouched up to the point of the
 * final atomic rename, which only happens after the appended data has been
 * independently verified.
 *
 * @param labels Labels to save (already-open embedded video backends).
 * @param destPath Final on-disk destination (may equal `sourcePath` for an
 *   in-place re-save, or a new path for Save As).
 * @param sourcePath On-disk path of the currently-open project file that the
 *   embedded images are copied FROM (read-only).
 * @param options `embed` mirrors `saveSlpToBytes`'s option; defaults to
 *   `false` (re-save/preserve).
 */
export async function saveEmbeddedPkgStreaming(
  labels: Labels,
  destPath: string,
  sourcePath: string,
  options?: SaveEmbeddedPkgStreamingOptions
): Promise<void> {
  if (
    typeof SharedArrayBuffer === "undefined" ||
    !(globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated
  ) {
    throw new Error(
      "saveEmbeddedPkgStreaming requires cross-origin isolation (SharedArrayBuffer " +
        "unavailable) — the caller should only route embedded-pkg saves here when it is " +
        "available."
    );
  }

  const embedMode = options?.embed ?? false;
  const tempPath = tempPathFor(destPath);
  let tempCreated = false;

  try {
    // 1+2. Main-thread structure write: labels graph + videos_json ONLY, no
    // embedded image data. Small (KB-MB), so writing it whole to a byte
    // buffer first (rather than streaming) is fine.
    const structureBytes = await saveSlpStructureToBytes(labels, { embed: embedMode });
    await writeOpen(tempPath);
    tempCreated = true;
    await writeAt(0, structureBytes);
    await writeClose();
    console.log(
      `[saveEmbeddedPkgStreaming] wrote structure (${structureBytes.byteLength} bytes) -> ${tempPath}`
    );

    // Use the SAME embedMode for the plan as for the structure write, so
    // videos_json (which claims which videos are embedded) and the actually
    // appended datasets agree.
    const plan = await buildSerializableEmbedPlan(labels, embedMode, sourcePath);

    if (plan.entries.length === 0) {
      // Nothing to append — the structure IS the whole file.
      console.log(
        "[saveEmbeddedPkgStreaming] no embedded entries to append; structure is the whole file"
      );
    } else {
      await appendEmbeddedVideosToTemp(plan, tempPath, sourcePath);
      await verifyAppendedTemp(plan, tempPath);
    }

    // Atomic replace: the original destPath is only destroyed now, by renaming
    // a fully-written and (if applicable) verified temp file over it.
    await renameFile(tempPath, destPath);
    console.log(`[saveEmbeddedPkgStreaming] renamed ${tempPath} -> ${destPath}`);
  } catch (err) {
    if (tempCreated) {
      await cleanupTempBestEffort(tempPath);
    }
    throw err instanceof Error
      ? err
      : new Error(`saveEmbeddedPkgStreaming failed: ${String(err)}`);
  }
}
