/**
 * Label QC facade (Analyze menu, Tier 2). Walks a `Labels` object and applies
 * the pure rules in labelQcRules.ts, producing a flat list of findings tagged
 * with navigation refs (video / frame / instance). This is the only layer that
 * touches sleap-io objects; all thresholds/logic live in the tested core.
 */
import type { Labels, Video } from "@/types";
import {
  detectDuplicates,
  isNegativeFrameWithInstances,
  medianCount,
  isIncompleteFrame,
  isSparseInstance,
  isEmptyInstance,
  visibleNodeCount,
  hasOutOfRangePoints,
} from "@/lib/analyze/labelQcRules";

export type QcIssueKind =
  | "duplicate"
  | "incomplete_frame"
  | "negative_frame"
  | "sparse_instance"
  | "empty_instance"
  | "out_of_range";

export interface QcFinding {
  kind: QcIssueKind;
  /** Human-readable description for the results table. */
  message: string;
  video: Video;
  videoIdx: number;
  frameIdx: number;
  /** Present for instance-level findings (and duplicates, anchored to the first). */
  instanceIdx?: number;
}

export interface QcOptions {
  /** Instances with fewer than this many visible nodes are "sparse". Default 2. */
  minVisibleNodes?: number;
}

export function runLabelQc(labels: Labels, opts: QcOptions = {}): QcFinding[] {
  const minVisible = opts.minVisibleNodes ?? 2;
  const findings: QcFinding[] = [];
  const videos = labels.videos;

  for (let v = 0; v < videos.length; v++) {
    const video = videos[v];
    const frames = [...labels.find({ video })];

    // Per-video expected instance count = median over labeled frames.
    const expected = medianCount(frames.map((f) => f.instances.length));

    // Frame bounds for out-of-range (video.shape = [frames, height, width, channels]).
    const shape = (video as unknown as { shape: number[] | null }).shape;
    const height = shape ? shape[1] : null;
    const width = shape ? shape[2] : null;

    for (const lf of frames) {
      const insts = lf.instances;
      const count = insts.length;
      const isNegative = Boolean((lf as unknown as { isNegative?: boolean }).isNegative);

      if (isNegativeFrameWithInstances(isNegative, count)) {
        findings.push({
          kind: "negative_frame",
          message: `Negative (background) frame still has ${count} instance(s)`,
          video,
          videoIdx: v,
          frameIdx: lf.frameIdx,
        });
      } else if (Number.isFinite(expected) && isIncompleteFrame(count, expected)) {
        findings.push({
          kind: "incomplete_frame",
          message: `${count} instance(s); expected ~${expected} for this video`,
          video,
          videoIdx: v,
          frameIdx: lf.frameIdx,
        });
      }

      const pts = insts.map((inst) => inst.numpy());

      for (const d of detectDuplicates(pts)) {
        const detail =
          d.reason === "iou"
            ? `IoU ${d.iou.toFixed(2)}`
            : `${Math.round(d.overlapRatio * 100)}% of nodes overlap`;
        findings.push({
          kind: "duplicate",
          message: `Instances ${d.indexA + 1} & ${d.indexB + 1} look duplicated (${detail})`,
          video,
          videoIdx: v,
          frameIdx: lf.frameIdx,
          instanceIdx: d.indexA,
        });
      }

      pts.forEach((p, i) => {
        if (isEmptyInstance(p)) {
          findings.push({
            kind: "empty_instance",
            message: "Instance has no visible nodes",
            video,
            videoIdx: v,
            frameIdx: lf.frameIdx,
            instanceIdx: i,
          });
        } else if (isSparseInstance(p, minVisible)) {
          findings.push({
            kind: "sparse_instance",
            message: `Only ${visibleNodeCount(p)} visible node(s)`,
            video,
            videoIdx: v,
            frameIdx: lf.frameIdx,
            instanceIdx: i,
          });
        }
        if (width !== null && height !== null && hasOutOfRangePoints(p, width, height)) {
          findings.push({
            kind: "out_of_range",
            message: "Instance has point(s) outside the frame",
            video,
            videoIdx: v,
            frameIdx: lf.frameIdx,
            instanceIdx: i,
          });
        }
      });
    }
  }

  return findings;
}
