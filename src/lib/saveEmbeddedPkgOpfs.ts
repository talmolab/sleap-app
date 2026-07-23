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
 *      so it needs NO SharedArrayBuffer / cross-origin isolation (works on plain
 *      GitHub Pages).
 *   3. Export the finished OPFS file to the user's chosen location.
 *
 * SCOPE: re-save / Save As of an ALREADY-embedded pkg.slp (the images are copied
 * from the opened source file). Brand-new embedding of fresh video frames is a
 * deferred follow-up (`buildSerializableEmbedPlan` throws for the encode path,
 * which the caller treats as "fall back to the in-memory save").
 */

import {
  StreamingH5Writer,
  saveSlpStructureToBytes,
  buildSerializableEmbedPlan,
} from "@talmolab/sleap-io.js";
import type { Labels } from "@talmolab/sleap-io.js";

// Same derivation as loadProject.ts / saveEmbeddedPkgStreaming.ts: h5wasm served
// same-origin (works with or without cross-origin isolation).
const H5WASM_URL =
  typeof location !== "undefined"
    ? `${location.origin}/h5wasm/h5wasm.js`
    : undefined;

/** True if the runtime can back the OPFS streaming save (secure context + OPFS). */
export function isOpfsSaveSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.storage &&
    typeof navigator.storage.getDirectory === "function" &&
    typeof Worker !== "undefined"
  );
}

/**
 * Stream-save `labels` (an already-embedded pkg.slp) to the user's disk using
 * the OPFS writer, reading embedded images from `sourceFile` (the opened file).
 * Returns the saved file name. Throws `DOMException("AbortError")` if the user
 * cancels the save-location picker; throws any other error so the caller can
 * fall back to the in-memory save.
 */
export async function saveEmbeddedPkgOpfs(
  labels: Labels,
  sourceFile: File,
  saveName: string
): Promise<string> {
  // 1. Small structure (labels/metadata, no embedded images).
  const structureBytes = await saveSlpStructureToBytes(labels, { embed: false });

  // Plan the raw-copy of already-embedded images. Throws if any video would need
  // the encode (new-embed) path — the caller catches that and falls back.
  const plan = await buildSerializableEmbedPlan(labels, false, sourceFile.name);

  const opfsPath = `sleap-save-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}.slp`;

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
      const res = await writer.appendEmbeddedVideos(plan.entries);
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

  // 3. Publish the OPFS file to the user's chosen destination, then clean up.
  try {
    return await exportOpfsFileToDisk(opfsPath, saveName);
  } finally {
    await removeOpfsFile(opfsPath);
  }
}

/**
 * Copy the OPFS-staged file to the user's real disk WITHOUT loading it all into
 * memory. Chromium: `showSaveFilePicker` + a streamed pipe. Firefox/Safari: an
 * anchor download (RAM-bounded — a service-worker streamed download is the
 * multi-GB-safe follow-up).
 */
async function exportOpfsFileToDisk(
  opfsPath: string,
  saveName: string
): Promise<string> {
  const root = await navigator.storage.getDirectory();
  const fh = await root.getFileHandle(opfsPath, { create: false });
  const file = await fh.getFile();

  const picker = (
    window as unknown as {
      showSaveFilePicker?: (opts: unknown) => Promise<FileSystemFileHandle>;
    }
  ).showSaveFilePicker;

  if (picker) {
    const handle = await picker({
      types: [
        {
          description: "SLEAP Labels",
          accept: { "application/octet-stream": [".slp"] },
        },
      ],
      suggestedName: saveName,
    });
    const writable = await handle.createWritable();
    // Stream the OPFS file to disk in chunks — never a whole-file buffer.
    await file.stream().pipeTo(writable as unknown as WritableStream<Uint8Array>);
    return handle.name;
  }

  // Fallback (Firefox/Safari): anchor download. NOTE: this reads the file through
  // a blob URL and is not multi-GB-safe; the streamed-download (service worker)
  // path is the follow-up for those browsers.
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = saveName;
  a.click();
  URL.revokeObjectURL(url);
  return saveName;
}

async function removeOpfsFile(opfsPath: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(opfsPath);
  } catch {
    // best-effort cleanup
  }
}
