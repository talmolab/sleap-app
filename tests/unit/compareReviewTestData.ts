/**
 * Test data for the Compare Models review window: five made-up models for a
 * video (copies of the project's instances with noise, or two animals on a
 * loop), with a few big disagreements to review. Was the dev-only "Load mock
 * models" button while the review layouts were prototypes.
 */
import { Instance } from "@talmolab/sleap-io.js";
import type { Labels, Skeleton, Video } from "@/types";
import type { NewOverlayModel } from "@/stores/modelOverlayStore";
import { PoseStoreBuilder } from "@/lib/modelOverlay/poseStore";
import { videoDims } from "@/lib/modelOverlay/core";

const MOCK_SOURCE_PREFIX = "mock://";

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

