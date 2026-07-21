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
 * DATA SAFETY: never writes in place. The file is built AND independently
 * verified in a STAGE temp file (see below), and the original `sourcePath` is
 * opened read-only (via the native range reader) and never touched. Only after
 * the stage file is verified (reopened via the range READER — a path completely
 * separate from the writer's own bookkeeping) is it published over `destPath`.
 * Any failure before that final atomic rename leaves the original file at
 * `destPath` (if any) untouched, and best-effort DELETES every temp/stage file
 * so a partial file can never be mistaken for a valid save.
 *
 * NETWORK-SHARE PERF (local-temp staging): the writer does MANY small ops
 * (per-blob reads, windowed writes, scattered HDF5 metadata seeks). Over an SMB
 * mount each op is a latency-bound network round-trip, so building directly on
 * the share is pathologically slow (~6 MB/s). Instead we build + verify the
 * stage file on a DISK-BACKED local dir (the app cache dir — see
 * `localStagePath`; NOT the OS temp dir, which is tmpfs/RAM on many Linux
 * distros), then publish it to the possibly-network destination in ONE
 * sequential bulk copy (throughput-bound). Because a cross-filesystem move is
 * not atomic, the publish sequence is:
 *   build+verify local stage -> copy_file(local stage -> dest-sibling temp on
 *   the DEST filesystem) -> atomic rename(dest-sibling temp -> destPath) ->
 *   delete local stage.
 * If a local dir can't be resolved (or the local volume is full mid-build), we
 * fall back to staging in a dest sibling: build+verify there, then a single
 * same-filesystem atomic rename over `destPath`.
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
  copyFile,
  removeFile,
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

/** Fresh, collision-resistant random suffix for a temp file name. */
function randomSuffix(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Build a fresh, collision-resistant sibling temp path for `destPath` (same
 * filesystem as `destPath`, so a rename over `destPath` is atomic). Exported so
 * the in-memory (small-file) save path can share the same crash-safe
 * write-temp-then-rename pattern (see `saveProject.ts`). */
export function tempPathFor(destPath: string): string {
  return `${destPath}.sleap-tmp-${randomSuffix()}`;
}

/**
 * Build a fresh stage-file path in a genuinely DISK-BACKED local dir for the
 * perf-fix staging file. Prefers the app cache dir, then the app local-data dir
 * — both live under the user's home on real disk on every platform
 * (macOS `~/Library/Caches/<id>`, Windows `%LOCALAPPDATA%\<id>`, Linux
 * `~/.cache/<id>`). We deliberately AVOID the OS temp dir (`tempDir()`): on many
 * Linux distros (systemd default, Fedora/Arch/RHEL9+) `/tmp` is RAM-backed
 * tmpfs, and since streaming only runs for >3 GiB outputs, staging a multi-GB
 * file there would exhaust RAM (OOM/ENOSPC). The `save-staging` subdir is
 * created lazily by the native `write_open` (it `create_dir_all`s the parent),
 * so it need not exist yet. Throws if neither path API resolves — the caller
 * then falls back to dest-sibling staging.
 */
async function localStagePath(): Promise<string> {
  const { appCacheDir, appLocalDataDir, join } = await import("@tauri-apps/api/path");
  let base: string;
  try {
    base = await appCacheDir();
  } catch {
    base = await appLocalDataDir();
  }
  return join(base, "save-staging", `sleap-save-${randomSuffix()}.sleap-tmp`);
}

/**
 * Is `err` an out-of-space error surfaced from the native writer? The native
 * commands wrap `std::io::Error` into their message string, so we sniff the
 * platform variants: ENOSPC (`os error 28`, "No space left on device") on
 * macOS/Linux and ERROR_DISK_FULL (`os error 112`, "not enough space") on
 * Windows. Used to fall back from disk-backed local staging to dest-sibling
 * staging (the destination filesystem — e.g. a large network share — may still
 * have room even when the local staging volume is full).
 */
function isNoSpaceError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /no space left on device|not enough space|disk is full|os error 28|os error 112|ENOSPC/i.test(
    msg
  );
}

/**
 * Best-effort delete of a temp/stage file on failure (and of the local stage
 * on success). Closes any dangling native write handle first — on Windows an
 * open handle blocks deletion, and there is only ever one save (hence one
 * handle) in flight. Never throws; a cleanup failure must not mask the original
 * error, and the original destination is untouched regardless (that invariant
 * only depends on the final atomic rename never having run).
 */
async function removeFileBestEffort(path: string): Promise<void> {
  try {
    await writeClose().catch(() => {});
    await removeFile(path);
  } catch {
    // Best-effort only.
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

  /**
   * Build + verify the file at `stagePath`, then publish it over `destPath`.
   * `stagedLocally` selects the publish strategy: a local (cross-filesystem)
   * stage is bulk-copied into a dest-sibling temp and atomically renamed; a
   * dest-sibling stage is renamed directly (same-fs, atomic). Cleans up its own
   * temp/stage files and rethrows the RAW error on any failure (so the caller
   * can inspect it for a retry) — the original `destPath` is untouched because
   * the final rename never ran.
   */
  const runSave = async (stagePath: string, stagedLocally: boolean): Promise<void> => {
    let stageCreated = false;
    // In local-staging mode, the dest-sibling temp the stage is bulk-copied into
    // before the atomic rename; tracked so a failed rename can clean it up.
    let destTemp: string | null = null;
    try {
      // 1+2. Main-thread structure write: labels graph + videos_json ONLY, no
      // embedded image data. Small (KB-MB), so writing it whole to a byte
      // buffer first (rather than streaming) is fine.
      const structureBytes = await saveSlpStructureToBytes(labels, { embed: embedMode });
      await writeOpen(stagePath);
      stageCreated = true;
      await writeAt(0, structureBytes);
      await writeClose();
      console.log(
        `[saveEmbeddedPkgStreaming] wrote structure (${structureBytes.byteLength} bytes) -> ${stagePath}` +
          (stagedLocally ? " (local stage)" : " (dest-sibling stage)")
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
        await appendEmbeddedVideosToTemp(plan, stagePath, sourcePath);
        await verifyAppendedTemp(plan, stagePath);
      }

      // Publish the verified stage file over destPath. The original destPath is
      // only destroyed by the final atomic rename, which only runs after the
      // stage has been fully written and (if applicable) verified.
      if (stagedLocally) {
        // Cross-filesystem: rename can't move local disk -> the dest fs, so copy
        // the stage into a dest-sibling temp (ONE sequential bulk transfer) and
        // then atomically rename that over destPath (same-fs => atomic).
        destTemp = tempPathFor(destPath);
        await copyFile(stagePath, destTemp);
        await renameFile(destTemp, destPath);
        destTemp = null; // consumed by the rename; nothing left to clean up
        console.log(
          `[saveEmbeddedPkgStreaming] published ${stagePath} -> ${destPath} (bulk copy + atomic rename)`
        );
        await removeFileBestEffort(stagePath); // delete the local stage file
      } else {
        await renameFile(stagePath, destPath);
        console.log(`[saveEmbeddedPkgStreaming] renamed ${stagePath} -> ${destPath}`);
      }
    } catch (err) {
      // Clean up in reverse order of creation. Both are best-effort deletes; the
      // original destPath is untouched because the final rename never ran. A
      // clean slate also lets the caller safely retry with a different stage.
      if (destTemp) {
        await removeFileBestEffort(destTemp);
      }
      if (stageCreated) {
        await removeFileBestEffort(stagePath);
      }
      throw err;
    }
  };

  // Prefer disk-backed local staging (fast per-op, avoids the network round-trip
  // per op); fall back to dest-sibling staging if no local dir resolves. See the
  // module-level NETWORK-SHARE PERF note.
  let localStage: string | null = null;
  try {
    localStage = await localStagePath();
  } catch {
    localStage = null;
  }

  try {
    if (localStage) {
      try {
        await runSave(localStage, true);
        return;
      } catch (err) {
        if (!isNoSpaceError(err)) throw err;
        // The disk-backed local staging volume ran out of space. The destination
        // filesystem (e.g. a large network share) may still have room, so retry
        // once staging directly on it. runSave already cleaned up its partial
        // local stage, so this starts from a clean slate.
        console.warn(
          "[saveEmbeddedPkgStreaming] local staging ran out of space; " +
            "retrying with dest-sibling staging",
          err
        );
        await runSave(tempPathFor(destPath), false);
        return;
      }
    }
    await runSave(tempPathFor(destPath), false);
  } catch (err) {
    throw err instanceof Error
      ? err
      : new Error(`saveEmbeddedPkgStreaming failed: ${String(err)}`);
  }
}
