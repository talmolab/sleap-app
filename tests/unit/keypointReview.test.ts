// Why: keypoint review steps through a list of instances for one node; the list decides what the user sees, so each source must pick and order the right instances.
import { describe, it, expect } from "../bun-test";
import { Instance, LabeledFrame, Labels, PredictedInstance, Skeleton, SuggestionFrame, Video } from "@talmolab/sleap-io.js";
import { buildKeypointQueue, keypointItemKey, nodeOffBy } from "@/lib/keypointReview";

const skeleton = new Skeleton({ nodes: ["nose", "head", "neck", "tail"], edges: [["nose", "head"], ["head", "neck"], ["neck", "tail"]] });
const video = new Video({ filename: "clip.mp4", openBackend: false, backendMetadata: { shape: [100, 480, 640, 1] } });
const body = (dx: number, nose: [number, number] = [0, 0]) =>
  Instance.fromNumpy({
    pointsData: [
      [100 + dx + nose[0], 100 + nose[1]],
      [110 + dx, 100],
      [125 + dx, 100],
      [160 + dx, 100],
    ],
    skeleton,
  });

function project(frames: Record<number, Instance[]>, extra: Partial<{ suggestions: SuggestionFrame[] }> = {}) {
  const labels = new Labels({
    videos: [video],
    skeletons: [skeleton],
    labeledFrames: Object.entries(frames).map(
      ([f, instances]) => new LabeledFrame({ video, frameIdx: Number(f), instances }),
    ),
  });
  if (extra.suggestions) labels.suggestions = extra.suggestions;
  return labels;
}
const at = (q: { frameIdx: number; instIdx: number }[]) => q.map((i) => `${i.frameIdx}/${i.instIdx}`);

describe("buildKeypointQueue", () => {
  it("all: every user instance in frame order, never predictions", () => {
    const pred = PredictedInstance.fromNumpy({ pointsData: [[1, 1], [2, 2], [3, 3], [4, 4]], skeleton });
    const labels = project({ 20: [body(0), body(200)], 5: [body(0), pred] });
    expect(at(buildKeypointQueue(labels, { skeleton, node: 0, source: "all" }))).toEqual(["5/0", "20/0", "20/1"]);
  });

  it("suggestions: only instances on suggested frames", () => {
    const labels = project({ 5: [body(0)], 20: [body(0)] }, { suggestions: [new SuggestionFrame({ video, frameIdx: 20 })] });
    expect(at(buildKeypointQueue(labels, { skeleton, node: 0, source: "suggestions" }))).toEqual(["20/0"]);
  });

  it("qc: only the instances QC blames this node on", () => {
    const labels = project({ 5: [body(0)], 20: [body(0), body(200)] });
    const qcBlamed = new Set([keypointItemKey(0, 20, 1)]);
    expect(at(buildKeypointQueue(labels, { skeleton, node: 0, source: "qc", qcBlamed }))).toEqual(["20/1"]);
  });

  // Why: "worst first" is the point of the mode: the misplaced nose must come up first, and a hidden nose (often just occluded) last.
  it("worst: the furthest-off node first, unplaced last", () => {
    const hidden = body(0);
    hidden.points[0].visible = false;
    const labels = project({
      1: [body(0)],
      2: [body(0, [30, 25])],
      3: [hidden],
      4: [body(0, [3, 0])],
      5: [body(0)],
      6: [body(40)],
      7: [body(80)],
    });
    const q = buildKeypointQueue(labels, { skeleton, node: 0, source: "worst" });
    expect(at(q)[0]).toBe("2/0");
    expect(at(q)[1]).toBe("4/0");
    expect(at(q)[q.length - 1]).toBe("3/0");
    expect(q[q.length - 1].offBy).toBe(Infinity);
    expect(q[0].offBy).toBeGreaterThan(q[1].offBy as number);
  });
});

describe("nodeOffBy", () => {
  const template = [[0, 0], [10, 0], [25, 0], [60, 0]];
  it("is 0 for a node right where the others put it, at any size or turn", () => {
    expect(nodeOffBy(template, [[0, 0], [0, 20], [0, 50], [0, 120]], 0)).toBeCloseTo(0, 6);
  });
  it("grows with the distance, in body radii", () => {
    const near = nodeOffBy(template, [[2, 0], [10, 0], [25, 0], [60, 0]], 0)!;
    const far = nodeOffBy(template, [[20, 10], [10, 0], [25, 0], [60, 0]], 0)!;
    expect(far).toBeGreaterThan(near);
  });
  it("is Infinity when the node isn't placed, null with too few other nodes", () => {
    expect(nodeOffBy(template, [[NaN, NaN], [10, 0], [25, 0], [60, 0]], 0)).toBe(Infinity);
    expect(nodeOffBy(template, [[0, 0], [10, 0], [NaN, NaN], [NaN, NaN]], 0)).toBeNull();
  });
});
