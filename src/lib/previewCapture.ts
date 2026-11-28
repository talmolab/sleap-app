/**
 * Best-effort preview frame capture for linked (non-embedded) SLP saves.
 *
 * Captures and caches a single downscaled JPEG preview frame on
 * `labels.previewFrames` so saved `.slp` files include a `/preview` thumbnail
 * (used by macOS Finder Quick Look and file browsers) without re-decoding on
 * subsequent saves in the same session.
 */

import {
  createPreviewFrameFromVideoFrame,
  type Labels,
  type LabeledFrame,
  type Video,
} from "@talmolab/sleap-io.js";

export interface PreviewCaptureContext {
  /** Currently viewed video in the GUI, if any. */
  currentVideo?: Video | null;
  /** Currently viewed frame index in the GUI, if any. */
  currentFrameIdx?: number | null;
}

function frameHasAnnotations(lf: LabeledFrame | undefined | null): boolean {
  if (!lf) return false;
  return (
    lf.instances.length > 0 ||
    lf.bboxes.length > 0 ||
    lf.masks.length > 0 ||
    lf.centroids.length > 0 ||
    lf.rois.length > 0 ||
    lf.labelImages.length > 0
  );
}

function pickCandidate(
  labels: Labels,
  ctx?: PreviewCaptureContext,
): { video: Video; frameIdx: number } | null {
  const openVideos = new Set(
    labels.videos.filter((v) => !v.hasEmbeddedImages && v.backend != null),
  );
  if (openVideos.size === 0) return null;

  // 1. If the user is actively viewing a labeled/annotated frame (or the project
  //    has no labeled frames yet), prefer that frame — it is usually already in
  //    the decoder cache and matches what the user sees on screen.
  const curVid = ctx?.currentVideo ?? null;
  const curIdx = ctx?.currentFrameIdx;
  if (curVid && openVideos.has(curVid) && curIdx != null && curIdx >= 0) {
    if (!labels.isLazy) {
      const curLf = labels.labeledFrames.find(
        (lf) => lf.video === curVid && lf.frameIdx === curIdx,
      );
      if (frameHasAnnotations(curLf) || labels.labeledFrames.length === 0) {
        return { video: curVid, frameIdx: curIdx };
      }
    }
  }

  // 2. Otherwise prefer the first user-labeled frame, then any annotated frame,
  //    then any labeled frame, then current frame or frame 0.
  if (!labels.isLazy) {
    let firstAnnotated: { video: Video; frameIdx: number } | null = null;
    let firstLabeled: { video: Video; frameIdx: number } | null = null;
    for (const lf of labels.labeledFrames) {
      if (!openVideos.has(lf.video) || lf.frameIdx < 0) continue;
      if (lf.userInstances.length > 0) {
        return { video: lf.video, frameIdx: lf.frameIdx };
      }
      if (!firstAnnotated && frameHasAnnotations(lf)) {
        firstAnnotated = { video: lf.video, frameIdx: lf.frameIdx };
      }
      if (!firstLabeled) {
        firstLabeled = { video: lf.video, frameIdx: lf.frameIdx };
      }
    }
    if (firstAnnotated) return firstAnnotated;
    if (firstLabeled) return firstLabeled;
  }

  if (curVid && openVideos.has(curVid) && curIdx != null && curIdx >= 0) {
    return { video: curVid, frameIdx: curIdx };
  }

  const firstOpen = labels.videos.find((v) => openVideos.has(v));
  return firstOpen ? { video: firstOpen, frameIdx: 0 } : null;
}

/**
 * Ensure a non-embedded `Labels` project carries at least one cached
 * `PreviewFrame` before saving. Never throws and never mutates embedded
 * `.pkg.slp` projects or projects that already have preview frames.
 */
export async function ensureProjectPreviewFrame(
  labels: Labels,
  ctx?: PreviewCaptureContext,
): Promise<void> {
  if (
    !Array.isArray(labels.videos) ||
    labels.videos.some((v) => v.hasEmbeddedImages)
  ) {
    return;
  }
  if ((labels.previewFrames?.length ?? 0) > 0) return;

  const candidate = pickCandidate(labels, ctx);
  if (!candidate || !candidate.video.backend) return;

  try {
    const frame = await candidate.video.backend.getFrame(candidate.frameIdx, {
      prefetch: false,
      scrub: true,
    });
    if (!frame) return;
    const pf = await createPreviewFrameFromVideoFrame(
      candidate.video,
      candidate.frameIdx,
      frame,
      {
        channelOrder: candidate.video.backend.embeddedChannelOrder,
        rawShape:
          candidate.video.shape ?? candidate.video.backend.shape ?? undefined,
      },
    );
    labels.previewFrames = [pf];
  } catch {
    // Best-effort: never block or fail a project save if preview decoding fails.
  }
}
