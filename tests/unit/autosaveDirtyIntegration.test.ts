/**
 * Thin integration tests: the CommandContext hooks feed the dirty-frame tracker.
 *
 * The pure classification is covered exhaustively in autosaveDirty.test.ts.
 * Here we prove the WIRING at all three snapshot sites — a normal command's
 * auto-snapshot (execute), a skip-auto-snapshot command's pushUndoSnapshot, and
 * undo/redo's restoreSnapshot — so that every edit, including undo/redo, is
 * caught. Uses real Labels/CommandContext (the propagate-test harness).
 */
import { describe, it, expect, beforeEach } from "../bun-test";
import { CommandContext } from "@/commands/CommandContext";
import { useAppStore } from "@/stores/appStore";
import { PropagateTrackLabels } from "@/commands/trackCommands";
import { dirtyFrameTracker } from "@/lib/autosaveDirty";
import { UpdateTopic } from "@/types";
import type { Command } from "@/commands/types";
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

function makeVideo(name: string): Video {
  return new Video({
    filename: `/v/${name}.mp4`,
    backendMetadata: { shape: [100, 480, 640, 3] },
    openBackend: false,
  });
}

function makeInstance(sk: Skeleton, track: Track): Instance {
  const inst = Instance.fromArray([[10, 10], [11, 11]], sk);
  inst.track = track;
  return inst;
}

/** A two-track fully-tracked video with `frameCount` frames. */
function setup(frameCount: number) {
  const sk = makeSkeleton();
  const video = makeVideo("main");
  const trackA = new Track("A");
  const trackB = new Track("B");
  const frames: LabeledFrame[] = [];
  for (let i = 0; i < frameCount; i++) {
    frames.push(
      new LabeledFrame({
        video,
        frameIdx: i,
        instances: [makeInstance(sk, trackA), makeInstance(sk, trackB)],
      }),
    );
  }
  const labels = new Labels({
    labeledFrames: frames,
    skeletons: [sk],
    videos: [video],
    tracks: [trackA, trackB],
  });
  useAppStore.getState().setLabels(labels, "test.slp");
  useAppStore.getState().setVideo(video);
  useAppStore.getState().setFrameIdx(0);
  return { labels, video, trackA, trackB, frames };
}

describe("CommandContext → dirtyFrameTracker wiring", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    resetStore();
    dirtyFrameTracker.clear();
    ctx = new CommandContext();
  });

  it("marks the edited frame when a normal (auto-snapshot) command executes", async () => {
    const { video } = setup(3);
    useAppStore.getState().setFrameIdx(1);
    const cmd: Command = {
      name: "AddInstance",
      topics: [UpdateTopic.Frame, UpdateTopic.Instance],
      execute: () => {},
    };
    await ctx.execute(cmd);
    expect(dirtyFrameTracker.peekFrames()).toEqual([{ video, frameIdx: 1 }]);
    expect(dirtyFrameTracker.needsFullSnapshot).toBe(false);
  });

  it("marks a to-be-created frame (no LabeledFrame yet) via the active frame", async () => {
    const { video } = setup(3);
    useAppStore.getState().setFrameIdx(42); // unlabeled
    const cmd: Command = {
      name: "AddInstance",
      topics: [UpdateTopic.Frame, UpdateTopic.Instance],
      execute: () => {},
    };
    await ctx.execute(cmd);
    expect(dirtyFrameTracker.peekFrames()).toEqual([{ video, frameIdx: 42 }]);
  });

  it("flags a structural command (track-set change) for a full snapshot", async () => {
    setup(3);
    const cmd: Command = {
      name: "AddTrack",
      topics: [UpdateTopic.Tracks, UpdateTopic.Instance],
      execute: () => {},
    };
    await ctx.execute(cmd);
    expect(dirtyFrameTracker.needsFullSnapshot).toBe(true);
  });

  it("marks the scoped frames of a real skip-auto-snapshot command", async () => {
    const { video, trackA, trackB } = setup(5);
    useAppStore.getState().setFrameIdx(1);
    await ctx.execute(PropagateTrackLabels, { oldTrack: trackA, newTrack: trackB });
    // Propagation's scoped snapshot covers frames strictly after the current (1)
    // → 2,3,4; the command's markChanged also records the active frame (1) as a
    // baseline (harmless — it just re-persists frame 1's unchanged state).
    const frames = dirtyFrameTracker.peekFrames().map((f) => f.frameIdx).sort((a, b) => a - b);
    expect(frames).toEqual([1, 2, 3, 4]);
    expect(dirtyFrameTracker.peekFrames().every((f) => f.video === video)).toBe(true);
    expect(dirtyFrameTracker.needsFullSnapshot).toBe(false);
  });

  it("catches undo and redo (restoreSnapshot) too", async () => {
    const { video, trackA, trackB } = setup(5);
    useAppStore.getState().setFrameIdx(1);
    await ctx.execute(PropagateTrackLabels, { oldTrack: trackA, newTrack: trackB });

    dirtyFrameTracker.clear();
    expect(ctx.undo()).toBe(true);
    // restoreSnapshot marks the scoped frames (2,3,4) + markChanged records the
    // active frame (1) — every restored/affected frame is caught.
    const afterUndo = dirtyFrameTracker.peekFrames().map((f) => f.frameIdx).sort((a, b) => a - b);
    expect(afterUndo).toEqual([1, 2, 3, 4]);
    expect(dirtyFrameTracker.peekFrames().every((f) => f.video === video)).toBe(true);

    dirtyFrameTracker.clear();
    expect(ctx.redo()).toBe(true);
    const afterRedo = dirtyFrameTracker.peekFrames().map((f) => f.frameIdx).sort((a, b) => a - b);
    expect(afterRedo).toEqual([1, 2, 3, 4]);
  });
});

describe("store.markChanged → dirtyFrameTracker (untracked-edit coverage)", () => {
  beforeEach(() => {
    resetStore();
    dirtyFrameTracker.clear();
  });

  it("marks the active frame dirty even for an edit that bypasses the command layer", () => {
    // A direct store.markChanged() (e.g. a point drag commit, a context-menu
    // visibility toggle) must still land the active frame in the dirty set, so
    // the incremental autosave never misses it.
    const { video } = setup(3);
    useAppStore.getState().setFrameIdx(2);
    dirtyFrameTracker.clear();
    useAppStore.getState().markChanged();
    expect(dirtyFrameTracker.peekFrames()).toEqual([{ video, frameIdx: 2 }]);
  });

  it("does not throw / mark when there is no active video", () => {
    dirtyFrameTracker.clear();
    useAppStore.getState().markChanged(); // no labels/video loaded
    expect(dirtyFrameTracker.peekFrames()).toEqual([]);
  });
});
