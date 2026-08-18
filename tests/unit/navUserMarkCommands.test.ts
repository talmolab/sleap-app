/**
 * Tests for GoPrevUserFrame (mirror of GoNextUserFrame) and GoToMarkedFrame
 * (jump to the ⌘M bookmark).
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import { CommandContext } from "@/commands/CommandContext";
import { useAppStore } from "@/stores/appStore";
import { GoPrevUserFrame, GoToMarkedFrame } from "@/commands/navCommands";
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
function makeVideo(filename = "/v/clip.mp4"): Video {
  return new Video({
    filename,
    backendMetadata: { shape: [100, 480, 640, 3] },
    openBackend: false,
  });
}
function userInst(sk: Skeleton): Instance {
  return Instance.fromArray([[10, 10], [11, 11]], sk);
}

/** User-labeled frames at 0, 5, 10 on one video. */
function setup() {
  const sk = makeSkeleton();
  const video = makeVideo();
  const labels = new Labels({
    labeledFrames: [0, 5, 10].map(
      (f) => new LabeledFrame({ video, frameIdx: f, instances: [userInst(sk)] })
    ),
    skeletons: [sk],
    videos: [video],
  });
  useAppStore.getState().setLabels(labels, "test.slp");
  return { labels, video };
}

describe("GoPrevUserFrame", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    resetStore();
    ctx = new CommandContext();
  });

  it("goes to the previous user-labeled frame", async () => {
    setup();
    useAppStore.getState().setFrameIdx(10);
    await ctx.execute(GoPrevUserFrame);
    expect(useAppStore.getState().frameIdx).toBe(5);
  });

  it("wraps to the last user frame when at/before the first", async () => {
    setup();
    useAppStore.getState().setFrameIdx(0);
    await ctx.execute(GoPrevUserFrame);
    expect(useAppStore.getState().frameIdx).toBe(10);
  });
});

describe("GoToMarkedFrame", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    resetStore();
    ctx = new CommandContext();
  });

  it("jumps to the bookmarked frame", async () => {
    const { video } = setup();
    useAppStore.getState().setMarkedFrame({ video, frameIdx: 5 });
    useAppStore.getState().setFrameIdx(0);
    await ctx.execute(GoToMarkedFrame);
    expect(useAppStore.getState().frameIdx).toBe(5);
  });

  it("is a no-op when no frame is marked", async () => {
    setup();
    useAppStore.getState().setMarkedFrame(null);
    useAppStore.getState().setFrameIdx(3);
    await ctx.execute(GoToMarkedFrame);
    expect(useAppStore.getState().frameIdx).toBe(3);
  });
});
