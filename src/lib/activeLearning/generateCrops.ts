/**
 * Generate centered-instance crops for active-learning Phase 1 → Phase 2.
 *
 * Crops are **virtual**: each is a windowed `Video` produced by sleap-io.js
 * `Video.crop({center, size})` over the source video (no pixels are copied or
 * re-encoded — the crop is applied at read time by `CropVideoBackend`, and the
 * app already renders these through `cropTransform`). Instance points stay in
 * SOURCE coordinates; the crop transform maps them for display/edit.
 *
 * The crop center is computed the way sleap-nn's top-down cropping does — the
 * configured anchor/centroid node if it's placed, else the midpoint of the
 * bounding box of the instance's visible points — so a previewed crop matches
 * what a centered-instance model would train on. `cropSize` also comes from the
 * same config (`localize.cropSize`).
 *
 * Works identically on hand-seeded (user) or predicted centroids, so the
 * minimal Phase-1 path "seed frames → generate crops" needs no locator model;
 * the trained locator is the scale-up that supplies predicted centroids.
 */

import { Labels, LabeledFrame, Instance } from "@talmolab/sleap-io.js";
import type {
  Video,
  Skeleton,
  Instance as InstanceT,
  PredictedInstance,
} from "@talmolab/sleap-io.js";
import type { ActiveLearningConfig } from "./config";

/** Which instances to crop around. */
export type CropSourceKind = "predicted" | "user" | "all";

export interface GenerateCropsOptions {
  /** Crop side length in px (defaults to `config.localize.cropSize`). */
  cropSize?: number;
  /** Anchor node name (defaults to `config.localize.centroidNode`). */
  anchorNode?: string;
  /** Crop around predicted centroids (default), user instances, or both. */
  from?: CropSourceKind;
}

/** True for a predicted instance (has an instance-level `score`). */
function isPredicted(inst: InstanceT | PredictedInstance): inst is PredictedInstance {
  return inst instanceof Instance && "score" in inst;
}

/**
 * The crop center for an instance: the `anchorNode`'s location if that node is
 * placed and visible, otherwise the midpoint of the bounding box over all
 * visible, finite points. Returns `null` if the instance has no usable points.
 */
export function instanceCropCenter(
  inst: InstanceT | PredictedInstance,
  skeleton: Skeleton,
  anchorNode?: string,
): [number, number] | null {
  const pts = inst.points;

  if (anchorNode) {
    const ai = skeleton.nodes.findIndex((n) => n.name === anchorNode);
    if (ai >= 0 && ai < pts.length) {
      const p = pts[ai];
      if (p.visible && Number.isFinite(p.xy[0]) && Number.isFinite(p.xy[1])) {
        return [p.xy[0], p.xy[1]];
      }
    }
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (!p.visible || !Number.isFinite(p.xy[0]) || !Number.isFinite(p.xy[1])) continue;
    minX = Math.min(minX, p.xy[0]);
    minY = Math.min(minY, p.xy[1]);
    maxX = Math.max(maxX, p.xy[0]);
    maxY = Math.max(maxY, p.xy[1]);
  }
  if (minX === Infinity) return null; // no visible points
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

/**
 * A square crop rect `[x1, y1, x2, y2]` (x2/y2 exclusive) centered on `center`.
 * Rounded to integer pixels, matching sleap-io's `resolveCropRect`. Exposed for
 * testing / previews; the actual crop uses `Video.crop({center, size})`.
 */
export function cropRectForCenter(
  center: [number, number],
  cropSize: number,
): [number, number, number, number] {
  const half = cropSize / 2;
  const x1 = Math.round(center[0] - half);
  const y1 = Math.round(center[1] - half);
  return [x1, y1, x1 + cropSize, y1 + cropSize];
}

export interface GenerateCropsResult {
  /** A new Labels whose videos are virtual crops, one instance (centroid placed) per frame. */
  labels: Labels;
  /** Number of crops generated. */
  count: number;
  /** Instances skipped for having no usable center. */
  skipped: number;
}

/**
 * Build a crop project from `source`. Each qualifying instance becomes a virtual
 * crop `Video` centered on it plus a `LabeledFrame` (at the source frame index)
 * holding a fresh user instance with the anchor node placed and the rest
 * unplaced — ready for Phase-2 keypoint passes.
 */
export function generateCrops(
  source: Labels,
  config: ActiveLearningConfig,
  opts: GenerateCropsOptions = {},
): GenerateCropsResult {
  const cropSize = opts.cropSize ?? config.localize.cropSize;
  const anchorNode = opts.anchorNode ?? config.localize.centroidNode;
  const from = opts.from ?? "predicted";

  const skeleton = source.skeletons[0];
  if (!skeleton) {
    return { labels: new Labels({ skeletons: source.skeletons }), count: 0, skipped: 0 };
  }
  const anchorIdx = skeleton.nodes.findIndex((n) => n.name === anchorNode);

  const cropVideos: Video[] = [];
  const cropFrames: LabeledFrame[] = [];
  let skipped = 0;

  for (const lf of source.labeledFrames) {
    for (const inst of lf.instances) {
      const predicted = isPredicted(inst);
      if (from === "predicted" && !predicted) continue;
      if (from === "user" && predicted) continue;

      const center = instanceCropCenter(inst, skeleton, anchorNode);
      if (!center) {
        skipped++;
        continue;
      }

      const cropVideo = lf.video.crop(null, {
        center,
        size: [cropSize, cropSize],
      });

      // Seed the crop's instance with the anchor point already placed.
      const cropInst = Instance.empty({ skeleton });
      if (anchorIdx >= 0) {
        cropInst.points[anchorIdx].xy = [center[0], center[1]];
        cropInst.points[anchorIdx].visible = true;
        cropInst.points[anchorIdx].complete = true;
      }

      cropVideos.push(cropVideo);
      cropFrames.push(
        new LabeledFrame({ video: cropVideo, frameIdx: lf.frameIdx, instances: [cropInst] }),
      );
    }
  }

  const labels = new Labels({
    labeledFrames: cropFrames,
    videos: cropVideos,
    skeletons: source.skeletons,
  });
  return { labels, count: cropFrames.length, skipped };
}
