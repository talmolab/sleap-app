/**
 * Multi-skeleton safety for skeleton-edit commands (CODE_REVIEW.md CR-03).
 *
 * A `.slp` project can hold more than one skeleton (each instance carries its
 * own skeleton). Every skeleton-edit command must mutate only instances of the
 * skeleton it edits — a node add/delete/rename/template/import on one skeleton
 * must never grow, shrink, or re-associate an instance of another skeleton, and
 * undo/redo must preserve each instance's skeleton reference. This fixture uses
 * a pose skeleton + a second single-node skeleton to exercise that invariant.
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import { CommandContext } from "@/commands/CommandContext";
import { useAppStore } from "@/stores/appStore";
import {
  AddNodeCommand,
  DeleteNodeCommand,
  RenameNodeCommand,
  LoadSkeletonTemplateCommand,
  OpenSkeletonCommand,
  installSkeletonUndoInterceptor,
} from "@/commands/skeletonCommands";
import { PairPoseInstances } from "@/commands/editCommands";
import {
  Labels,
  Instance,
  LabeledFrame,
  Skeleton,
  Video,
  UserCentroid,
} from "@talmolab/sleap-io.js";

/** Reset the store between tests. */
function resetStore() {
  useAppStore.setState(useAppStore.getInitialState());
}

/**
 * Project with a 3-node pose skeleton (active) + a 1-node centroid skeleton,
 * and one frame holding one fully-placed instance of each.
 */
function setupTwoSkeletonProject() {
  const pose = new Skeleton({ nodes: ["nose", "head", "tail"], name: "pose" });
  pose.addEdge(pose.nodes[0], pose.nodes[1]);
  const centroidSkel = new Skeleton({ nodes: ["centroid"], name: "centroid" });

  const video = new Video({
    filename: "test.mp4",
    backendMetadata: { shape: [100, 480, 640, 3] },
    openBackend: false,
  });

  const poseInst = Instance.empty({ skeleton: pose });
  for (let n = 0; n < pose.nodes.length; n++) {
    poseInst.points[n].xy = [10 * (n + 1), 20 * (n + 1)];
    poseInst.points[n].visible = true;
    poseInst.points[n].complete = true;
  }
  const centroidInst = Instance.empty({ skeleton: centroidSkel });
  centroidInst.points[0].xy = [15, 15];
  centroidInst.points[0].visible = true;
  centroidInst.points[0].complete = true;

  const labels = new Labels({
    videos: [video],
    skeletons: [pose, centroidSkel],
    labeledFrames: [
      new LabeledFrame({ video, frameIdx: 0, instances: [poseInst, centroidInst] }),
    ],
  });

  // setLabels picks skeletons[0] (the pose skeleton) as the active skeleton.
  useAppStore.getState().setLabels(labels, "test.slp");
  return { labels, pose, centroidSkel, video };
}

/** The live instances of a skeleton (re-fetched — undo swaps in fresh clones). */
function liveInstancesOf(skeleton: Skeleton): Instance[] {
  const labels = useAppStore.getState().labels!;
  const out: Instance[] = [];
  for (const lf of labels.labeledFrames) {
    for (const inst of lf.instances) {
      if (inst.skeleton === skeleton) out.push(inst);
    }
  }
  return out;
}

describe("multi-skeleton skeleton editing", () => {
  let ctx: CommandContext;

  beforeEach(() => {
    resetStore();
    ctx = new CommandContext();
  });

  it("AddNode grows only instances of the edited skeleton", async () => {
    const { pose, centroidSkel } = setupTwoSkeletonProject();

    await ctx.execute(AddNodeCommand, { name: "extra" });

    expect(pose.nodes.length).toBe(4);
    expect(centroidSkel.nodes.length).toBe(1);
    const [poseInst] = liveInstancesOf(pose);
    const [centroidInst] = liveInstancesOf(centroidSkel);
    expect(poseInst.points.length).toBe(4);
    // The centroid instance must stay consistent with its 1-node skeleton.
    expect(centroidInst.points.length).toBe(1);
    expect(centroidInst.points[0].xy).toEqual([15, 15]);
    expect(centroidInst.points[0].name).toBe("centroid");
  });

  it("DeleteNode shrinks only instances of the edited skeleton", async () => {
    const { pose, centroidSkel } = setupTwoSkeletonProject();

    await ctx.execute(DeleteNodeCommand, { nodeIdx: 1 });

    const [poseInst] = liveInstancesOf(pose);
    const [centroidInst] = liveInstancesOf(centroidSkel);
    expect(poseInst.points.length).toBe(2);
    expect(centroidInst.points.length).toBe(1);
    expect(centroidInst.points[0].xy).toEqual([15, 15]);
  });

  it("RenameNode renames point names only on the edited skeleton's instances", async () => {
    const { pose, centroidSkel } = setupTwoSkeletonProject();

    // Rename pose node 0 — the centroid instance's point 0 shares the index
    // but belongs to another skeleton and must keep its name.
    await ctx.execute(RenameNodeCommand, { nodeIdx: 0, newName: "snout" });

    const [poseInst] = liveInstancesOf(pose);
    const [centroidInst] = liveInstancesOf(centroidSkel);
    expect(poseInst.points[0].name).toBe("snout");
    expect(centroidInst.points[0].name).toBe("centroid");
    expect(centroidSkel.nodes[0].name).toBe("centroid");
  });

  it("LoadSkeletonTemplate resets only the edited skeleton's instances", async () => {
    const { pose, centroidSkel } = setupTwoSkeletonProject();

    await ctx.execute(LoadSkeletonTemplateCommand, { templateId: "celegans" });

    expect(pose.nodes.length).toBe(2);
    const [poseInst] = liveInstancesOf(pose);
    const [centroidInst] = liveInstancesOf(centroidSkel);
    expect(poseInst.points.length).toBe(2);
    expect(isNaN(poseInst.points[0].xy[0])).toBe(true);
    // Untouched: same skeleton association, same single placed point.
    expect(centroidInst.points.length).toBe(1);
    expect(centroidInst.points[0].xy).toEqual([15, 15]);
  });

  it("OpenSkeleton remaps only the edited skeleton's instances", async () => {
    const { pose, centroidSkel } = setupTwoSkeletonProject();

    const imported = new Skeleton({ nodes: ["nose", "hip"], name: "imported" });
    await ctx.execute(OpenSkeletonCommand, { newSkeleton: imported });

    expect(pose.nodes.map((n) => n.name)).toEqual(["nose", "hip"]);
    const [poseInst] = liveInstancesOf(pose);
    const [centroidInst] = liveInstancesOf(centroidSkel);
    // "nose" matched by name and kept its xy; "hip" is new (NaN).
    expect(poseInst.points.length).toBe(2);
    expect(poseInst.points[0].xy).toEqual([10, 20]);
    expect(isNaN(poseInst.points[1].xy[0])).toBe(true);
    expect(centroidInst.points.length).toBe(1);
    expect(centroidInst.points[0].xy).toEqual([15, 15]);
  });

  it("undo after AddNode preserves the centroid instance's skeleton association", async () => {
    // The CR-03 reproduction: add a pose node, then undo. Before the fix the
    // centroid instance grew a second point and undo reassigned BOTH instances
    // to the pose skeleton.
    const { pose, centroidSkel } = setupTwoSkeletonProject();
    installSkeletonUndoInterceptor(ctx);

    await ctx.execute(AddNodeCommand, { name: "extra" });
    expect(ctx.undo()).toBe(true);

    expect(pose.nodes.length).toBe(3);
    const poseInsts = liveInstancesOf(pose);
    const centroidInsts = liveInstancesOf(centroidSkel);
    expect(poseInsts.length).toBe(1);
    expect(centroidInsts.length).toBe(1);
    expect(poseInsts[0].points.length).toBe(3);
    expect(centroidInsts[0].points.length).toBe(1);
    expect(centroidInsts[0].points[0].xy).toEqual([15, 15]);
  });

  it("redo re-applies the edit and still leaves the centroid instance alone", async () => {
    const { pose, centroidSkel } = setupTwoSkeletonProject();
    installSkeletonUndoInterceptor(ctx);

    await ctx.execute(AddNodeCommand, { name: "extra" });
    expect(ctx.undo()).toBe(true);
    expect(ctx.redo()).toBe(true);

    expect(pose.nodes.length).toBe(4);
    const poseInsts = liveInstancesOf(pose);
    const centroidInsts = liveInstancesOf(centroidSkel);
    expect(poseInsts.length).toBe(1);
    expect(centroidInsts.length).toBe(1);
    expect(poseInsts[0].points.length).toBe(4);
    expect(centroidInsts[0].points.length).toBe(1);
  });

  it("undo after RenameNode restores the old node name (in-place mutation)", async () => {
    // RenameNode mutates node.name in place; the snapshot must deep-copy the
    // Node so undo can restore "nose", not keep the mutated "snout".
    const { pose, centroidSkel } = setupTwoSkeletonProject();
    installSkeletonUndoInterceptor(ctx);

    await ctx.execute(RenameNodeCommand, { nodeIdx: 0, newName: "snout" });
    expect(pose.nodes[0].name).toBe("snout");

    expect(ctx.undo()).toBe(true);
    expect(pose.nodes[0].name).toBe("nose");
    // The centroid skeleton is untouched throughout.
    expect(centroidSkel.nodes[0].name).toBe("centroid");

    // Redo re-applies the rename.
    expect(ctx.redo()).toBe(true);
    expect(pose.nodes[0].name).toBe("snout");
  });

  it("undo after LoadSkeletonTemplate restores both instance sets faithfully", async () => {
    const { pose, centroidSkel } = setupTwoSkeletonProject();
    installSkeletonUndoInterceptor(ctx);

    await ctx.execute(LoadSkeletonTemplateCommand, { templateId: "human" });
    expect(pose.nodes.length).toBe(17);
    expect(ctx.undo()).toBe(true);

    expect(pose.nodes.map((n) => n.name)).toEqual(["nose", "head", "tail"]);
    const poseInsts = liveInstancesOf(pose);
    const centroidInsts = liveInstancesOf(centroidSkel);
    expect(poseInsts.length).toBe(1);
    expect(centroidInsts.length).toBe(1);
    expect(poseInsts[0].points[0].xy).toEqual([10, 20]);
    expect(centroidInsts[0].points[0].xy).toEqual([15, 15]);
  });
});

describe("PairPoseInstances command", () => {
  let ctx: CommandContext;

  beforeEach(() => {
    resetStore();
    ctx = new CommandContext();
  });

  /** Single-skeleton project with N first-class user centroids and no pose
   * instances on one frame. */
  function setupSeeded(nCentroids: number) {
    const pose = new Skeleton({ nodes: ["nose", "head"], name: "pose" });
    const video = new Video({
      filename: "test.mp4",
      backendMetadata: { shape: [100, 480, 640, 3] },
      openBackend: false,
    });
    const lf = new LabeledFrame({ video, frameIdx: 0 });
    for (let i = 0; i < nCentroids; i++) {
      lf.centroids.push(new UserCentroid({ x: 10 * (i + 1), y: 10 * (i + 1) }));
    }
    const labels = new Labels({
      videos: [video],
      skeletons: [pose],
      labeledFrames: [lf],
    });
    useAppStore.getState().setLabels(labels, "test.slp");
    return { labels, pose, lf };
  }

  it("creates paired pose instances as ONE undoable step and marks the project dirty", async () => {
    const { labels, pose } = setupSeeded(2);
    expect(useAppStore.getState().hasChanges).toBe(false);

    await ctx.execute(PairPoseInstances);

    const poseCount = () =>
      labels.labeledFrames[0].instances.filter((i) => i.skeleton === pose).length;
    expect(poseCount()).toBe(2);
    expect(useAppStore.getState().hasChanges).toBe(true);
    expect(ctx.canUndo).toBe(true);

    // One undo removes ALL created pose instances.
    expect(ctx.undo()).toBe(true);
    expect(poseCount()).toBe(0);
  });

  it("links each centroid to the pose instance it created", async () => {
    const { labels } = setupSeeded(2);

    await ctx.execute(PairPoseInstances);

    const lf = labels.labeledFrames[0];
    // Every centroid carries an explicit back-link, and no two share a pose.
    const linked = lf.centroids.map((c) => lf.instances.indexOf(c.instance!));
    expect(linked).toEqual([0, 1]);
  });

  it("is a true no-op when every centroid is already paired AND linked", async () => {
    setupSeeded(1);
    await ctx.execute(PairPoseInstances); // pairs + links the one centroid
    expect(ctx.canUndo).toBe(true);

    // Re-run on the already-paired project: no new undo entry, no dirty flag.
    resetStore();
    ctx = new CommandContext();
    const { labels, pose } = setupSeeded(1);
    const paired = Instance.empty({ skeleton: pose });
    labels.labeledFrames[0].instances.push(paired);
    labels.labeledFrames[0].centroids[0].instance = paired;

    await ctx.execute(PairPoseInstances);

    expect(ctx.canUndo).toBe(false);
    expect(useAppStore.getState().hasChanges).toBe(false);
    expect(
      labels.labeledFrames[0].instances.filter((i) => i.skeleton === pose).length,
    ).toBe(1);
  });

  it("filling in a MISSING link is a real, undoable change (not a no-op)", async () => {
    // Poses already exist but carry no back-link — e.g. a project paired by an
    // older build. Assigning the links is a data change, so it must be undoable.
    const { labels, pose } = setupSeeded(1);
    const paired = Instance.empty({ skeleton: pose });
    labels.labeledFrames[0].instances.push(paired);

    await ctx.execute(PairPoseInstances);

    expect(labels.labeledFrames[0].centroids[0].instance).toBe(paired);
    expect(ctx.canUndo).toBe(true);
    expect(useAppStore.getState().hasChanges).toBe(true);
  });
});
