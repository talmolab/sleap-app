/**
 * The `centroid.instance` back-link: the single, stable record of which pose
 * instance a first-class centroid annotation belongs to (issue #212).
 *
 * The canvas colors each amber crosshair ring by this link. Before it was
 * actually assigned, the renderer fell back to a geometric guess recomputed on
 * EVERY repaint — which re-partitioned the centroids as keypoints were placed,
 * so the rings changed color mid-labeling. These tests pin the link down at the
 * three places it can silently die: assignment, undo/redo cloning, and save/load.
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import {
  Labels,
  LabeledFrame,
  Instance,
  PredictedInstance,
  Skeleton,
  Video,
  UserCentroid,
  saveSlpToBytes,
  loadSlp,
} from "@talmolab/sleap-io.js";
import { CommandContext } from "@/commands/CommandContext";
import { PairPoseInstances, SeedCentroid } from "@/commands/editCommands";
import { useAppStore } from "@/stores/appStore";
import {
  ensurePairedPoseInstances,
  linkCentroidsToPoses,
  relinkCentroids,
} from "@/lib/activeLearning/centroidPairing";
import { getInstanceColor } from "@/lib/colorPalettes";

const NODE_NAMES = ["head", "nose", "tail"];

function stubVideo(name = "a.mp4"): Video {
  return new Video({
    filename: name,
    backendMetadata: { shape: [100, 480, 640, 3] },
    openBackend: false,
  });
}

function placeNode(inst: Instance, skeleton: Skeleton, name: string, xy: [number, number]) {
  const i = skeleton.nodes.findIndex((n) => n.name === name);
  inst.points[i].xy = xy;
  inst.points[i].visible = true;
  inst.points[i].complete = true;
}

/**
 * The colors VideoPlayer draws the frame's centroid rings in.
 *
 * Mirrors the overlay's (post-fix) one-liner: resolve `centroid.instance` to its
 * slot in `frame.instances`, and take that instance's palette color — the same
 * `getInstanceColor(palette, "instance", idx, ...)` the skeleton renderer uses.
 * An unlinked centroid falls back to its own palette slot.
 */
function centroidRingColors(lf: LabeledFrame): string[] {
  return lf.centroids.map((c, i) => {
    const matchIdx = c.instance ? lf.instances.indexOf(c.instance) : -1;
    const idx = matchIdx >= 0 ? matchIdx : i;
    return getInstanceColor("standard", "instance", idx, null, [], false, true).join(",");
  });
}

/** Two seeded centroids on one frame, paired eagerly (as Phase 2 entry does). */
function setupPaired() {
  const pose = new Skeleton({ nodes: [...NODE_NAMES], name: "pose" });
  const video = stubVideo();
  const lf = new LabeledFrame({ video, frameIdx: 0 });
  lf.centroids.push(new UserCentroid({ x: 20, y: 20 }));
  lf.centroids.push(new UserCentroid({ x: 300, y: 300 }));
  const labels = new Labels({ videos: [video], skeletons: [pose], labeledFrames: [lf] });
  ensurePairedPoseInstances(labels, pose);
  return { labels, pose, video, lf };
}

describe("centroid.instance assignment", () => {
  it("ensurePairedPoseInstances links every centroid to a distinct pose", () => {
    const { lf } = setupPaired();
    expect(lf.instances.length).toBe(2);
    const slots = lf.centroids.map((c) => lf.instances.indexOf(c.instance!));
    expect(slots).toEqual([0, 1]);
  });

  it("reports created + linked so a caller can detect a true no-op", () => {
    const pose = new Skeleton({ nodes: [...NODE_NAMES], name: "pose" });
    const video = stubVideo();
    const lf = new LabeledFrame({ video, frameIdx: 0 });
    lf.centroids.push(new UserCentroid({ x: 20, y: 20 }));
    const labels = new Labels({ videos: [video], skeletons: [pose], labeledFrames: [lf] });

    expect(ensurePairedPoseInstances(labels, pose)).toEqual({ created: 1, linked: 1 });
    expect(ensurePairedPoseInstances(labels, pose)).toEqual({ created: 0, linked: 0 });
  });

  it("preserves a pre-existing link instead of overwriting it", () => {
    // A locator prediction (or a project loaded from disk) can already carry a
    // link. Re-pairing must not re-decide it — even when geometry disagrees.
    const pose = new Skeleton({ nodes: [...NODE_NAMES], name: "pose" });
    const video = stubVideo();
    const near = Instance.empty({ skeleton: pose });
    placeNode(near, pose, "head", [20, 20]);
    const far = Instance.empty({ skeleton: pose });
    placeNode(far, pose, "head", [300, 300]);
    const c = new UserCentroid({ x: 20, y: 20 });
    c.instance = far; // deliberately NOT the nearest pose
    const lf = new LabeledFrame({
      video,
      frameIdx: 0,
      instances: [near, far],
      centroids: [c],
    });
    const labels = new Labels({ videos: [video], skeletons: [pose], labeledFrames: [lf] });

    expect(linkCentroidsToPoses(labels, pose)).toBe(0);
    expect(lf.centroids[0].instance).toBe(far);
  });

  it("never double-books a pose already claimed by another centroid's link", () => {
    const pose = new Skeleton({ nodes: [...NODE_NAMES], name: "pose" });
    const video = stubVideo();
    const only = Instance.empty({ skeleton: pose });
    const linked = new UserCentroid({ x: 20, y: 20 });
    linked.instance = only;
    const orphan = new UserCentroid({ x: 22, y: 22 });
    const lf = new LabeledFrame({
      video,
      frameIdx: 0,
      instances: [only],
      centroids: [linked, orphan],
    });
    const labels = new Labels({ videos: [video], skeletons: [pose], labeledFrames: [lf] });

    expect(linkCentroidsToPoses(labels, pose)).toBe(0);
    expect(lf.centroids[1].instance).toBe(null);
  });

  it("relinkCentroids carries the link across an adopt-in-place swap", () => {
    const pose = new Skeleton({ nodes: [...NODE_NAMES], name: "pose" });
    const video = stubVideo();
    const predicted = new PredictedInstance({
      skeleton: pose,
      points: pose.nodes.map(() => ({
        xy: [20, 20] as [number, number],
        visible: true,
        complete: false,
        score: 0.9,
      })),
      score: 0.9,
    });
    const c = new UserCentroid({ x: 20, y: 20 });
    c.instance = predicted;
    const lf = new LabeledFrame({ video, frameIdx: 0, instances: [predicted], centroids: [c] });

    const adopted = new Instance({ skeleton: pose, points: predicted.points });
    relinkCentroids(lf, predicted, adopted);
    lf.instances.splice(0, 1, adopted);

    expect(lf.centroids[0].instance).toBe(adopted);
    expect(lf.instances.indexOf(lf.centroids[0].instance!)).toBe(0);
  });
});

describe("centroid ring color stability (the user-visible regression)", () => {
  it("stays put while keypoints are progressively placed on the second animal", () => {
    const { pose, lf } = setupPaired();
    const [a, b] = lf.instances;
    // Guard: these colors must come from the LINK, not the index fallback —
    // otherwise the assertions below would pass trivially.
    expect(lf.centroids.every((c) => c.instance !== null)).toBe(true);
    const before = centroidRingColors(lf);
    expect(before[0]).not.toBe(before[1]);

    // Fully label animal A, then label animal B node by node. The old geometric
    // fallback re-guessed on every repaint: with B still empty it collapsed both
    // rings onto A, then re-partitioned as B's mean crept into existence.
    placeNode(a, pose, "head", [20, 18]);
    expect(centroidRingColors(lf)).toEqual(before);
    placeNode(a, pose, "nose", [22, 20]);
    expect(centroidRingColors(lf)).toEqual(before);
    placeNode(a, pose, "tail", [16, 24]);
    expect(centroidRingColors(lf)).toEqual(before);

    placeNode(b, pose, "head", [300, 298]);
    expect(centroidRingColors(lf)).toEqual(before);
    placeNode(b, pose, "nose", [302, 300]);
    expect(centroidRingColors(lf)).toEqual(before);
    placeNode(b, pose, "tail", [296, 304]);
    expect(centroidRingColors(lf)).toEqual(before);
  });

  it("stays put when a node is placed far from its own centroid (a mislabel)", () => {
    // A stray click near the OTHER animal used to drag the ring's color with it.
    const { pose, lf } = setupPaired();
    const before = centroidRingColors(lf);
    placeNode(lf.instances[0], pose, "head", [299, 301]);
    expect(centroidRingColors(lf)).toEqual(before);
  });
});

describe("centroid.instance survives undo/redo", () => {
  let ctx: CommandContext;

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    ctx = new CommandContext();
  });

  /**
   * Seeded + paired project, adopted by the store so commands can run on it.
   *
   * Read the frame back with `labels.labeledFrames[0]`, NOT `labels.find(...)`:
   * after a multi-frame undo (which rebuilds every LabeledFrame) `find` serves a
   * stale cached frame — pre-existing sleap-io.js behaviour, unrelated to the
   * back-link.
   */
  async function setupStoreProject() {
    const pose = new Skeleton({ nodes: [...NODE_NAMES], name: "pose" });
    const video = stubVideo();
    const lf = new LabeledFrame({ video, frameIdx: 0 });
    lf.centroids.push(new UserCentroid({ x: 20, y: 20 }));
    lf.centroids.push(new UserCentroid({ x: 300, y: 300 }));
    const labels = new Labels({ videos: [video], skeletons: [pose], labeledFrames: [lf] });
    useAppStore.getState().setLabels(labels, "test.slp");
    await ctx.execute(PairPoseInstances);
    const frame = () => labels.labeledFrames[0];
    const slots = () =>
      frame().centroids.map((c) => (c.instance ? frame().instances.indexOf(c.instance) : null));
    return { labels, pose, video, frame, slots };
  }

  it("survives an undo/redo of a single-frame edit (seeding another centroid)", async () => {
    const { frame, slots } = await setupStoreProject();
    expect(slots()).toEqual([0, 1]);
    const colorsBefore = centroidRingColors(frame());

    // SeedCentroid snapshots the frame — cloning instances AND centroids.
    // Copying `.instance` by reference there would leave the restored centroids
    // pointing at pre-clone Instances, so indexOf would return -1 and the ring
    // colors would jump on the next repaint.
    useAppStore.getState().enterSeedMode(undefined, true);
    await ctx.execute(SeedCentroid, { x: 150, y: 150 });
    expect(slots()).toEqual([0, 1, null]);

    expect(ctx.undo()).toBe(true);
    expect(slots()).toEqual([0, 1]);
    expect(centroidRingColors(frame())).toEqual(colorsBefore);
    // The links point at the LIVE clones, not orphaned pre-undo objects.
    for (const c of frame().centroids) {
      expect(frame().instances.includes(c.instance!)).toBe(true);
    }

    expect(ctx.redo()).toBe(true);
    expect(slots()).toEqual([0, 1, null]);
    for (const c of frame().centroids) {
      if (c.instance) expect(frame().instances.includes(c.instance)).toBe(true);
    }
  });

  it("survives an undo of a multi-frame edit (the pairing command itself)", async () => {
    const { frame, slots } = await setupStoreProject();
    // Seed a third centroid, then pair it — the pairing snapshot is all-frames.
    useAppStore.getState().enterSeedMode(undefined, true);
    await ctx.execute(SeedCentroid, { x: 150, y: 150 });
    await ctx.execute(PairPoseInstances);
    expect(slots()).toEqual([0, 1, 2]);

    expect(ctx.undo()).toBe(true); // undoes the pairing of the third centroid
    expect(frame().instances.length).toBe(2);
    expect(slots()).toEqual([0, 1, null]);
    for (const c of frame().centroids) {
      if (c.instance) expect(frame().instances.includes(c.instance)).toBe(true);
    }
  });

  it("a link to an instance that no longer exists is dropped, not left dangling", async () => {
    const { frame, slots } = await setupStoreProject();
    // Delete the pose the second centroid points at, WITHOUT clearing the link.
    const orphaned = frame().centroids[1].instance!;
    frame().instances.splice(frame().instances.indexOf(orphaned), 1);

    // Any command snapshots + restores the frame through cloneCentroids.
    useAppStore.getState().enterSeedMode(undefined, true);
    await ctx.execute(SeedCentroid, { x: 400, y: 400 });
    expect(ctx.undo()).toBe(true);

    expect(slots()).toEqual([0, null]);
  });
});

describe("centroid.instance round-trips through the SLP", () => {
  it("survives save + load (the /centroids `instance` column)", async () => {
    const { labels, video } = setupPaired();
    const lf = labels.find({ video, frameIdx: 0 })[0];
    // Cross the links so a positional coincidence can't pass the test.
    lf.centroids[0].instance = lf.instances[1];
    lf.centroids[1].instance = lf.instances[0];

    const bytes = await saveSlpToBytes(labels);
    const reloaded = await loadSlp(bytes.buffer as ArrayBuffer, { openVideos: false });

    const rlf = reloaded.labeledFrames[0];
    expect(rlf.centroids.length).toBe(2);
    expect(rlf.instances.length).toBe(2);
    expect(rlf.centroids.map((c) => rlf.instances.indexOf(c.instance!))).toEqual([1, 0]);
  });

  it("an unlinked centroid stays unlinked across save + load", async () => {
    const pose = new Skeleton({ nodes: [...NODE_NAMES], name: "pose" });
    const video = stubVideo();
    const inst = Instance.empty({ skeleton: pose });
    placeNode(inst, pose, "head", [20, 20]);
    const lf = new LabeledFrame({
      video,
      frameIdx: 0,
      instances: [inst],
      centroids: [new UserCentroid({ x: 20, y: 20 })],
    });
    const labels = new Labels({ videos: [video], skeletons: [pose], labeledFrames: [lf] });

    const bytes = await saveSlpToBytes(labels);
    const reloaded = await loadSlp(bytes.buffer as ArrayBuffer, { openVideos: false });

    expect(reloaded.labeledFrames[0].centroids[0].instance).toBe(null);
  });
});
