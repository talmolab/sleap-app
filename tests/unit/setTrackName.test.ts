/**
 * Tests for SetTrackName: rename a track (propagates to all instances since they
 * share the Track object) and undo (the snapshot captures track names by value).
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import { CommandContext } from "@/commands/CommandContext";
import { useAppStore } from "@/stores/appStore";
import { SetTrackName } from "@/commands/trackCommands";
import {
  Labels,
  LabeledFrame,
  Instance,
  Video,
  Skeleton,
  Track,
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

/** Base: one instance on frame 0 assigned to a track named "animal1". */
function setup() {
  const sk = makeSkeleton();
  const video = makeVideo();
  const track = new Track("animal1");
  const inst = Instance.fromArray([[10, 10], [11, 11]], sk);
  inst.track = track;
  const labels = new Labels({
    labeledFrames: [
      new LabeledFrame({ video, frameIdx: 0, instances: [inst] }),
    ],
    skeletons: [sk],
    videos: [video],
    tracks: [track],
  });
  useAppStore.getState().setLabels(labels, "test.slp");
  useAppStore.getState().setFrameIdx(0);
  return { labels, track, inst };
}

describe("SetTrackName", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    resetStore();
    ctx = new CommandContext();
  });

  it("renames the track (propagating to the instance); undo reverts", async () => {
    const { track, inst } = setup();

    await ctx.execute(SetTrackName, { track, name: "left" });
    expect(track.name).toBe("left");
    expect(inst.track?.name).toBe("left"); // shared object → propagated

    expect(ctx.undo()).toBe(true);
    expect(track.name).toBe("animal1");
    expect(inst.track?.name).toBe("animal1");
  });

  it("ignores blank / unchanged names", async () => {
    const { track } = setup();
    await ctx.execute(SetTrackName, { track, name: "   " });
    expect(track.name).toBe("animal1");
    await ctx.execute(SetTrackName, { track, name: "animal1" });
    expect(track.name).toBe("animal1");
  });
});
