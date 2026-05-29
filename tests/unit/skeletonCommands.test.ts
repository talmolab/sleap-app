/**
 * Tests for skeleton editing commands.
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import { CommandContext } from "@/commands/CommandContext";
import { useAppStore } from "@/stores/appStore";
import {
  AddNodeCommand,
  DeleteNodeCommand,
  AddEdgeCommand,
  DeleteEdgeCommand,
  RenameNodeCommand,
  LoadSkeletonTemplateCommand,
  installSkeletonUndoInterceptor,
} from "@/commands/skeletonCommands";
import {
  Labels,
  Instance,
  LabeledFrame,
  Skeleton,
  Node,
  Edge,
  Video,
  Track,
} from "@talmolab/sleap-io.js";

/** Reset the store between tests. */
function resetStore() {
  useAppStore.setState(useAppStore.getInitialState());
}

/**
 * Create a test project for skeleton command testing.
 */
function createTestProject(opts?: {
  numNodes?: number;
  numFrames?: number;
  numInstancesPerFrame?: number;
}) {
  const numNodes = opts?.numNodes ?? 3;
  const numFrames = opts?.numFrames ?? 2;
  const numInstancesPerFrame = opts?.numInstancesPerFrame ?? 1;

  const nodeNames = Array.from({ length: numNodes }, (_, i) => `node_${i}`);
  const skeleton = new Skeleton({ nodes: nodeNames, name: "test" });
  if (numNodes >= 2) {
    skeleton.addEdge(skeleton.nodes[0], skeleton.nodes[1]);
  }

  const video = {
    filename: "test.mp4",
    shape: [100, 480, 640, 3] as [number, number, number, number],
    backend: null,
    sourceVideo: null,
    backendMetadata: {},
  } as unknown as Video;

  const labels = new Labels({
    videos: [video],
    skeletons: [skeleton],
  });

  const labeledFrames: LabeledFrame[] = [];
  for (let f = 0; f < numFrames; f++) {
    const lf = new LabeledFrame({ video, frameIdx: f * 10 });
    for (let i = 0; i < numInstancesPerFrame; i++) {
      const inst = Instance.empty({ skeleton });
      for (let n = 0; n < numNodes; n++) {
        inst.points[n].xy = [10 * n + f, 20 * n + i];
        inst.points[n].visible = true;
        inst.points[n].complete = true;
      }
      lf.instances.push(inst);
    }
    labels.labeledFrames.push(lf);
    labeledFrames.push(lf);
  }

  return { labels, skeleton, video, labeledFrames };
}

/** Set up store with a test project. */
function setupProject(opts?: Parameters<typeof createTestProject>[0]) {
  const project = createTestProject(opts);
  useAppStore.getState().setLabels(project.labels, "test.slp");
  return project;
}

describe("Skeleton commands", () => {
  let ctx: CommandContext;

  beforeEach(() => {
    resetStore();
    ctx = new CommandContext();
  });

  describe("AddNodeCommand", () => {
    it("adds a node to the skeleton", async () => {
      const project = setupProject({ numNodes: 2 });
      const before = project.skeleton.nodes.length;

      await ctx.execute(AddNodeCommand, { name: "new_node" });

      expect(project.skeleton.nodes.length).toBe(before + 1);
      expect(project.skeleton.nodes[before].name).toBe("new_node");
    });

    it("adds a NaN point to all instances", async () => {
      const project = setupProject({ numNodes: 2, numFrames: 2, numInstancesPerFrame: 2 });

      await ctx.execute(AddNodeCommand, { name: "extra" });

      for (const lf of project.labels.labeledFrames) {
        for (const inst of lf.instances) {
          // Should now have 3 points (was 2)
          expect(inst.points.length).toBe(3);
          // The new point should be NaN
          const lastPoint = inst.points[inst.points.length - 1];
          expect(isNaN(lastPoint.xy[0])).toBe(true);
          expect(isNaN(lastPoint.xy[1])).toBe(true);
          expect(lastPoint.name).toBe("extra");
        }
      }
    });

    it("does nothing with empty name", async () => {
      const project = setupProject({ numNodes: 2 });
      const before = project.skeleton.nodes.length;

      await ctx.execute(AddNodeCommand, { name: "" });
      expect(project.skeleton.nodes.length).toBe(before);

      await ctx.execute(AddNodeCommand, { name: "  " });
      expect(project.skeleton.nodes.length).toBe(before);
    });

    it("does nothing without skeleton", async () => {
      // No project loaded
      expect(() => ctx.execute(AddNodeCommand, { name: "test" })).not.toThrow();
    });

    it("trims whitespace from name", async () => {
      const project = setupProject({ numNodes: 2 });

      await ctx.execute(AddNodeCommand, { name: "  padded  " });

      const lastNode = project.skeleton.nodes[project.skeleton.nodes.length - 1];
      expect(lastNode.name).toBe("padded");
    });
  });

  describe("DeleteNodeCommand", () => {
    it("removes a node from the skeleton", async () => {
      const project = setupProject({ numNodes: 3 });
      const before = project.skeleton.nodes.length;

      await ctx.execute(DeleteNodeCommand, { nodeIdx: 1 });

      expect(project.skeleton.nodes.length).toBe(before - 1);
    });

    it("removes edges referencing the deleted node", async () => {
      const project = setupProject({ numNodes: 3 });
      // Skeleton has edge: node_0 -> node_1
      expect(project.skeleton.edges.length).toBe(1);

      await ctx.execute(DeleteNodeCommand, { nodeIdx: 0 });

      // Edge should be removed since it referenced node_0
      expect(project.skeleton.edges.length).toBe(0);
    });

    it("removes corresponding point from instances", async () => {
      const project = setupProject({ numNodes: 3, numFrames: 2, numInstancesPerFrame: 1 });

      await ctx.execute(DeleteNodeCommand, { nodeIdx: 1 });

      for (const lf of project.labels.labeledFrames) {
        for (const inst of lf.instances) {
          expect(inst.points.length).toBe(2);
        }
      }
    });

    it("does nothing for out-of-bounds nodeIdx", async () => {
      const project = setupProject({ numNodes: 3 });
      const before = project.skeleton.nodes.length;

      await ctx.execute(DeleteNodeCommand, { nodeIdx: -1 });
      expect(project.skeleton.nodes.length).toBe(before);

      await ctx.execute(DeleteNodeCommand, { nodeIdx: 100 });
      expect(project.skeleton.nodes.length).toBe(before);
    });

    it("does nothing without nodeIdx", async () => {
      const project = setupProject({ numNodes: 3 });
      const before = project.skeleton.nodes.length;

      await ctx.execute(DeleteNodeCommand, {});
      expect(project.skeleton.nodes.length).toBe(before);
    });
  });

  describe("AddEdgeCommand", () => {
    it("adds an edge between two nodes", async () => {
      const project = setupProject({ numNodes: 3 });
      const before = project.skeleton.edges.length;

      await ctx.execute(AddEdgeCommand, { srcName: "node_1", dstName: "node_2" });

      expect(project.skeleton.edges.length).toBe(before + 1);
      const newEdge = project.skeleton.edges[project.skeleton.edges.length - 1];
      expect(newEdge.source.name).toBe("node_1");
      expect(newEdge.destination.name).toBe("node_2");
    });

    it("does nothing for non-existent node names", async () => {
      const project = setupProject({ numNodes: 3 });
      const before = project.skeleton.edges.length;

      await ctx.execute(AddEdgeCommand, { srcName: "fake_node", dstName: "node_1" });
      expect(project.skeleton.edges.length).toBe(before);
    });

    it("does nothing without params", async () => {
      const project = setupProject({ numNodes: 3 });
      const before = project.skeleton.edges.length;

      await ctx.execute(AddEdgeCommand, {});
      expect(project.skeleton.edges.length).toBe(before);
    });
  });

  describe("DeleteEdgeCommand", () => {
    it("removes an edge from the skeleton", async () => {
      const project = setupProject({ numNodes: 3 });
      // Has 1 edge by default
      expect(project.skeleton.edges.length).toBe(1);

      await ctx.execute(DeleteEdgeCommand, { edgeIdx: 0 });

      expect(project.skeleton.edges.length).toBe(0);
    });

    it("does nothing for out-of-bounds edgeIdx", async () => {
      const project = setupProject({ numNodes: 3 });

      await ctx.execute(DeleteEdgeCommand, { edgeIdx: -1 });
      expect(project.skeleton.edges.length).toBe(1);

      await ctx.execute(DeleteEdgeCommand, { edgeIdx: 100 });
      expect(project.skeleton.edges.length).toBe(1);
    });

    it("does nothing without edgeIdx", async () => {
      const project = setupProject({ numNodes: 3 });

      await ctx.execute(DeleteEdgeCommand, {});
      expect(project.skeleton.edges.length).toBe(1);
    });
  });

  describe("RenameNodeCommand", () => {
    it("renames a node in the skeleton", async () => {
      const project = setupProject({ numNodes: 3 });

      await ctx.execute(RenameNodeCommand, { nodeIdx: 0, newName: "head" });

      expect(project.skeleton.nodes[0].name).toBe("head");
    });

    it("updates point names in all instances", async () => {
      const project = setupProject({ numNodes: 3, numFrames: 2, numInstancesPerFrame: 1 });

      await ctx.execute(RenameNodeCommand, { nodeIdx: 0, newName: "renamed" });

      for (const lf of project.labels.labeledFrames) {
        for (const inst of lf.instances) {
          expect(inst.points[0].name).toBe("renamed");
        }
      }
    });

    it("does nothing for out-of-bounds nodeIdx", async () => {
      const project = setupProject({ numNodes: 3 });
      const origName = project.skeleton.nodes[0].name;

      await ctx.execute(RenameNodeCommand, { nodeIdx: -1, newName: "test" });
      expect(project.skeleton.nodes[0].name).toBe(origName);

      await ctx.execute(RenameNodeCommand, { nodeIdx: 100, newName: "test" });
      expect(project.skeleton.nodes[0].name).toBe(origName);
    });

    it("does nothing with empty newName", async () => {
      const project = setupProject({ numNodes: 3 });
      const origName = project.skeleton.nodes[0].name;

      await ctx.execute(RenameNodeCommand, { nodeIdx: 0, newName: "" });
      expect(project.skeleton.nodes[0].name).toBe(origName);

      await ctx.execute(RenameNodeCommand, { nodeIdx: 0, newName: "  " });
      expect(project.skeleton.nodes[0].name).toBe(origName);
    });

    it("trims whitespace from new name", async () => {
      const project = setupProject({ numNodes: 3 });

      await ctx.execute(RenameNodeCommand, { nodeIdx: 0, newName: "  head  " });
      expect(project.skeleton.nodes[0].name).toBe("head");
    });
  });

  describe("LoadSkeletonTemplateCommand", () => {
    it("loads a fly template", async () => {
      const project = setupProject({ numNodes: 3 });

      await ctx.execute(LoadSkeletonTemplateCommand, { templateId: "fly" });

      expect(project.skeleton.nodes.length).toBe(32);
      expect(project.skeleton.edges.length).toBeGreaterThan(0);
      expect(project.skeleton.nodes[0].name).toBe("head");
    });

    it("loads a human template", async () => {
      const project = setupProject({ numNodes: 3 });

      await ctx.execute(LoadSkeletonTemplateCommand, { templateId: "human" });

      expect(project.skeleton.nodes.length).toBe(17);
      expect(project.skeleton.nodes[0].name).toBe("nose");
    });

    it("resets instance points to match new node count", async () => {
      const project = setupProject({ numNodes: 3, numFrames: 2, numInstancesPerFrame: 1 });

      await ctx.execute(LoadSkeletonTemplateCommand, { templateId: "celegans" });

      for (const lf of project.labels.labeledFrames) {
        for (const inst of lf.instances) {
          expect(inst.points.length).toBe(2);
          // Points should be NaN (reset)
          expect(isNaN(inst.points[0].xy[0])).toBe(true);
        }
      }
    });

    it("does nothing for unknown templateId", async () => {
      const project = setupProject({ numNodes: 3 });
      const before = project.skeleton.nodes.length;

      await ctx.execute(LoadSkeletonTemplateCommand, { templateId: "nonexistent" });

      expect(project.skeleton.nodes.length).toBe(before);
    });

    it("does nothing without templateId", async () => {
      const project = setupProject({ numNodes: 3 });
      const before = project.skeleton.nodes.length;

      await ctx.execute(LoadSkeletonTemplateCommand, {});

      expect(project.skeleton.nodes.length).toBe(before);
    });

    it("loads custom (empty) template", async () => {
      const project = setupProject({ numNodes: 3 });

      await ctx.execute(LoadSkeletonTemplateCommand, { templateId: "custom" });

      expect(project.skeleton.nodes.length).toBe(0);
      expect(project.skeleton.edges.length).toBe(0);
    });
  });

  describe("Skeleton undo with interceptor", () => {
    it("undo restores skeleton nodes after AddNode", async () => {
      const project = setupProject({ numNodes: 2, numFrames: 1, numInstancesPerFrame: 1 });
      installSkeletonUndoInterceptor(ctx);

      const beforeNodeCount = project.skeleton.nodes.length;

      await ctx.execute(AddNodeCommand, { name: "new_node" });

      expect(project.skeleton.nodes.length).toBe(beforeNodeCount + 1);

      ctx.undo();

      // Skeleton nodes should be restored
      expect(project.skeleton.nodes.length).toBe(beforeNodeCount);
    });

    it("undo restores skeleton nodes after DeleteNode", async () => {
      const project = setupProject({ numNodes: 3, numFrames: 1, numInstancesPerFrame: 1 });
      installSkeletonUndoInterceptor(ctx);

      const beforeNodeCount = project.skeleton.nodes.length;

      await ctx.execute(DeleteNodeCommand, { nodeIdx: 1 });

      expect(project.skeleton.nodes.length).toBe(beforeNodeCount - 1);

      ctx.undo();

      expect(project.skeleton.nodes.length).toBe(beforeNodeCount);
    });

    it("undo restores skeleton nodes after LoadTemplate", async () => {
      const project = setupProject({ numNodes: 3, numFrames: 1, numInstancesPerFrame: 1 });
      installSkeletonUndoInterceptor(ctx);

      const beforeNodeCount = project.skeleton.nodes.length;

      await ctx.execute(LoadSkeletonTemplateCommand, { templateId: "human" });

      expect(project.skeleton.nodes.length).toBe(17);

      ctx.undo();

      expect(project.skeleton.nodes.length).toBe(beforeNodeCount);
    });

    it("undo restores skeleton edges after DeleteEdge", async () => {
      const project = setupProject({ numNodes: 3 });
      installSkeletonUndoInterceptor(ctx);

      const beforeEdgeCount = project.skeleton.edges.length;

      await ctx.execute(DeleteEdgeCommand, { edgeIdx: 0 });

      expect(project.skeleton.edges.length).toBe(0);

      ctx.undo();

      expect(project.skeleton.edges.length).toBe(beforeEdgeCount);
    });
  });
});
