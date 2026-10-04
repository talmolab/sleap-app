/**
 * Builds the labels payload sent for a "this window" remote training run
 * (PR3, docs/plans/2026-10-04-connect-pr3-detailed-plan.md §3a.4) — as
 * opposed to the "a file on the worker" alternative, which just sends a
 * worker-side path and never touches this module.
 *
 * Per-video, selective embedding: a video the worker can already see (per
 * `remoteVisibility.checkVideoVisibility`) is re-pointed to its worker-side
 * path and sent by reference; a video the worker can't see is embedded (its
 * *labeled* frames' pixels only — never the full video, see
 * `saveSlpToBytes`'s `embed` modes) so training still has pixels to learn
 * from. One `.slp` can mix both per sleap-io.js's `planEmbedding`: a video
 * whose `backend == null` is never newly embedded and keeps its `filename`
 * reference (see the spike note in the plan above).
 */
import { saveSlpToBytes, type Labels } from "@talmolab/sleap-io.js";
import { detectPrefixDiff, translatePath } from "@/lib/pathMappings";
import type { VideoVisibility } from "@/lib/remoteVisibility";

// Warn/block thresholds for inline-embedded `labels_content` (labeled
// frames' pixel data, sent when the worker can't see one or more original
// videos). Sized off real measured embedded-frame costs (~250-450 KB/frame
// at current PNG encoding — see the io PNG-bloat finding, item 0.7, still
// unfixed) against a typical 100-200-frame labeled session (SLEAP's own
// recommended range): that lands around 30-70 MB, so WARN stays silent for
// ordinary sessions and only nags on genuinely large ones. HARD_CAP is kept
// comfortably under the worker's websockets `max_size` (256 MiB,
// `sleap_rtc/protocol_v1/server.py`) after base64's ~4/3 inflation — if
// these two ever need to change, change them together.
export const LABELS_EMBED_WARN_BYTES = 10 * 1024 * 1024; // 10 MB
export const LABELS_EMBED_HARD_CAP_BYTES = 150 * 1024 * 1024; // 150 MB

/** Chunked bytes→base64 (matches collectDiagnostics.ts's own `toBase64`) —
 * avoids a single `String.fromCharCode(...bytes)` call blowing the call stack
 * on anything but tiny arrays. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export interface LabelsPayload {
  labelsContent: string;
  bytes: number;
  /** Indices (into `labels.videos`) of hidden videos whose labeled frames got embedded. */
  embeddedVideos: number[];
  /** Indices of hidden videos with no backend at all — no pixels available to embed; the caller should warn. */
  unavailableVideos: number[];
}

/**
 * Builds the base64 `.slp` payload for a "this window" remote training
 * submission. Never mutates `labels` — everything happens on `labels.copy()`
 * (which itself has no backends; see sleap-io.js's `Labels.copy()`).
 */
/**
 * The worker-side filename for a visible video. Visibility is checked on the
 * first file only, so an image sequence (`string[]`) gets the same location
 * change applied to every frame file: the prefix rule inferred from its first
 * file, falling back to swapping the first file's directory.
 */
function retargetFilename(original: string | string[], workerFirst: string): string | string[] {
  if (typeof original === "string") return workerFirst;
  const first = original[0];
  const dir = (p: string) => p.slice(0, Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")));
  const rule = detectPrefixDiff(first, workerFirst) ?? { local: dir(first), worker: dir(workerFirst) };
  return original.map((p, i) => (i === 0 ? workerFirst : (translatePath(p, [rule]) ?? p)));
}

export async function buildRemoteLabelsPayload(
  labels: Labels,
  visibility: VideoVisibility[],
  opts: { embedFramesToPredict: boolean },
): Promise<LabelsPayload> {
  const copy = labels.copy();
  let hiddenCount = 0;
  const embeddedVideos: number[] = [];
  const unavailableVideos: number[] = [];

  copy.videos.forEach((nv, i) => {
    const vis = visibility[i];
    if (vis?.visible) {
      // Re-point to the worker-side path and drop the backend so
      // `saveSlpToBytes` treats it as external (never newly embeds it).
      nv.filename = retargetFilename(nv.filename, vis.worker as string);
      nv.backend = null;
      // Gotcha: an existing `backendMetadata.filename` wins over `filename`
      // on write — clear it too, or the stale local path would ride along.
      if (nv.backendMetadata) {
        (nv.backendMetadata as Record<string, unknown>).filename = nv.filename;
      }
    } else {
      // Hidden: keep the original local filename/backend so the worker
      // never sees (and never needs) a worker-side path for it. Only a
      // video with a live backend has pixels to embed.
      hiddenCount++;
      const original = labels.videos[i];
      nv.backend = original.backend;
      if (!original.backend) {
        unavailableVideos.push(i);
      } else {
        embeddedVideos.push(i);
      }
    }
  });

  // "all"/"all+suggestions" is requested whenever ANY video is hidden, even
  // one with no backend to actually embed (planEmbedding, sleap-io.js, skips
  // a backend-less video regardless of the mode — it just keeps riding on
  // its unfixable local filename, which is exactly what `unavailableVideos`
  // is for the caller to warn about).
  const embed: boolean | string =
    hiddenCount === 0 ? false : opts.embedFramesToPredict ? "all+suggestions" : "all";
  const bytes = await saveSlpToBytes(copy, { embed });

  return {
    labelsContent: bytesToBase64(bytes),
    bytes: bytes.byteLength,
    embeddedVideos,
    unavailableVideos,
  };
}
