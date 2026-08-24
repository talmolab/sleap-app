/**
 * Tests for ToggleNegativeFrame: mark/unmark a frame as a negative (background)
 * example, incl. creating an empty flagged frame and undo (the snapshot now
 * captures `isNegative`).
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import { CommandContext } from "@/commands/CommandContext";
import { useAppStore } from "@/stores/appStore";
import { ToggleNegativeFrame } from "@/commands/editCommands";
import {
  Labels,
  LabeledFrame,
  Instance,
  Video,
  Skeleton,
} from "@talmolab/sleap-io.js";

function resetStore() {
  useAppStore.setState(useAppStore.getInitialState());
}
function makeSkeleton(): Skeleton {
  const s = new Skeleton({ nodes: ["a", "b"], name: "s" });
  s.addEdge(s.nodes[0], s.nodes[1]);
  return s;
}
function makeVideo(): Video {
  return new Video({
    filename: "/v/clip.mp4",
    backendMetadata: { shape: [100, 480, 640, 3] },
    openBackend: false,
  });
}
function userInst(sk: Skeleton): Instance {
  return Instance.fromArray([[10, 10], [11, 11]], sk);
}

/** Base: video, frame 0 has one user instance. */
function setup() {
  const sk = makeSkeleton();
  const video = makeVideo();
  const labels = new Labels({
    labeledFrames: [
      new LabeledFrame({ video, frameIdx: 0, instances: [userInst(sk)] }),
    ],
    skeletons: [sk],
    videos: [video],
  });
  useAppStore.getState().setLabels(labels, "test.slp");
  return { labels, video };
}
const at = (labels: Labels, video: Video, f: number) =>
  labels.find({ video, frameIdx: f });

describe("ToggleNegativeFrame", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    resetStore();
    ctx = new CommandContext();
  });

  it("marks an empty frame negative (creating it); undo removes it", async () => {
    const { labels, video } = setup();
    useAppStore.getState().setFrameIdx(3); // no frame here yet

    await ctx.execute(ToggleNegativeFrame);
    expect(at(labels, video, 3)).toHaveLength(1);
    expect(at(labels, video, 3)[0].isNegative).toBe(true);
    expect(at(labels, video, 3)[0].instances).toHaveLength(0);

    expect(ctx.undo()).toBe(true);
    expect(at(labels, video, 3)).toHaveLength(0);
  });

  it("toggles an existing frame's flag; undo reverts it", async () => {
    const { labels, video } = setup();
    useAppStore.getState().setFrameIdx(0);

    await ctx.execute(ToggleNegativeFrame);
    expect(at(labels, video, 0)[0].isNegative).toBe(true);
    expect(at(labels, video, 0)[0].instances).toHaveLength(1); // kept (has instance)

    expect(ctx.undo()).toBe(true);
    expect(at(labels, video, 0)[0].isNegative).toBe(false);
  });

  // Regression: the seekbar marks memo + canvas overlays recompute only when
  // overlayVersion changes (labels is mutated in place). A menu/shortcut toggle
  // has no canvas path to bump it, so without an explicit bump the negative
  // tick's color went stale until an unrelated bump (e.g. holding Shift).
  it("bumps overlayVersion so the seekbar marks repaint", async () => {
    setup();

    // Toggling an existing labeled frame must notify overlay/seekbar consumers.
    useAppStore.getState().setFrameIdx(0);
    let before = useAppStore.getState().overlayVersion;
    await ctx.execute(ToggleNegativeFrame);
    expect(useAppStore.getState().overlayVersion).toBeGreaterThan(before);

    // Creating a negative frame where none existed must also notify them.
    useAppStore.getState().setFrameIdx(5);
    before = useAppStore.getState().overlayVersion;
    await ctx.execute(ToggleNegativeFrame);
    expect(useAppStore.getState().overlayVersion).toBeGreaterThan(before);
  });
});
