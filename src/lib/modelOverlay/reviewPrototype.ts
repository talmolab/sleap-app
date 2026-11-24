/**
 * Compare model predictions — review-window PROTOTYPES (dev builds only).
 *
 * Three candidate layouts for reviewing the frames where the models disagree
 * (a stepper, side-by-side panes per model, a grid of crops) live behind a dev
 * switch so they can be tried in the real app before one is picked. None is
 * the default and the corner panel is unchanged. This module is the pure part
 * they share: the switch, what one disagreement looks like ({@link
 * reviewGroupsOnFrame}), where to crop, and mock models to try them with on
 * any project.
 *
 * Switch: open the app with `?reviewUi=stepper|panes|grid` (or `?reviewUi=1`),
 * or in the devtools console
 * `localStorage.setItem("sleap.dev.compareReviewUi", "1"); location.reload()`.
 * `?reviewUi=off` turns it off again.
 */
import type { Labels, Skeleton, Video } from "@/types";
import { Instance } from "@talmolab/sleap-io.js";
import type { OverlayModel, NewOverlayModel } from "@/stores/modelOverlayStore";
import { groupAcrossModels, meanNodeDistance, nodeSpreads, type MatchLayer } from "./matching";
import { PoseStoreBuilder } from "./poseStore";
import { MOCK_SOURCE_PREFIX, videoDims } from "./core";

export { MOCK_SOURCE_PREFIX };

export type ReviewLayout = "stepper" | "panes" | "grid";
export const REVIEW_LAYOUTS: readonly ReviewLayout[] = ["stepper", "panes", "grid"];
export const REVIEW_LAYOUT_NAMES: Record<ReviewLayout, string> = {
  stepper: "A · Stepper",
  panes: "B · Side by side",
  grid: "C · Crop grid",
};

export const REVIEW_SWITCH_KEY = "sleap.dev.compareReviewUi";

/**
 * Whether the prototypes are switched on, and which layout to open first.
 * `search` is `location.search`; a value there is remembered in `storage`, so
 * the Tauri window (no address bar) keeps it after a reload.
 */
export function readReviewSwitch(
  search: string,
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null
): { on: boolean; layout: ReviewLayout } {
  const param = new URLSearchParams(search).get("reviewUi");
  try {
    if (param === "off" || param === "0") storage?.removeItem(REVIEW_SWITCH_KEY);
    else if (param !== null) storage?.setItem(REVIEW_SWITCH_KEY, param || "1");
  } catch {
    /* storage unavailable: the URL alone decides */
  }
  let value: string | null = param === "off" || param === "0" ? null : param;
  if (value === null && param === null) {
    try {
      value = storage?.getItem(REVIEW_SWITCH_KEY) ?? null;
    } catch {
      value = null;
    }
  }
  if (value === null) return { on: false, layout: "stepper" };
  return { on: true, layout: (REVIEW_LAYOUTS as readonly string[]).includes(value) ? (value as ReviewLayout) : "stepper" };
}

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

// ---------------------------------------------------------------------------
// Mock models
// ---------------------------------------------------------------------------

const MOCK_NAMES = ["mock_unet_a", "mock_unet_b", "mock_convnext", "mock_swint", "mock_bad_model"];
/** Most frames a mock covers (keeps the prototype quick on long videos). */
const MOCK_MAX_FRAMES = 6000;

/** The project's poses on `video` per frame (user instances win over predictions), in skeleton node order. */
function projectPoses(labels: Labels, video: Video, nodeNames: readonly string[]): Map<number, Float64Array[]> {
  const out = new Map<number, Float64Array[]>();
  for (const lf of labels.labeledFrames) {
    if (lf.video !== video) continue;
    const users = lf.instances.filter((i) => i.constructor === Instance);
    const use = users.length > 0 ? users : lf.instances;
    const poses: Float64Array[] = [];
    for (const inst of use) {
      const names = inst.skeleton.nodes.map((n) => n.name);
      const pts = inst.numpy({ invisibleAsNaN: true });
      const xy = new Float64Array(nodeNames.length * 2).fill(NaN);
      let placed = 0;
      nodeNames.forEach((n, i) => {
        const j = names.indexOf(n);
        if (j >= 0 && Number.isFinite(pts[j]?.[0]) && Number.isFinite(pts[j]?.[1])) {
          xy[2 * i] = pts[j][0];
          xy[2 * i + 1] = pts[j][1];
          placed++;
        }
      });
      if (placed >= 1) poses.push(xy);
    }
    if (poses.length > 0) out.set(lf.frameIdx, poses);
  }
  return out;
}

/**
 * Five made-up models for `video`, to try the review prototypes on any
 * project. Where the project has instances on this video, each model copies
 * them with ~1 px of noise (so crops show real animals); otherwise two animals
 * walk a slow loop. Every few dozen frames one model misplaces a few nodes by
 * 50–120 px for a short stretch, and the last model goes wrong more often, so
 * there is something to review.
 */
export function makeMockModels(labels: Labels, video: Video, skeleton: Skeleton, seed = 1): NewOverlayModel[] {
  const nodeNames = skeleton.nodes.map((n) => n.name);
  const nNodes = nodeNames.length;
  const dims = videoDims(video);
  const W = dims.width ?? 1024;
  const H = dims.height ?? 768;
  let truth = projectPoses(labels, video, nodeNames);
  if (truth.size === 0) {
    truth = new Map();
    const frames = Math.min(dims.frameCount ?? 2000, MOCK_MAX_FRAMES);
    for (let f = 0; f < frames; f++) {
      truth.set(
        f,
        [0, 1].map((a) => {
          const cx = W * (0.3 + 0.4 * a) + W * 0.12 * Math.sin(f / 90 + a * 2);
          const cy = H * 0.5 + H * 0.2 * Math.cos(f / 120 + a);
          const ang = f / 60 + a;
          const xy = new Float64Array(nNodes * 2);
          for (let i = 0; i < nNodes; i++) {
            // Nodes along a gently curved body, about 12 px apart.
            const t = i - (nNodes - 1) / 2;
            xy[2 * i] = cx + Math.cos(ang) * t * 12 - Math.sin(ang) * Math.sin(t / 2) * 8;
            xy[2 * i + 1] = cy + Math.sin(ang) * t * 12 + Math.cos(ang) * Math.sin(t / 2) * 8;
          }
          return xy;
        })
      );
    }
  }
  const frames = [...truth.keys()].sort((a, b) => a - b).slice(0, MOCK_MAX_FRAMES);
  let s = seed >>> 0 || 1;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  // Disagreement episodes: [start frame index, length, model, nodes, offset].
  const episodes: { start: number; len: number; model: number; nodes: number[]; dx: number; dy: number }[] = [];
  for (let r = 0; r < frames.length; r += 20 + Math.floor(rand() * 40)) {
    const model = rand() < 0.4 ? MOCK_NAMES.length - 1 : Math.floor(rand() * MOCK_NAMES.length);
    const k = 1 + Math.floor(rand() * Math.min(4, nNodes));
    const nodes = Array.from({ length: k }, () => Math.floor(rand() * nNodes));
    // One model of five off by d gives an RMS spread of 2d/5: 50–120 px → 20–48 px, around the review's 25 px.
    const mag = 50 + rand() * 70;
    const ang = rand() * Math.PI * 2;
    episodes.push({ start: r, len: 1 + Math.floor(rand() * 4), model, nodes, dx: mag * Math.cos(ang), dy: mag * Math.sin(ang) });
  }
  return MOCK_NAMES.map((name, mi) => {
    const b = new PoseStoreBuilder(nNodes, frames.length * 2);
    let ep = 0;
    frames.forEach((f, r) => {
      while (ep < episodes.length && episodes[ep].start + episodes[ep].len <= r) ep++;
      const e = episodes[ep] && episodes[ep].start <= r && episodes[ep].model === mi ? episodes[ep] : null;
      truth.get(f)!.forEach((xy, a) => {
        const off = b.begin(f, 0.6 + 0.4 * rand(), `mock_track_${a}`);
        const buf = b.buffer;
        for (let i = 0; i < nNodes; i++) {
          const bad = e && a === 0 && e.nodes.includes(i);
          const missing = rand() < 0.01;
          buf[off + 2 * i] = missing ? NaN : xy[2 * i] + (rand() - 0.5) * 2 + (bad ? e.dx : 0);
          buf[off + 2 * i + 1] = missing ? NaN : xy[2 * i + 1] + (rand() - 0.5) * 2 + (bad ? e.dy : 0);
        }
      });
    });
    return { name, source: `${MOCK_SOURCE_PREFIX}${name}`, video, frames: b.build() };
  });
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
