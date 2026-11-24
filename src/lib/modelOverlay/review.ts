/**
 * Compare model predictions — the review window's data: what one
 * disagreement looks like ({@link reviewGroupsOnFrame}), how decisions are
 * keyed, where to crop, and the project's own instances to draw underneath.
 * Pure; the window is components/video/compareReview/CompareReviewWindow.tsx.
 */
import type { Labels, Video } from "@/types";
import { Instance } from "@talmolab/sleap-io.js";
import type { OverlayModel } from "@/stores/modelOverlayStore";
import { groupAcrossModels, meanNodeDistance, nodeSpreads, type MatchLayer } from "./matching";

/** One model's pose in a disagreement. */
export interface ReviewMember {
  modelId: string;
  /** Index of the pose in that model's poses on the frame (what Accept takes). */
  poseIdx: number;
  xy: Float64Array;
  score: number | null;
  trackName: string | null;
  /** Mean distance of this pose's nodes from the consensus, px. */
  distance: number;
}

/** One animal on one frame where two or more models placed it and they disagree. */
export interface ReviewGroup {
  frame: number;
  /** Group number on the frame (stable for the same models). */
  group: number;
  members: ReviewMember[];
  /** Mean position per node over the models (NaN where none placed it). */
  consensus: Float64Array;
  /** Spread per node, px (NaN where fewer than two models placed it). */
  spread: Float64Array;
  /** Nodes above the threshold, largest spread first. */
  flagged: number[];
  maxSpread: number;
  /** A track name the members agree on, if any. */
  trackName: string | null;
}

/**
 * Key for remembering a decision on an item: its frame and exactly which
 * model poses make it up. A group's number on the frame isn't stable (hiding
 * a model renumbers the animals), so a decision keyed by it could move to a
 * different animal; with this key a changed item simply has no decision yet.
 */
export function reviewItemKey(item: Pick<ReviewGroup, "frame" | "members">): string {
  return `${item.frame}|${item.members
    .map((m) => `${m.modelId}#${m.poseIdx}`)
    .sort()
    .join(",")}`;
}

/**
 * The disagreements on one frame: each animal placed by two or more shown
 * models with at least one node above `threshold`, largest spread first.
 */
export function reviewGroupsOnFrame(
  shown: readonly OverlayModel[],
  frame: number,
  byTrack: boolean,
  threshold: number
): ReviewGroup[] {
  const present = shown.filter((m) => (m.frames.get(frame)?.length ?? 0) > 0);
  if (present.length < 2) return [];
  const layers: MatchLayer[] = present.map((m) => ({ poses: m.frames.get(frame) ?? [] }));
  const out: ReviewGroup[] = [];
  groupAcrossModels(layers, byTrack).forEach((g, gi) => {
    if (new Set(g.map((m) => m.layer)).size < 2) return;
    const { mean, spread } = nodeSpreads(layers, g);
    const flagged: number[] = [];
    let maxSpread = -Infinity;
    for (let k = 0; k < spread.length; k++) {
      if (Number.isFinite(spread[k]) && spread[k] > threshold) flagged.push(k);
      if (spread[k] > maxSpread) maxSpread = spread[k];
    }
    if (flagged.length === 0) return;
    flagged.sort((a, b) => spread[b] - spread[a]);
    const members = g.map((mem) => {
      const p = layers[mem.layer].poses[mem.pose];
      return {
        modelId: present[mem.layer].id,
        poseIdx: mem.pose,
        xy: p.xy,
        score: p.score,
        trackName: p.trackName,
        distance: meanNodeDistance(p.xy, mean),
      };
    });
    const tracks = new Set(members.map((m) => m.trackName));
    out.push({
      frame,
      group: gi,
      members,
      consensus: mean,
      spread,
      flagged,
      maxSpread,
      trackName: tracks.size === 1 ? [...tracks][0] : null,
    });
  });
  return out.sort((a, b) => b.maxSpread - a.maxSpread);
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A square-ish crop around every placed node of `poses`, padded by `padFrac`
 * of its size (at least `minSize` px), kept inside the frame when its size is
 * known.
 */
export function cropAround(
  poses: readonly Float64Array[],
  frameW: number | null,
  frameH: number | null,
  padFrac = 0.6,
  minSize = 96
): Rect | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const xy of poses) {
    for (let i = 0; i + 1 < xy.length; i += 2) {
      if (!Number.isFinite(xy[i]) || !Number.isFinite(xy[i + 1])) continue;
      x0 = Math.min(x0, xy[i]);
      y0 = Math.min(y0, xy[i + 1]);
      x1 = Math.max(x1, xy[i]);
      y1 = Math.max(y1, xy[i + 1]);
    }
  }
  if (x1 < x0) return null;
  const size = Math.max(minSize, Math.max(x1 - x0, y1 - y0) * (1 + 2 * padFrac));
  let x = (x0 + x1) / 2 - size / 2;
  let y = (y0 + y1) / 2 - size / 2;
  let w = size;
  let h = size;
  if (frameW) {
    w = Math.min(w, frameW);
    x = Math.max(0, Math.min(x, frameW - w));
  }
  if (frameH) {
    h = Math.min(h, frameH);
    y = Math.max(0, Math.min(y, frameH - h));
  }
  return { x, y, w, h };
}

/** Red rings for an item: the flagged nodes at the consensus, radius = spread. */
export function itemRings(item: ReviewGroup): { x: number; y: number; r: number }[] {
  return item.flagged
    .map((k) => ({ x: item.consensus[2 * k], y: item.consensus[2 * k + 1], r: item.spread[k] }))
    .filter((r) => Number.isFinite(r.x) && Number.isFinite(r.y));
}

/** One of the project's own instances, for drawing under the models in the review crops. */
export interface ProjectPose {
  xy: Float64Array;
  /** A prediction already in the project (dashed), not one of your instances (solid). */
  predicted: boolean;
}

/** The project's instances on `frame` of `video`, as `[x, y, …]` in `nodeNames` order. */
export function projectPosesOnFrame(
  labels: Labels | null,
  video: Video | null,
  frame: number,
  nodeNames: readonly string[]
): ProjectPose[] {
  if (!labels || !video) return [];
  const out: ProjectPose[] = [];
  for (const lf of labels.labeledFrames) {
    if (lf.video !== video || lf.frameIdx !== frame) continue;
    for (const inst of lf.instances) {
      const names = inst.skeleton.nodes.map((n) => n.name);
      const pts = inst.numpy({ invisibleAsNaN: true });
      const xy = new Float64Array(nodeNames.length * 2).fill(NaN);
      nodeNames.forEach((n, i) => {
        const j = names.indexOf(n);
        if (j >= 0 && Number.isFinite(pts[j]?.[0]) && Number.isFinite(pts[j]?.[1])) {
          xy[2 * i] = pts[j][0];
          xy[2 * i + 1] = pts[j][1];
        }
      });
      out.push({ xy, predicted: inst.constructor !== Instance });
    }
  }
  return out;
}
