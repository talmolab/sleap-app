/**
 * Net-neutral flow test for the visual skeleton builder (Task 5).
 *
 * Drives the STORE + COMMANDS directly (not the React pointer handlers) to prove
 * the two-stage place/connect flow and, crucially, the *net-neutral* invariant:
 * building a skeleton on the canvas never inserts a phantom labeled instance into
 * `labels`. Scratch positions live only in `builderPositions`; the skeleton graph
 * is mutated exclusively via the undoable AddNode/AddEdge commands.
 *
 * The connect step mirrors the production handler's algorithm exactly: walk the
 * stroke's segments, call `nodesCrossedBySegment` per segment, and chain edges
 * with a manual `penLast` cursor gated by `isValidEdgeSelection` — the same
 * composition `handleMouseMove` performs (NOT the `penStrokeToEdges` convenience
 * wrapper, which is exported + unit-tested separately in Task 1).
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import { CommandContext } from "@/commands/CommandContext";
import { useAppStore } from "@/stores/appStore";
import { AddNodeCommand, AddEdgeCommand } from "@/commands/skeletonCommands";
import { nodesCrossedBySegment } from "@/lib/skeletonPenChain";
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

/**
 * Replay a connect-stage pen stroke exactly like `handleMouseMove` does: iterate
 * the stroke's segments, find nodes crossed by each, and chain `penLast → n`
 * edges through the `isValidEdgeSelection` gate + `AddEdgeCommand`. Returns the
 * ordered [src, dst] name pairs actually created.
 */
async function connectWithPen(
  ctx: CommandContext,
  skeleton: Skeleton,
  positions: ({ x: number; y: number } | null)[],
  threshold: number,
  stroke: { x: number; y: number }[]
): Promise<Array<[string, string]>> {
  const created: Array<[string, string]> = [];
  let penLast: number | null = null; // starts on empty space, like a fresh stroke
  for (let i = 0; i + 1 < stroke.length; i++) {
    const crossed = nodesCrossedBySegment(positions, threshold, stroke[i], stroke[i + 1]);
    for (const n of crossed) {
      const last: number | null = penLast;
      if (n === last) continue;
      if (last !== null) {
        const srcName = skeleton.nodes[last].name;
        const dstName = skeleton.nodes[n].name;
        if (isValidEdgeSelection(skeleton.nodes, skeleton.edges, srcName, dstName)) {
          await ctx.execute(AddEdgeCommand, { srcName, dstName });
          created.push([srcName, dstName]);
        }
      }
      penLast = n;
    }
  }
  return created;
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

    // --- Stage 2: a single pen stroke through all 3 node hit-circles, replayed
    // with the handler's own segment-crossing + penLast chaining.
    useAppStore.getState().setSkeletonBuildStage("connect");
    const R = 8; // hit radius (scene space)
    const stroke = [
      { x: 0, y: 10 },
      { x: 100, y: 10 },
    ];
    const bp = useAppStore.getState().builderPositions;
    const created = await connectWithPen(ctx, skeleton, bp, R, stroke);
    // Entry order along the segment → chained edges node_0→node_1, node_1→node_2.
    expect(created).toEqual([
      ["node_0", "node_1"],
      ["node_1", "node_2"],
    ]);

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
    const stroke = [
      { x: 0, y: 10 },
      { x: 60, y: 10 },
    ];

    // First stroke: creates 0 → 1.
    const first = await connectWithPen(ctx, skeleton, bp, R, stroke);
    expect(first).toEqual([["node_0", "node_1"]]);
    expect(skeleton.edges.length).toBe(1);

    // Second stroke re-crosses the same 0 → 1 pair: the gate drops the dup.
    const second = await connectWithPen(ctx, skeleton, bp, R, stroke);
    expect(second).toEqual([]);
    expect(skeleton.edges.length).toBe(1);
  });
});
