/**
 * Save-path routing for embedded pkg.slp files (desktop/Tauri).
 *
 * A desktop save of a `Labels` whose videos carry embedded images can go one of
 * two ways:
 *
 *  - The in-memory bulk path (`saveSlpToBytes`): materializes the whole file —
 *    including every embedded image blob — in the ~4 GB wasm heap, then writes
 *    it out in one shot. Fast (few large ops) but CAPPED by the wasm heap wall:
 *    a file whose embedded data pushes it past ~4 GB simply cannot be built
 *    this way. Already-embedded frames ARE preserved (auto-raw-copied) even for
 *    a bare `saveSlpToBytes(labels)`, so this path is data-safe for re-saves.
 *
 *  - The streaming writer (`saveEmbeddedPkgStreaming`): copies embedded image
 *    blobs disk→disk through a worker+SharedArrayBuffer bridge, never holding
 *    them in the wasm heap, so it has no size ceiling — but it does MANY small
 *    ops, which is slow over a network share (mitigated separately by local-
 *    temp staging + bulk copy).
 *
 * So: use streaming ONLY when the output would exceed the wasm wall; otherwise
 * prefer the faster in-memory path. This module is the pure decision logic
 * (size estimation is done by the caller, which owns the native file-size
 * probe); keeping it side-effect-free makes it unit-testable without a Tauri
 * runtime.
 *
 * OUTPUT-SIZE ESTIMATION (see caller): the streaming/raw-copy path copies every
 * already-embedded video's stored blobs VERBATIM from the source pkg.slp, and
 * those image blobs dominate the file size (the labels/skeleton/track structure
 * is KB–MB). It never ADDS embedded image data (new-embed is rejected upstream
 * in `buildSerializableEmbedPlan`), so the output's embedded-data bytes are ≤
 * the source's. The output therefore tracks the SOURCE FILE SIZE very closely,
 * and the estimate can only err on the high side (e.g. if some source videos
 * were removed before saving), which is the SAFE direction: over-estimating
 * only routes a save that would have fit in memory to the (always-correct)
 * streaming path. Under-estimating — the dangerous case that would route a
 * >4 GB save to the in-memory path and hit the wall — cannot happen from added
 * image data on this path. The caller passes `estimatedOutputBytes =
 * fileSize(sourcePath)`, or `null` if that probe fails (treated conservatively
 * as "use streaming").
 */

/**
 * Route embedded saves whose estimated output exceeds this to the streaming
 * writer; smaller ones take the faster in-memory path. Set conservatively below
 * the ~4 GB wasm heap wall (leaving >1 GB of headroom for structure growth /
 * estimation slack), so a file that would blow the wall is never sent to the
 * in-memory path.
 */
export const STREAMING_SAVE_THRESHOLD_BYTES = 3 * 1024 * 1024 * 1024; // 3 GiB

/**
 * Decide whether a desktop embedded-pkg save should use the streaming writer.
 *
 * @param isTauri            Running in the desktop (Tauri) runtime.
 * @param hasEmbeddedImages  At least one video carries embedded images.
 * @param hasSourcePath      The currently-open project has an on-disk path to
 *                           copy embedded blobs FROM (required by streaming).
 * @param estimatedOutputBytes Estimated output size in bytes, or `null` when
 *                           unknown (e.g. the file-size probe failed) — treated
 *                           conservatively as "over threshold".
 */
export function shouldStreamEmbeddedSave({
  isTauri,
  hasEmbeddedImages,
  hasSourcePath,
  estimatedOutputBytes,
}: {
  isTauri: boolean;
  hasEmbeddedImages: boolean;
  hasSourcePath: boolean;
  estimatedOutputBytes: number | null;
}): boolean {
  if (!isTauri || !hasEmbeddedImages || !hasSourcePath) return false;
  // Unknown size => be safe and stream (it works for any size, just slower).
  if (estimatedOutputBytes === null) return true;
  return estimatedOutputBytes > STREAMING_SAVE_THRESHOLD_BYTES;
}

/**
 * Decide whether a BROWSER embedded-pkg save should use the OPFS streaming
 * writer instead of the in-memory save. The browser analogue of
 * {@link shouldStreamEmbeddedSave}: same size logic and threshold, but gated on
 * OPFS/`showSaveFilePicker` availability (Chromium) rather than the Tauri
 * runtime, and on having an opened source File/handle to copy images FROM.
 *
 * Small embedded files take the faster in-memory path (`saveSlpToBytes`, which
 * still preserves already-embedded frames); only outputs that would approach the
 * ~4 GB wasm heap wall route to OPFS. The estimate is the source File's `.size`
 * (the raw-copy path never ADDS embedded data, so source size is a close,
 * high-side-safe proxy — see the module header). A `null` estimate is treated
 * conservatively as "over threshold" (stream), matching the desktop path.
 *
 * @param hasEmbeddedImages    At least one video carries embedded images.
 * @param hasSource            The opened project is retained (File/handle) to
 *                             copy embedded blobs FROM (required by the writer).
 * @param isOpfsSupported      OPFS + Worker + `showSaveFilePicker` are available.
 * @param estimatedOutputBytes Estimated output size in bytes, or `null` when
 *                             unknown — treated conservatively as "over
 *                             threshold".
 */
export function shouldOpfsStreamBrowserSave({
  hasEmbeddedImages,
  hasSource,
  isOpfsSupported,
  estimatedOutputBytes,
}: {
  hasEmbeddedImages: boolean;
  hasSource: boolean;
  isOpfsSupported: boolean;
  estimatedOutputBytes: number | null;
}): boolean {
  if (!hasEmbeddedImages || !hasSource || !isOpfsSupported) return false;
  // Unknown size => be safe and stream (it works for any size, just slower).
  if (estimatedOutputBytes === null) return true;
  return estimatedOutputBytes > STREAMING_SAVE_THRESHOLD_BYTES;
}
