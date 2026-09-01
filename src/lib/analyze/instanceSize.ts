/**
 * Facade over {@link bboxSize} that walks a `Labels` object and produces a flat
 * list of instance sizes tagged with navigation refs (video / frame / instance
 * index), for the Instance Size Distribution dialog. The pure math lives in
 * instanceSizeCore.ts; this layer is the only part that touches sleap-io objects.
 */
import type { Labels, Video } from "@/types";
import { bboxSize } from "@/lib/analyze/instanceSizeCore";

export interface SizedInstance {
  /** max(w, h) of the instance's visible points (the un-rotated "raw" size). */
  size: number;
  /** Bounding-box width of the visible points. */
  rawWidth: number;
  /** Bounding-box height of the visible points. */
  rawHeight: number;
  video: Video;
  /** Index of `video` in `labels.videos` (for setVideo/navigation). */
  videoIdx: number;
  frameIdx: number;
  /** Index of the instance within its labeled frame's `instances`. */
  instanceIdx: number;
}

/**
 * Every instance in `labels` with at least one visible point, as a flat
 * `SizedInstance[]` (instances with no finite coordinate are skipped, but the
 * surviving instances keep their original within-frame index for selection).
 */
export function collectSizedInstances(labels: Labels): SizedInstance[] {
  const out: SizedInstance[] = [];
  const videos = labels.videos;
  for (let v = 0; v < videos.length; v++) {
    const video = videos[v];
    for (const lf of labels.find({ video })) {
      let i = 0;
      for (const inst of lf.instances) {
        const box = bboxSize(inst.numpy());
        if (box) {
          out.push({
            size: box.size,
            rawWidth: box.w,
            rawHeight: box.h,
            video,
            videoIdx: v,
            frameIdx: lf.frameIdx,
            instanceIdx: i,
          });
        }
        i++;
      }
    }
  }
  return out;
}
