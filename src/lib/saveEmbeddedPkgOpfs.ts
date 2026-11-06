/**
 * Browser large-file save for an already-embedded pkg.slp, via the OPFS
 * streaming writer (issue #226 / OPFS browser-save Step 3).
 *
 * The in-memory browser save (`saveSlpToBytes`) builds the whole file — including
 * every embedded image — in the ~4 GB wasm heap before a byte reaches disk, so a
 * large embedded `.pkg.slp` cannot be saved that way. This path mirrors the
 * desktop streaming writer (`saveEmbeddedPkgStreaming`) but for the browser:
 *
 *   1. Build the small structure (labels/metadata, NO embedded images) in memory.
 *   2. In a Worker, seed an OPFS file with that structure and copy the big
 *      `video{i}/video` image datasets straight from the SOURCE file (the file
 *      the user opened, read on demand via WORKERFS) into the OPFS file — never
 *      materializing the images in the wasm heap. Uses an OPFS sync-access handle,
 *      so it needs NO SharedArrayBuffer / cross-origin isolation.
 *   3. Stream the finished OPFS file into the user's chosen destination.
 *
 * USER-GESTURE ORDERING: `showSaveFilePicker` requires transient activation,
 * which the slow build in step 2 would consume. So the caller picks the
 * destination FIRST (via {@link pickSlpSaveDestination}, synchronously off the
 * save keystroke) and passes the handle in here; the build + stream then run with
 * no further gesture requirement.
 *
 * SCOPE: re-save / Save As of an ALREADY-embedded pkg.slp
 * ({@link saveEmbeddedPkgOpfs}), and Export Labels Package of continuous videos
 * ({@link exportNewPkgOpfs}: frames are read here and PNG-encoded + appended by
 * the writer's worker, io `appendEncodedVideos`). Chromium only (needs
 * `showSaveFilePicker`); Firefox/Safari fall back to the in-memory save until a
 * service-worker streamed download lands.
 */

import {
  StreamingH5Writer,
  saveSlpStructureToBytes,
  buildSerializableEmbedPlan,
  appendEncodedVideos,
} from "@talmolab/sleap-io.js";
import type { EmbedOption, Labels, SlpWriteOptions } from "@talmolab/sleap-io.js";

// Same derivation as loadProject.ts / saveEmbeddedPkgStreaming.ts: h5wasm served
// same-origin (works with or without cross-origin isolation).
const H5WASM_URL =
  typeof location !== "undefined"
    ? `${location.origin}/h5wasm/h5wasm.js`
    : undefined;

/**
 * True if the runtime can back the OPFS streaming save AND deliver it to disk:
 * a secure context with OPFS, Workers, and the File System Access save picker
 * (Chromium). Firefox/Safari lack `showSaveFilePicker`, so they use the
 * in-memory save until a streamed-download export lands.
 */
export function isOpfsSaveSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.storage &&
    typeof navigator.storage.getDirectory === "function" &&
    typeof Worker !== "undefined" &&
    typeof window !== "undefined" &&
    "showSaveFilePicker" in window
  );
}

/**
 * Prompt for the save destination. MUST be called synchronously off the user's
 * save gesture (keystroke / click) — before the slow OPFS build — because
 * `showSaveFilePicker` requires transient activation. Throws
 * `DOMException("AbortError")` if the user cancels.
 */
export async function pickSlpSaveDestination(
  saveName: string
): Promise<FileSystemFileHandle> {
  const picker = (
    window as unknown as {
      showSaveFilePicker: (opts: unknown) => Promise<FileSystemFileHandle>;
    }
  ).showSaveFilePicker;
  return picker({
    types: [
      {
        description: "SLEAP Labels",
        accept: { "application/octet-stream": [".slp"] },
      },
    ],
    suggestedName: saveName,
  });
}

/**
 * Stream-save `labels` (an already-embedded pkg.slp) into the pre-acquired
 * `destHandle`, reading embedded images from `sourceFile` (the opened file) via
 * the OPFS writer. Returns the saved file name. Throws on any failure.
 */
export async function saveEmbeddedPkgOpfs(
  labels: Labels,
  source: FileSystemFileHandle | File,
  destHandle: FileSystemFileHandle,
  onProgress?: (done: number, total: number) => void
): Promise<string> {
  // Re-read the source FRESH: a File snapshot captured at open time may be stale
  // by now (the native Save dialog stole focus, time elapsed, or it lives on a
  // network volume) → WORKERFS readAsArrayBuffer would throw "permission problems
  // ... after a reference to a file was acquired". A FileSystemFileHandle re-reads
  // the current bytes; a bare File is used as-is (best effort).
  const sourceFile = "getFile" in source ? await source.getFile() : source;

  // 1. Small structure (labels/metadata, no embedded images).
  const structureBytes = await saveSlpStructureToBytes(labels, { embed: false });

  // Plan the raw-copy of already-embedded images. Throws if any video would need
  // the encode (new-embed) path — out of scope for this re-save writer.
  const plan = await buildSerializableEmbedPlan(labels, false, sourceFile.name);

  const opfsPath = newOpfsPath();

  // 2. Build the file into OPFS: seed the structure, then copy image datasets
  //    from the source (WORKERFS) into OPFS (sync-handle device), in the Worker.
  const writer = new StreamingH5Writer();
  try {
    await writer.openAppendOpfs(
      opfsPath,
      sourceFile,
      structureBytes,
      sourceFile.name,
      H5WASM_URL
    );
    if (plan.entries.length > 0) {
      const res = await writer.appendEmbeddedVideos(plan.entries, onProgress);
      if (res.success !== true) {
        throw new Error(
          `saveEmbeddedPkgOpfs: appendEmbeddedVideos failed: ${
            res.error ?? JSON.stringify(res)
          }`
        );
      }
    }
  } finally {
    await writer.close().catch(() => {});
  }

  // 3. Stream the OPFS file into the user's chosen destination.
  return publishOpfsFile(opfsPath, destHandle);
}

/**
 * Export a NEW labels package (Export Labels Package of continuous videos, e.g.
 * an mp4 project) into the pre-acquired `destHandle`, the same way as
 * {@link saveEmbeddedPkgOpfs}: the small structure is seeded into an OPFS file,
 * then each embedded frame is read here (an mp4 decodes in its own worker) and
 * PNG-encoded + appended by the writer's worker, so the window stays responsive
 * and only a few frames are in memory at a time. Finally the OPFS file is
 * streamed into `destHandle`. Returns the saved file name.
 *
 * `onProgress` returning `false` cancels (io throws `ExportCancelled`); the
 * staging file is removed on any failure, and the destination is left as the
 * picker made it (an empty new file is removed).
 */
export async function exportNewPkgOpfs(
  labels: Labels,
  destHandle: FileSystemFileHandle,
  options: { embed: EmbedOption; onProgress?: SlpWriteOptions["onProgress"] }
): Promise<string> {
  const structureBytes = await saveSlpStructureToBytes(labels, { embed: options.embed });
  const plan = await buildSerializableEmbedPlan(labels, options.embed, "", {
    allowEncode: true,
  });

  const opfsPath = newOpfsPath();
  try {
    // 1. Seed the OPFS file with the structure.
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(opfsPath, { create: true });
    const seed = await fh.createWritable();
    await seed.write(structureBytes as Uint8Array<ArrayBuffer>);
    await seed.close();

    // 2. Append the frames: open it non-truncating and stream them in.
    if (plan.encodeEntries.length > 0) {
      const writer = new StreamingH5Writer();
      try {
        await writer.openWriteOpfs(opfsPath, structureBytes.byteLength, H5WASM_URL);
        await appendEncodedVideos(writer, labels, plan.encodeEntries, {
          onProgress: options.onProgress,
        });
      } finally {
        await writer.close().catch(() => {});
      }
    }
  } catch (err) {
    await removeOpfsFile(opfsPath);
    await removeIfEmpty(destHandle);
    throw err;
  }

  // 3. Stream the OPFS file into the user's chosen destination.
  return publishOpfsFile(opfsPath, destHandle);
}

function newOpfsPath(): string {
  return `sleap-save-${Date.now()}-${Math.random().toString(16).slice(2)}.slp`;
}

/**
 * Stream the finished OPFS file into the user's chosen destination (no
 * whole-file buffer), then clean up the OPFS staging file.
 */
async function publishOpfsFile(
  opfsPath: string,
  destHandle: FileSystemFileHandle
): Promise<string> {
  try {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(opfsPath, { create: false });
    const file = await fh.getFile();
    const writable = await destHandle.createWritable();
    await file.stream().pipeTo(writable as unknown as WritableStream<Uint8Array>);
    return destHandle.name;
  } finally {
    await removeOpfsFile(opfsPath);
  }
}

/**
 * Chromium creates the picked file (empty) when the picker closes; remove it
 * when nothing was written, so a cancelled export leaves no empty package.
 * A file that already had content is never touched.
 */
async function removeIfEmpty(handle: FileSystemFileHandle): Promise<void> {
  try {
    const file = await handle.getFile();
    const removable = handle as FileSystemFileHandle & { remove?: () => Promise<void> };
    if (file.size === 0 && typeof removable.remove === "function") await removable.remove();
  } catch {
    // best-effort cleanup
  }
}

async function removeOpfsFile(opfsPath: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(opfsPath);
  } catch {
    // best-effort cleanup
  }
}
