/**
 * Tests for AddSymmetryCommand / RemoveSymmetryCommand — designate left/right
 * mirror node pairs, with undo via the skeleton undo interceptor.
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import { CommandContext } from "@/commands/CommandContext";
import { useAppStore } from "@/stores/appStore";
import {
  AddSymmetryCommand,
  RemoveSymmetryCommand,
  installSkeletonUndoInterceptor,
} from "@/commands/skeletonCommands";
import { Labels, Video, Skeleton } from "@talmolab/sleap-io.js";

function resetStore() {
  useAppStore.setState(useAppStore.getInitialState());
}
function setup() {
  const sk = new Skeleton({
    nodes: ["left_ear", "right_ear", "nose"],
    name: "s",
  });
  sk.addEdge(sk.nodes[0], sk.nodes[2]);
  const video = new Video({
    filename: "/v/clip.mp4",
    backendMetadata: { shape: [100, 480, 640, 3] },
    openBackend: false,
  });
  const labels = new Labels({
    labeledFrames: [],
    skeletons: [sk],
    videos: [video],
  });
  useAppStore.getState().setLabels(labels, "test.slp");
  return { sk };
}

describe("Skeleton symmetry commands", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    resetStore();
    ctx = new CommandContext();
  });

  it("adds a symmetry pair; undo removes it", async () => {
    const { sk } = setup();
    installSkeletonUndoInterceptor(ctx);
    expect(sk.symmetries).toHaveLength(0);

    await ctx.execute(AddSymmetryCommand, {
      node1: "left_ear",
      node2: "right_ear",
    });
    expect(sk.symmetries).toHaveLength(1);
    const pair = new Set([sk.symmetries[0].at(0).name, sk.symmetries[0].at(1).name]);
    expect(pair).toEqual(new Set(["left_ear", "right_ear"]));

    ctx.undo();
    expect(sk.symmetries).toHaveLength(0);
  });

  it("rejects self, duplicate, and already-symmetric nodes", async () => {
    const { sk } = setup();
    await ctx.execute(AddSymmetryCommand, { node1: "left_ear", node2: "right_ear" });
    // duplicate (unordered)
    await ctx.execute(AddSymmetryCommand, { node1: "right_ear", node2: "left_ear" });
    // self
    await ctx.execute(AddSymmetryCommand, { node1: "nose", node2: "nose" });
    // left_ear already in a symmetry
    await ctx.execute(AddSymmetryCommand, { node1: "left_ear", node2: "nose" });
    expect(sk.symmetries).toHaveLength(1);
  });

  it("removes a symmetry by index; undo restores it", async () => {
    const { sk } = setup();
    installSkeletonUndoInterceptor(ctx);
    await ctx.execute(AddSymmetryCommand, { node1: "left_ear", node2: "right_ear" });
    expect(sk.symmetries).toHaveLength(1);

    await ctx.execute(RemoveSymmetryCommand, { symmetryIdx: 0 });
    expect(sk.symmetries).toHaveLength(0);

    ctx.undo();
    expect(sk.symmetries).toHaveLength(1);
  });
});
