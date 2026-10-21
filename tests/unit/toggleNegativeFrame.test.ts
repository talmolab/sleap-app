/**
 * Tests for ToggleNegativeFrame: mark/unmark a frame as a negative (background)
 * example, incl. creating an empty flagged frame and undo (the snapshot now
 * captures `isNegative`). Matches SLEAP #2894: marking clears the frame's
 * instances (after `requestToggleNegativeFrame`'s confirm), and adding an
 * instance to a negative frame unmarks it.
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import { CommandContext } from "@/commands/CommandContext";
import { useAppStore } from "@/stores/appStore";
import { AddInstance, ToggleNegativeFrame } from "@/commands/editCommands";
import { GoNextUserFrame, GoPrevUserFrame } from "@/commands/navCommands";
import { requestToggleNegativeFrame } from "@/lib/negativeFrame";
import { useConfirmStore } from "@/stores/confirmStore";
import {
  Labels,
  LabeledFrame,
  Instance,
  PredictedInstance,
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

  it("marking a frame with instances removes them (user and predicted); undo brings them back", async () => {
    const { labels, video } = setup();
    const lf = at(labels, video, 0)[0];
    lf.instances.push(PredictedInstance.fromArray([[20, 20], [21, 21]], labels.skeletons[0]));
    useAppStore.getState().setFrameIdx(0);

    await ctx.execute(ToggleNegativeFrame);
    expect(at(labels, video, 0)[0].isNegative).toBe(true);
    expect(at(labels, video, 0)[0].instances).toHaveLength(0);
    expect(useAppStore.getState().instance).toBeNull();

    expect(ctx.undo()).toBe(true);
    expect(at(labels, video, 0)[0].isNegative).toBe(false);
    expect(at(labels, video, 0)[0].instances).toHaveLength(2);
  });

  it("unmarking an empty negative frame removes it", async () => {
    const { labels, video } = setup();
    useAppStore.getState().setFrameIdx(4);
    await ctx.execute(ToggleNegativeFrame);
    await ctx.execute(ToggleNegativeFrame);
    expect(at(labels, video, 4)).toHaveLength(0);
  });

  it("Next/Previous labeled frame stop on negative frames (SLEAP #2894)", async () => {
    setup(); // user instance on frame 0
    useAppStore.getState().setFrameIdx(40);
    await ctx.execute(ToggleNegativeFrame);
    useAppStore.getState().setFrameIdx(10);
    await ctx.execute(GoNextUserFrame);
    expect(useAppStore.getState().frameIdx).toBe(40);
    useAppStore.getState().setFrameIdx(60);
    await ctx.execute(GoPrevUserFrame);
    expect(useAppStore.getState().frameIdx).toBe(40);
  });

  it("adding an instance to a negative frame unmarks it", async () => {
    const { labels, video } = setup();
    useAppStore.getState().setFrameIdx(7);
    await ctx.execute(ToggleNegativeFrame);
    expect(at(labels, video, 7)[0].isNegative).toBe(true);

    await ctx.execute(AddInstance);
    expect(at(labels, video, 7)[0].instances).toHaveLength(1);
    expect(at(labels, video, 7)[0].isNegative).toBe(false);
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

describe("requestToggleNegativeFrame (menu, right-click, shortcut)", () => {
  let ctx: CommandContext;
  let confirms: string[];
  let answer: boolean;
  beforeEach(() => {
    resetStore();
    ctx = new CommandContext();
    confirms = [];
    answer = true;
    useConfirmStore.setState({
      confirm: async (req: { message: string }) => {
        confirms.push(req.message);
        return answer;
      },
    } as never);
  });

  it("asks first when the frame has instances, like SLEAP", async () => {
    const { labels, video } = setup();
    useAppStore.getState().setFrameIdx(0);
    await requestToggleNegativeFrame(ctx);
    expect(confirms).toEqual([
      "Frame 1 has 1 instance. Marking it as a negative (background) frame will remove it.\n\nContinue?",
    ]);
    expect(at(labels, video, 0)[0].isNegative).toBe(true);
  });

  it("declining changes nothing and leaves no undo step", async () => {
    const { labels, video } = setup();
    useAppStore.getState().setFrameIdx(0);
    answer = false;
    await requestToggleNegativeFrame(ctx);
    expect(at(labels, video, 0)[0].isNegative).toBe(false);
    expect(at(labels, video, 0)[0].instances).toHaveLength(1);
    expect(ctx.undo()).toBe(false);
  });

  it("doesn't ask for an empty frame, or when unmarking", async () => {
    const { labels, video } = setup();
    useAppStore.getState().setFrameIdx(9);
    await requestToggleNegativeFrame(ctx);
    await requestToggleNegativeFrame(ctx);
    expect(confirms).toEqual([]);
    expect(at(labels, video, 9)).toHaveLength(0);
  });
});
