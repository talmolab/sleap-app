/**
 * Net-neutral flow test for the visual skeleton builder (Task 5).
 *
 * Drives the STORE + COMMANDS directly (not the React pointer handlers) to prove
 * the two-stage place/connect flow and, crucially, the *net-neutral* invariant:
 * building a skeleton on the canvas never inserts a phantom labeled instance into
 * `labels`. Scratch positions live only in `builderPositions`; the skeleton graph
 * is mutated exclusively via the undoable AddNode/AddEdge commands.
 *
 * This mirrors the exact call sequence the VideoPlayer handlers perform:
 *   place:   AddNodeCommand → syncBuilderPositions → setBuilderPosition
 *   connect: penStrokeToEdges → (isValidEdgeSelection ?) AddEdgeCommand
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import { CommandContext } from "@/commands/CommandContext";
import { useAppStore } from "@/stores/appStore";
import { AddNodeCommand, AddEdgeCommand } from "@/commands/skeletonCommands";
import { penStrokeToEdges } from "@/lib/skeletonPenChain";
import { isValidEdgeSelection } from "@/lib/skeletonEdgeEditing";
import { Labels, LabeledFrame, Skeleton, Video } from "@talmolab/sleap-io.js";

/** Reset the store between tests. */
function resetStore() {
  useAppStore.setState(useAppStore.getInitialState());
}

/** A project with a video, ONE empty labeled frame, and an EMPTY skeleton. */
function setupEmptyProject() {
  const skeleton = new Skeleton({ nodes: [], name: "builder" });

  const video = new Video({
    filename: "test.mp4",
    backendMetadata: { shape: [100, 480, 640, 3] },
    openBackend: false,
  });

  const labels = new Labels({ videos: [video], skeletons: [skeleton] });
  // A labeled frame with NO instances — the net-neutral baseline. If the builder
  // ever leaked its scratch skeleton into labels, this frame's instance count
  // would grow above 0.
  labels.labeledFrames.push(new LabeledFrame({ video, frameIdx: 0 }));

  useAppStore.getState().setLabels(labels, "test.slp");
  return { labels, skeleton, video };
}

describe("Skeleton builder net-neutral flow", () => {
  let ctx: CommandContext;

  beforeEach(() => {
    resetStore();
    ctx = new CommandContext();
  });

  it("places 3 nodes + connects 2 edges without adding any labeled instance", async () => {
    const { labels, skeleton } = setupEmptyProject();

    // Baseline: no instances anywhere.
    const instancesBefore = labels.labeledFrames.reduce(
      (n, lf) => n + lf.instances.length,
      0
    );
    expect(instancesBefore).toBe(0);

    useAppStore.getState().enterSkeletonBuild();
    expect(useAppStore.getState().skeletonBuildMode).toBe(true);
    expect(useAppStore.getState().skeletonBuildStage).toBe("place");

    // --- Stage 1: place 3 collinear nodes (mirrors handleMouseDown place path).
    const placed = [
      { x: 10, y: 10 },
      { x: 50, y: 10 },
      { x: 90, y: 10 },
    ];
    for (let i = 0; i < placed.length; i++) {
      await ctx.execute(AddNodeCommand, { name: `node_${i}` });
      useAppStore.getState().syncBuilderPositions();
      useAppStore.getState().setBuilderPosition(i, placed[i]);
    }

    expect(skeleton.nodes.length).toBe(3);
    // builderPositions stays index-aligned to the node list.
    expect(useAppStore.getState().builderPositions).toEqual(placed);

    // --- Stage 2: a single pen stroke through all 3 node hit-circles.
    useAppStore.getState().setSkeletonBuildStage("connect");
    const R = 8; // hit radius (scene space)
    const stroke = [
      { x: 0, y: 10 },
      { x: 100, y: 10 },
    ];
    const bp = useAppStore.getState().builderPositions;
    const pairs = penStrokeToEdges(bp, R, stroke);
    // Entry order along the segment → chained edges 0→1, 1→2.
    expect(pairs).toEqual([
      [0, 1],
      [1, 2],
    ]);

    for (const [s, d] of pairs) {
      const srcName = skeleton.nodes[s].name;
      const dstName = skeleton.nodes[d].name;
      if (isValidEdgeSelection(skeleton.nodes, skeleton.edges, srcName, dstName)) {
        await ctx.execute(AddEdgeCommand, { srcName, dstName });
      }
    }

    // --- Assertions: skeleton got the 3 nodes + 2 ordered edges …
    expect(skeleton.nodes.length).toBe(3);
    expect(skeleton.edges.length).toBe(2);
    expect([
      skeleton.edges[0].source.name,
      skeleton.edges[0].destination.name,
    ]).toEqual(["node_0", "node_1"]);
    expect([
      skeleton.edges[1].source.name,
      skeleton.edges[1].destination.name,
    ]).toEqual(["node_1", "node_2"]);

    // … and NO phantom labeled instance was ever inserted (net-neutral).
    const instancesAfter = labels.labeledFrames.reduce(
      (n, lf) => n + lf.instances.length,
      0
    );
    expect(instancesAfter).toBe(instancesBefore);
    expect(labels.labeledFrames[0].instances.length).toBe(0);

    // --- Exiting the builder keeps the built skeleton and discards the scratch.
    useAppStore.getState().exitSkeletonBuild();
    expect(useAppStore.getState().skeletonBuildMode).toBe(false);
    expect(skeleton.nodes.length).toBe(3);
    expect(skeleton.edges.length).toBe(2);
    expect(useAppStore.getState().builderPositions).toEqual([]);
  });

  it("rejects duplicate edges when a stroke re-crosses a connected pair", async () => {
    const { skeleton } = setupEmptyProject();
    useAppStore.getState().enterSkeletonBuild();

    const placed = [
      { x: 10, y: 10 },
      { x: 50, y: 10 },
    ];
    for (let i = 0; i < placed.length; i++) {
      await ctx.execute(AddNodeCommand, { name: `node_${i}` });
      useAppStore.getState().syncBuilderPositions();
      useAppStore.getState().setBuilderPosition(i, placed[i]);
    }

    useAppStore.getState().setSkeletonBuildStage("connect");
    const R = 8;
    const bp = useAppStore.getState().builderPositions;

    // First stroke: 0 → 1.
    for (const [s, d] of penStrokeToEdges(bp, R, [
      { x: 0, y: 10 },
      { x: 60, y: 10 },
    ])) {
      const srcName = skeleton.nodes[s].name;
      const dstName = skeleton.nodes[d].name;
      if (isValidEdgeSelection(skeleton.nodes, skeleton.edges, srcName, dstName)) {
        await ctx.execute(AddEdgeCommand, { srcName, dstName });
      }
    }
    expect(skeleton.edges.length).toBe(1);

    // Second stroke re-crosses the same 0 → 1 pair: validation drops the dup.
    for (const [s, d] of penStrokeToEdges(bp, R, [
      { x: 0, y: 10 },
      { x: 60, y: 10 },
    ])) {
      const srcName = skeleton.nodes[s].name;
      const dstName = skeleton.nodes[d].name;
      if (isValidEdgeSelection(skeleton.nodes, skeleton.edges, srcName, dstName)) {
        await ctx.execute(AddEdgeCommand, { srcName, dstName });
      }
    }
    expect(skeleton.edges.length).toBe(1);
  });
});
