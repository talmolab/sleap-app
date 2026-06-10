/**
 * Tests for the undoable OpenSkeletonCommand (in-place skeleton import).
 *
 * Verifies the port of PyQt SLEAP `OpenSkeleton.do_action`:
 *   - matching nodes keep their xy (auto-matched by name),
 *   - explicitly linked (renamed) nodes carry the old xy,
 *   - new nodes get NaN points, removed nodes' points are dropped,
 *   - the project's single skeleton OBJECT is mutated in place (no append),
 *   - undo/redo restores both skeleton structure AND instance points,
 *   - instances are re-pointed at the (same) skeleton.
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import { CommandContext } from "@/commands/CommandContext";
import { useAppStore } from "@/stores/appStore";
import {
  OpenSkeletonCommand,
  installSkeletonUndoInterceptor,
} from "@/commands/skeletonCommands";
import {
  Labels,
  Instance,
  LabeledFrame,
  Skeleton,
  Video,
} from "@talmolab/sleap-io.js";

/** Reset the store between tests. */
function resetStore() {
  useAppStore.setState(useAppStore.getInitialState());
}

/**
 * Build a test project whose single skeleton has the given node names, an edge
 * between the first two nodes, and one labeled instance with KNOWN per-node xy
 * so point-preservation can be asserted.
 *
 * Each node `node_i` gets point xy = [10 * i, 20 * i].
 */
function createTestProject(nodeNames: string[]) {
  const skeleton = new Skeleton({ nodes: nodeNames, name: "test" });
  if (nodeNames.length >= 2) {
    skeleton.addEdge(skeleton.nodes[0], skeleton.nodes[1]);
  }

  const video = new Video({
    filename: "test.mp4",
    backendMetadata: { shape: [100, 480, 640, 3] },
    openBackend: false,
  });

  const labels = new Labels({ videos: [video], skeletons: [skeleton] });

  const lf = new LabeledFrame({ video, frameIdx: 0 });
  const inst = Instance.empty({ skeleton });
  for (let n = 0; n < nodeNames.length; n++) {
    inst.points[n].xy = [10 * n, 20 * n];
    inst.points[n].visible = true;
    inst.points[n].complete = true;
  }
  lf.instances.push(inst);
  labels.labeledFrames.push(lf);

  return { labels, skeleton, video, labeledFrame: lf, instance: inst };
}

/** Set up the store with a test project. */
function setupProject(nodeNames: string[]) {
  const project = createTestProject(nodeNames);
  useAppStore.getState().setLabels(project.labels, "test.slp");
  return project;
}

/** Look up an instance point by its node name. */
function pointByName(inst: Instance, name: string) {
  return inst.points.find((p) => p.name === name);
}

describe("OpenSkeletonCommand", () => {
  let ctx: CommandContext;

  beforeEach(() => {
    resetStore();
    ctx = new CommandContext();
  });

  it("preserves matching nodes' xy, NaNs new nodes, drops removed nodes", async () => {
    // Old: node_0, node_1, node_2 (xy = [0,0], [10,20], [20,40]).
    const project = setupProject(["node_0", "node_1", "node_2"]);
    const inst = project.instance;

    // New skeleton shares node_1, drops node_0 & node_2, adds head & tail.
    const newSkeleton = new Skeleton({
      nodes: ["head", "node_1", "tail"],
      name: "imported",
    });
    newSkeleton.addEdge(newSkeleton.nodes[0], newSkeleton.nodes[1]);

    await ctx.execute(OpenSkeletonCommand, { newSkeleton });

    // Skeleton structure now equals the new skeleton (same object identity).
    expect(project.skeleton.nodeNames).toEqual(["head", "node_1", "tail"]);
    expect(project.skeleton.edges.length).toBe(1);
    expect(project.skeleton.edges[0].source.name).toBe("head");
    expect(project.skeleton.edges[0].destination.name).toBe("node_1");

    // labels.skeletons membership unchanged (still 1, still the same object).
    expect(project.labels.skeletons.length).toBe(1);
    expect(project.labels.skeletons[0]).toBe(project.skeleton);

    // Instance points: aligned to new node order, length 3.
    expect(inst.points.length).toBe(3);

    // node_1 (matched by name) keeps its old xy = [10, 20].
    const kept = pointByName(inst, "node_1")!;
    expect(kept.xy).toEqual([10, 20]);
    expect(kept.visible).toBe(true);

    // head & tail are new → NaN.
    const head = pointByName(inst, "head")!;
    const tail = pointByName(inst, "tail")!;
    expect(isNaN(head.xy[0])).toBe(true);
    expect(isNaN(head.xy[1])).toBe(true);
    expect(isNaN(tail.xy[0])).toBe(true);
    expect(isNaN(tail.xy[1])).toBe(true);

    // node_0 & node_2 dropped → no point with those names remains.
    expect(pointByName(inst, "node_0")).toBeUndefined();
    expect(pointByName(inst, "node_2")).toBeUndefined();
  });

  it("carries old xy across an explicit linkMap rename", async () => {
    // Old node_1 has xy = [10, 20]; rename it to "thorax" in the new skeleton.
    const project = setupProject(["node_0", "node_1", "node_2"]);
    const inst = project.instance;

    const newSkeleton = new Skeleton({
      nodes: ["thorax", "abdomen"],
      name: "imported",
    });

    // linkMap: newName → oldName.
    const linkMap = new Map<string, string>([["thorax", "node_1"]]);

    await ctx.execute(OpenSkeletonCommand, { newSkeleton, linkMap });

    expect(project.skeleton.nodeNames).toEqual(["thorax", "abdomen"]);

    // "thorax" inherits node_1's old xy.
    const thorax = pointByName(inst, "thorax")!;
    expect(thorax.xy).toEqual([10, 20]);

    // "abdomen" is brand new → NaN.
    const abdomen = pointByName(inst, "abdomen")!;
    expect(isNaN(abdomen.xy[0])).toBe(true);
  });

  it("adopts the new skeleton when importing into a 0-node skeleton", async () => {
    const project = setupProject([]); // empty skeleton, no instance points
    expect(project.skeleton.nodes.length).toBe(0);

    const newSkeleton = new Skeleton({
      nodes: ["a", "b", "c"],
      name: "imported",
    });
    newSkeleton.addEdge(newSkeleton.nodes[0], newSkeleton.nodes[1]);
    newSkeleton.addEdge(newSkeleton.nodes[1], newSkeleton.nodes[2]);

    await ctx.execute(OpenSkeletonCommand, { newSkeleton });

    expect(project.skeleton.nodeNames).toEqual(["a", "b", "c"]);
    expect(project.skeleton.edges.length).toBe(2);
    expect(project.labels.skeletons.length).toBe(1);
    expect(project.labels.skeletons[0]).toBe(project.skeleton);
  });

  it("recreates symmetries by name (best-effort)", async () => {
    const project = setupProject(["node_0", "node_1"]);

    const newSkeleton = new Skeleton({
      nodes: ["left", "right"],
      symmetries: [["left", "right"]],
      name: "imported",
    });

    await ctx.execute(OpenSkeletonCommand, { newSkeleton });

    expect(project.skeleton.symmetryNames).toEqual([["left", "right"]]);
  });

  it("re-points every instance at the project skeleton", async () => {
    const project = setupProject(["node_0", "node_1", "node_2"]);
    const inst = project.instance;

    const newSkeleton = new Skeleton({ nodes: ["node_1", "x"], name: "imported" });

    await ctx.execute(OpenSkeletonCommand, { newSkeleton });

    expect(ctx.state.skeleton).toBe(project.skeleton);
    expect(inst.skeleton).toBe(project.skeleton);
  });

  it("does nothing without a loaded project", async () => {
    const newSkeleton = new Skeleton({ nodes: ["a"], name: "imported" });
    // No project loaded → no skeleton/labels in the store.
    await expect(
      ctx.execute(OpenSkeletonCommand, { newSkeleton }),
    ).resolves.toBeUndefined();
  });

  describe("undo / redo", () => {
    it("undo restores prior nodes/edges and instance points; redo re-applies", async () => {
      const project = setupProject(["node_0", "node_1", "node_2"]);
      installSkeletonUndoInterceptor(ctx);
      const inst = project.instance;

      const oldNames = [...project.skeleton.nodeNames];
      const oldEdgeCount = project.skeleton.edges.length;
      // node_1's old xy.
      const oldNode1Xy: [number, number] = [
        inst.points[1].xy[0],
        inst.points[1].xy[1],
      ];

      const newSkeleton = new Skeleton({
        nodes: ["head", "node_1", "tail"],
        name: "imported",
      });
      newSkeleton.addEdge(newSkeleton.nodes[0], newSkeleton.nodes[1]);

      await ctx.execute(OpenSkeletonCommand, { newSkeleton });
      expect(project.skeleton.nodeNames).toEqual(["head", "node_1", "tail"]);

      // --- undo ---
      ctx.undo();

      expect(project.skeleton.nodeNames).toEqual(oldNames);
      expect(project.skeleton.edges.length).toBe(oldEdgeCount);
      // Instance points restored to the old 3-node layout with node_1's xy.
      const restored = project.labels.labeledFrames[0].instances[0];
      expect(restored.points.length).toBe(3);
      expect(pointByName(restored, "node_1")!.xy).toEqual(oldNode1Xy);
      expect(pointByName(restored, "node_0")).toBeDefined();

      // --- redo ---
      ctx.redo();

      expect(project.skeleton.nodeNames).toEqual(["head", "node_1", "tail"]);
      const reapplied = project.labels.labeledFrames[0].instances[0];
      expect(pointByName(reapplied, "node_1")!.xy).toEqual(oldNode1Xy);
      expect(isNaN(pointByName(reapplied, "head")!.xy[0])).toBe(true);
    });
  });
});
