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
import { longestSkeletonChain, chainOrderStats } from "@/lib/analyze/labelQcGeometry";
import {
  buildChiralityModel,
  chiralityWrongFraction,
  inferSymmetryPairsByName,
  type ChiralityModel,
} from "@/lib/analyze/labelQcChirality";

export type QcIssueKind =
  | "duplicate"
  | "incomplete_frame"
  | "negative_frame"
  | "sparse_instance"
  | "empty_instance"
  | "out_of_range"
  | "chain_order"
  | "chirality";

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

type SkeletonLike = {
  symmetries?: { nodes?: Iterable<object> }[];
  nodeNames?: string[];
  nodes?: unknown[];
  index?: (node: object) => number;
};

/** Symmetric node-index pairs of a skeleton: its declared symmetries, else
 *  inferred from L/R node names. */
function skeletonPairs(skel: SkeletonLike): [number, number][] {
  const pairs: [number, number][] = [];
  for (const sym of skel.symmetries ?? []) {
    const members = [...(sym.nodes ?? [])];
    if (members.length === 2 && skel.index) {
      const a = skel.index(members[0]);
      const b = skel.index(members[1]);
      if (a >= 0 && b >= 0 && a !== b) pairs.push([a, b]);
    }
  }
  return pairs.length > 0 ? pairs : inferSymmetryPairsByName(skel.nodeNames ?? []);
}

export function runLabelQc(labels: Labels, opts: QcOptions = {}): QcFinding[] {
  const minVisible = opts.minVisibleNodes ?? 2;
  const findings: QcFinding[] = [];
  const videos = labels.videos;

  // The ordered "chain" for chain-order is derived once per skeleton (the graph
  // diameter); auto-enabled only when the chain is long enough to be meaningful.
  const chainCache = new Map<object, number[]>();
  const chainFor = (
    skel: { edgeIndices?: number[][]; nodes?: unknown[] } | undefined,
  ): number[] => {
    if (!skel) return [];
    let c = chainCache.get(skel);
    if (!c) {
      c = longestSkeletonChain(skel.edgeIndices ?? [], skel.nodes?.length ?? 0);
      chainCache.set(skel, c);
    }
    return c;
  };

  // Chirality needs a per-skeleton fit over ALL instances of that skeleton, so
  // gather them first, then learn the canonical side per symmetric pair.
  const pointsBySkel = new Map<object, number[][][]>();
  for (const video of videos) {
    for (const lf of labels.find({ video })) {
      for (const inst of lf.instances) {
        const skel = (inst as unknown as { skeleton?: object }).skeleton;
        if (!skel) continue;
        let arr = pointsBySkel.get(skel);
        if (!arr) {
          arr = [];
          pointsBySkel.set(skel, arr);
        }
        arr.push(inst.numpy());
      }
    }
  }
  const chiralityBySkel = new Map<object, ChiralityModel | null>();
  for (const [skel, pts] of pointsBySkel) {
    const s = skel as SkeletonLike;
    const pairs = skeletonPairs(s);
    chiralityBySkel.set(
      skel,
      pairs.length > 0 ? buildChiralityModel(pts, pairs, s.nodes?.length ?? 0) : null,
    );
  }

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
            : d.reason === "node_overlap"
              ? `${Math.round(d.overlapRatio * 100)}% of nodes overlap`
              : "one animal split across both";
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

        const skel = (insts[i] as unknown as {
          skeleton?: { edgeIndices?: number[][]; nodes?: unknown[] };
        }).skeleton;
        const chain = chainFor(skel);
        if (chain.length >= 4) {
          const co = chainOrderStats(p, chain);
          if (co.inversionRate >= 0.3 || co.intersectionCount >= 1) {
            findings.push({
              kind: "chain_order",
              message:
                co.intersectionCount >= 1
                  ? `Skeleton chain crosses itself (${co.intersectionCount}×)`
                  : `Nodes out of order along the body (${Math.round(co.inversionRate * 100)}% of turns)`,
              video,
              videoIdx: v,
              frameIdx: lf.frameIdx,
              instanceIdx: i,
            });
          }
        }

        const model = skel ? chiralityBySkel.get(skel) ?? null : null;
        if (model) {
          const { wrongFraction, nPairs } = chiralityWrongFraction(p, model);
          if (nPairs >= 2 && wrongFraction >= 0.5) {
            findings.push({
              kind: "chirality",
              message: `Left/right sides look flipped (${Math.round(wrongFraction * 100)}% of symmetric pairs)`,
              video,
              videoIdx: v,
              frameIdx: lf.frameIdx,
              instanceIdx: i,
            });
          }
        }
      });
    }
  }

  return findings;
}
