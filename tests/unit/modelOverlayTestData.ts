/**
 * Test data for Compare Model Predictions: a project and prediction "files"
 * (Labels objects) for several models, built in code so each test states the
 * one thing it varies (video, node names/order, tracks, positions).
 */
import {
  Labels,
  LabeledFrame,
  PredictedInstance,
  Instance,
  Skeleton,
  Track,
  Video,
} from "@talmolab/sleap-io.js";

export const NODES = ["head", "thorax", "abdomen"];

export function makeVideo(
  filename = "/data/session1/mouse.mp4",
  shape: [number, number, number, number] | null = [100, 480, 640, 1]
): Video {
  return new Video({
    filename,
    backendMetadata: shape ? { shape } : {},
    openBackend: false,
  });
}

/** One predicted instance; `xy` is one [x, y] per node in `skeleton`'s order (NaN = missing). */
export function makePred(
  skeleton: Skeleton,
  xy: [number, number][],
  opts: { track?: Track | null; score?: number } = {}
): PredictedInstance {
  return new PredictedInstance({
    skeleton,
    points: skeleton.nodes.map((node, i) => ({
      xy: [xy[i][0], xy[i][1]] as [number, number],
      visible: Number.isFinite(xy[i][0]),
      complete: false,
      name: node.name,
      score: 0.9,
    })),
    track: opts.track ?? null,
    score: opts.score ?? 0.8,
  });
}

export function makeUser(skeleton: Skeleton, xy: [number, number][], track: Track | null = null): Instance {
  return new Instance({
    skeleton,
    points: skeleton.nodes.map((node, i) => ({
      xy: [xy[i][0], xy[i][1]] as [number, number],
      visible: true,
      complete: true,
      name: node.name,
    })),
    track,
  });
}

/** A pose for `NODES` centred on (cx, cy): head above, abdomen below. */
export function poseAt(cx: number, cy: number): [number, number][] {
  return [
    [cx, cy - 10],
    [cx, cy],
    [cx, cy + 10],
  ];
}

export interface PredFileSpec {
  video?: Video;
  nodes?: string[];
  /** frameIdx → poses (in NODES order; reordered to `nodes` order automatically). */
  frames: Record<number, { xy: [number, number][]; track?: string }[]>;
  provenance?: Record<string, unknown>;
}

/** A prediction file's Labels. Poses are given in NODES order whatever `nodes` order is. */
export function makePredictionLabels(spec: PredFileSpec): Labels {
  const nodes = spec.nodes ?? NODES;
  const skeleton = new Skeleton({ nodes, name: "skel" });
  const video = spec.video ?? makeVideo();
  const tracks = new Map<string, Track>();
  const lfs: LabeledFrame[] = [];
  for (const [f, poses] of Object.entries(spec.frames)) {
    const lf = new LabeledFrame({ video, frameIdx: Number(f) });
    for (const p of poses) {
      let track: Track | null = null;
      if (p.track) {
        track = tracks.get(p.track) ?? new Track(p.track);
        tracks.set(p.track, track);
      }
      // Reorder from NODES order into this file's node order.
      const xy = nodes.map((n) => {
        const i = NODES.indexOf(n);
        return i >= 0 ? p.xy[i] : ([NaN, NaN] as [number, number]);
      });
      lf.instances.push(makePred(skeleton, xy, { track }));
    }
    lfs.push(lf);
  }
  return new Labels({
    labeledFrames: lfs,
    videos: [video],
    skeletons: [skeleton],
    tracks: [...tracks.values()],
    provenance: spec.provenance ?? {},
  });
}
