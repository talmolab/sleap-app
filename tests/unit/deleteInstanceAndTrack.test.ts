/**
 * Tracks ▸ Delete Instance and Track (Ctrl/Cmd+Shift+Backspace), audit bug B6.
 *
 * It now follows legacy SLEAP's `DeleteSelectedInstanceTrack`
 * (sleap/gui/commands.py): delete the selected instance, then every instance
 * on its track (user and predicted) in the CURRENT video. The track stays in
 * the project, other videos are untouched, and emptied frames stay.
 *
 * It used to delete only the selected instance, strip the track from every
 * other instance in every video, and remove the track. Its undo covered only
 * the current frame, so undo couldn't bring back other frames' tracks.
 */
import { describe, it, expect, beforeEach } from "../bun-test";
import { CommandContext } from "@/commands/CommandContext";
import { useAppStore } from "@/stores/appStore";
import { useConfirmStore } from "@/stores/confirmStore";
import { DeleteInstanceAndTrack } from "@/commands/trackCommands";
import { confirmDeleteInstanceAndTrack } from "@/lib/trackDeleteConfirms";
import { dirtyFrameTracker } from "@/lib/autosaveDirty";
import {
  Labels,
  LabeledFrame,
  Instance,
  PredictedInstance,
  Video,
  Skeleton,
  Track,
  saveSlpToBytes,
  loadSlp,
} from "@talmolab/sleap-io.js";

function makeVideo(name: string): Video {
  return new Video({
    filename: `/v/${name}.mp4`,
    backendMetadata: { shape: [100, 480, 640, 3] },
    openBackend: false,
  });
}

/**
 * Main video, frames 0-3: track A and track B on each, plus a predicted
 * instance on track A in frame 2 and an untracked user instance in frame 3.
 * Other video, frame 0: an instance on track A (must survive).
 */
function setup() {
  const sk = new Skeleton({ nodes: ["a", "b"], name: "s" });
  const video = makeVideo("main");
  const otherVideo = makeVideo("other");
  const trackA = new Track("A");
  const trackB = new Track("B");
  const user = (track: Track | null) => {
    const inst = Instance.fromArray([[10, 10], [11, 11]], sk);
    if (track) inst.track = track;
    return inst;
  };

  const frames: LabeledFrame[] = [];
  for (let i = 0; i < 4; i++) {
    const instances: Instance[] = [user(trackA), user(trackB)];
    if (i === 2) {
      const pred = PredictedInstance.fromArray([[1, 1], [2, 2]], sk);
      pred.track = trackA;
      instances.push(pred);
    }
    if (i === 3) instances.push(user(null));
    frames.push(new LabeledFrame({ video, frameIdx: i, instances }));
  }
  const otherInst = user(trackA);
  const otherFrame = new LabeledFrame({ video: otherVideo, frameIdx: 0, instances: [otherInst] });

  const labels = new Labels({
    labeledFrames: [...frames, otherFrame],
    skeletons: [sk],
    videos: [video, otherVideo],
    tracks: [trackA, trackB],
  });
  const store = useAppStore.getState();
  store.setLabels(labels, "test.slp");
  store.setVideo(video);
  store.setFrameIdx(1);
  store.setInstance(frames[1].instances[0]); // track A, frame 1

  return { labels, video, otherVideo, sk, trackA, trackB, frames, otherFrame, otherInst };
}

const tracksOf = (lf: LabeledFrame) => lf.instances.map((i) => i.track?.name ?? null);

/** Everything about every instance that a delete or an undo could change. */
function fingerprint(labels: Labels) {
  return labels.labeledFrames.map((lf) => ({
    video: lf.video.filename,
    frameIdx: lf.frameIdx,
    isNegative: lf.isNegative,
    instances: lf.instances.map((i) => ({
      kind: i instanceof PredictedInstance ? "predicted" : "user",
      track: i.track?.name ?? null,
      score: i instanceof PredictedInstance ? i.score : null,
      points: i.points.map((p) => [p.xy[0], p.xy[1], p.visible, p.complete, p.score ?? null]),
    })),
  }));
}

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

describe("DeleteInstanceAndTrack (legacy DeleteSelectedInstanceTrack)", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    ctx = new CommandContext();
  });

  it("deletes every instance on the track in the current video, user and predicted", async () => {
    const { frames } = setup();
    await ctx.execute(DeleteInstanceAndTrack);

    expect(tracksOf(frames[0])).toEqual(["B"]);
    expect(tracksOf(frames[1])).toEqual(["B"]);
    expect(tracksOf(frames[2])).toEqual(["B"]); // the predicted A went too
    expect(tracksOf(frames[3])).toEqual(["B", null]); // untracked instance stays
    expect(useAppStore.getState().instance).toBeNull();
  });

  it("keeps the track in the project and leaves other videos alone", async () => {
    const { labels, trackA, otherFrame, otherInst } = setup();
    await ctx.execute(DeleteInstanceAndTrack);

    expect(labels.tracks).toContain(trackA);
    expect(otherFrame.instances).toEqual([otherInst]);
    expect(otherInst.track).toBe(trackA);
  });

  it("keeps frames it empties, as legacy does", async () => {
    const { labels, video, frames } = setup();
    // Frame 0 holds only track A once track B's instance is removed by hand.
    frames[0].instances = frames[0].instances.filter((i) => i.track?.name === "A");
    await ctx.execute(DeleteInstanceAndTrack);

    expect(frames[0].instances).toHaveLength(0);
    expect(labels.find({ video, frameIdx: 0 })).toHaveLength(1);
  });

  it("deletes just the selected instance when it has no track", async () => {
    const { frames } = setup();
    useAppStore.getState().setFrameIdx(3);
    useAppStore.getState().setInstance(frames[3].instances[2]); // untracked
    await ctx.execute(DeleteInstanceAndTrack);

    expect(tracksOf(frames[3])).toEqual(["A", "B"]);
    expect(tracksOf(frames[0])).toEqual(["A", "B"]);
  });

  it("undo restores every frame it changed, redo deletes them again", async () => {
    const { video, frames, labels } = setup();
    const before = frames.map(tracksOf);
    await ctx.execute(DeleteInstanceAndTrack);

    expect(ctx.undo()).toBe(true);
    const restored = [0, 1, 2, 3].map((i) => tracksOf(labels.find({ video, frameIdx: i })[0]));
    expect(restored).toEqual(before);
    // The selection comes back too.
    expect(useAppStore.getState().instance?.track?.name).toBe("A");

    expect(ctx.redo()).toBe(true);
    const redone = [0, 1, 2, 3].map((i) => tracksOf(labels.find({ video, frameIdx: i })[0]));
    expect(redone).toEqual([["B"], ["B"], ["B"], ["B", null]]);
  });
});

describe("DeleteInstanceAndTrack: regression cases (deletion safety)", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    dirtyFrameTracker.clear();
    ctx = new CommandContext();
  });

  it("only touches the video you're on: deleting from the other video leaves the main one whole", async () => {
    const { labels, video, otherVideo, otherFrame, otherInst, frames } = setup();
    const mainBefore = fingerprint(labels).filter((f) => f.video === video.filename);
    useAppStore.getState().setVideo(otherVideo);
    useAppStore.getState().setFrameIdx(0);
    useAppStore.getState().setInstance(otherInst);

    await ctx.execute(DeleteInstanceAndTrack);

    expect(otherFrame.instances).toHaveLength(0);
    expect(fingerprint(labels).filter((f) => f.video === video.filename)).toEqual(mainBefore);
    expect(frames[0].instances[0].track?.name).toBe("A");
  });

  it("does nothing when no instance is selected", async () => {
    const { labels } = setup();
    useAppStore.getState().setInstance(null);
    const before = fingerprint(labels);

    await ctx.execute(DeleteInstanceAndTrack);

    expect(fingerprint(labels)).toEqual(before);
    expect(ctx.canUndo).toBe(false);
    expect(useAppStore.getState().hasChanges).toBe(false);
  });

  it("does nothing when the selection is stale (not in the current frame)", async () => {
    const { labels, frames } = setup();
    // Selected instance belongs to frame 1, but the user is now on frame 2.
    useAppStore.getState().setInstance(frames[1].instances[0]);
    useAppStore.setState({ frameIdx: 2 });
    const before = fingerprint(labels);

    await ctx.execute(DeleteInstanceAndTrack);

    expect(fingerprint(labels)).toEqual(before);
    expect(ctx.canUndo).toBe(false);
    expect(useAppStore.getState().hasChanges).toBe(false);
  });

  it("works from a selected prediction too: its track's user instances go with it", async () => {
    const { frames } = setup();
    useAppStore.getState().setFrameIdx(2);
    useAppStore.getState().setInstance(frames[2].instances[2]); // predicted, track A

    await ctx.execute(DeleteInstanceAndTrack);

    for (const lf of frames) expect(tracksOf(lf)).not.toContain("A");
  });

  it("leaves untouched instances and frames as the same objects (nothing cloned)", async () => {
    const { frames, labels, otherFrame, otherInst } = setup();
    const bInstances = frames.map((lf) => lf.instances.find((i) => i.track?.name === "B")!);
    const frameObjects = [...labels.labeledFrames];

    await ctx.execute(DeleteInstanceAndTrack);

    expect(labels.labeledFrames).toEqual(frameObjects);
    labels.labeledFrames.forEach((lf, i) => expect(lf).toBe(frameObjects[i]));
    frames.forEach((lf, i) => expect(lf.instances[0]).toBe(bInstances[i]));
    expect(otherFrame.instances[0]).toBe(otherInst);
  });

  it("keeps a negative frame in the video negative", async () => {
    const { labels, video } = setup();
    const neg = new LabeledFrame({ video, frameIdx: 50, instances: [] });
    neg.isNegative = true;
    labels.labeledFrames.push(neg);

    await ctx.execute(DeleteInstanceAndTrack);

    const found = labels.find({ video, frameIdx: 50 });
    expect(found).toHaveLength(1);
    expect(found[0].isNegative).toBe(true);
  });

  it("is one undo step, and undo restores every point, score and track exactly", async () => {
    const { labels } = setup();
    const before = fingerprint(labels);

    await ctx.execute(DeleteInstanceAndTrack);
    expect(fingerprint(labels)).not.toEqual(before);

    expect(ctx.undo()).toBe(true);
    expect(fingerprint(labels)).toEqual(before);
    expect(ctx.canUndo).toBe(false); // a single entry covered all of it
  });

  it("undo still restores everything after you navigate to another frame and video", async () => {
    const { labels, otherVideo } = setup();
    const before = fingerprint(labels);

    await ctx.execute(DeleteInstanceAndTrack);
    useAppStore.getState().setVideo(otherVideo);
    useAppStore.getState().setFrameIdx(0);

    expect(ctx.undo()).toBe(true);
    expect(fingerprint(labels)).toEqual(before);
  });

  it("survives repeated undo/redo cycles without drift", async () => {
    const { labels } = setup();
    const before = fingerprint(labels);
    await ctx.execute(DeleteInstanceAndTrack);
    const after = fingerprint(labels);

    for (let i = 0; i < 3; i++) {
      expect(ctx.undo()).toBe(true);
      expect(fingerprint(labels)).toEqual(before);
      expect(ctx.redo()).toBe(true);
      expect(fingerprint(labels)).toEqual(after);
    }
  });

  it("marks the project changed and has autosave rewrite the whole draft", async () => {
    setup();
    useAppStore.getState().clearChanges();
    dirtyFrameTracker.clear();

    await ctx.execute(DeleteInstanceAndTrack);

    expect(useAppStore.getState().hasChanges).toBe(true);
    // Not a frame-level command, so the incremental autosave falls back to a
    // full snapshot: every frame it changed is guaranteed to be persisted.
    expect(dirtyFrameTracker.needsFullSnapshot).toBe(true);
  });

  it("the deletion survives a save and reload, with the track still in the file", async () => {
    const { labels } = setup();
    await ctx.execute(DeleteInstanceAndTrack);

    const reloaded = await loadSlp(toArrayBuffer(await saveSlpToBytes(labels)), { openVideos: false });

    expect(reloaded.tracks.map((t) => t.name).sort()).toEqual(["A", "B"]);
    const byVideo = (name: string) =>
      reloaded.labeledFrames
        .filter((lf) => String(lf.video.filename).endsWith(name))
        .sort((a, b) => a.frameIdx - b.frameIdx);
    expect(byVideo("main.mp4").map(tracksOf)).toEqual([["B"], ["B"], ["B"], ["B", null]]);
    expect(byVideo("other.mp4").map(tracksOf)).toEqual([["A"]]);
  });
});

describe("confirmDeleteInstanceAndTrack", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    useConfirmStore.setState({ request: null });
  });

  it("says how many instances on the track will go, in this video only", async () => {
    const { labels, video, frames } = setup();
    // Track A in the main video: frames 0-3 plus frame 2's prediction = 5.
    const pending = confirmDeleteInstanceAndTrack({ labels, video, instance: frames[1].instances[0] });
    expect(useConfirmStore.getState().request?.message).toBe(
      'Delete all 5 instances on track "A" in this video, including this one? The track itself is kept.'
    );
    useConfirmStore.getState().respond(false);
    expect(await pending).toBe(false);
  });

  it("says nothing else goes when the instance has no track", async () => {
    const { labels, video, frames } = setup();
    const pending = confirmDeleteInstanceAndTrack({ labels, video, instance: frames[3].instances[2] });
    expect(useConfirmStore.getState().request?.message).toBe(
      "Delete this instance? It isn't on a track, so nothing else is deleted."
    );
    useConfirmStore.getState().respond(true);
    expect(await pending).toBe(true);
  });
});
