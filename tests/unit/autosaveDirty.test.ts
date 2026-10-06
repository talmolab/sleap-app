/**
 * Unit tests for the incremental-autosave dirty-frame tracker (Phase 1).
 *
 * `classifyDirty` derives, from the undo snapshot a command ALREADY captured,
 * which frames an edit dirtied — or that the edit is structural (a base-
 * invalidating change: new/renamed track, skeleton edit, new video, merge,
 * bulk delete) and the next autosave must rewrite the whole base. The
 * classifier is an ALLOW-LIST of frame-level command names; anything else
 * defaults to structural ("when in doubt → full snapshot"), so a future
 * unclassified command can never silently drop an edit from recovery.
 *
 * `DirtyFrameTracker` is the non-reactive accumulator the command layer marks
 * on every edit and the (later) autosave tick drains. It must be O(1) per
 * edit, never touch instance/point data, and never trigger a store update.
 */
import { describe, it, expect, beforeEach } from "../bun-test";
import {
  classifyDirty,
  DirtyFrameTracker,
  dirtyFrameTracker,
  type DirtySnapshotView,
} from "@/lib/autosaveDirty";
import type { Video } from "@talmolab/sleap-io.js";
import { useAppStore } from "@/stores/appStore";

/** A distinct object usable as a Video map key (identity is all that matters). */
function fakeVideo(tag: string): Video {
  return { __tag: tag } as unknown as Video;
}

/** Build a snapshot view with sensible defaults; override per test. */
function view(over: Partial<DirtySnapshotView>): DirtySnapshotView {
  return {
    commandName: "AddInstance",
    frame: null,
    scopedFrames: null,
    allFrames: null,
    activeVideo: null,
    activeFrameIdx: -1,
    ...over,
  };
}

describe("classifyDirty", () => {
  it("maps a single-frame edit to that one frame", () => {
    const v = fakeVideo("a");
    const result = classifyDirty(
      view({ commandName: "AddInstance", frame: { videoRef: v, frameIdx: 7 } }),
    );
    expect(result).toEqual({ kind: "frames", frames: [{ video: v, frameIdx: 7 }] });
  });

  it("falls back to the active frame when the frame did not exist yet (frame creation)", () => {
    const v = fakeVideo("a");
    // AddInstance on an unlabeled frame → snapshot.frame is null, but the active
    // (video, frameIdx) identifies the frame the command is about to create.
    const result = classifyDirty(
      view({ commandName: "AddInstance", frame: null, activeVideo: v, activeFrameIdx: 3 }),
    );
    expect(result).toEqual({ kind: "frames", frames: [{ video: v, frameIdx: 3 }] });
  });

  it("maps a scoped multi-frame edit to exactly its scoped frames", () => {
    const v = fakeVideo("a");
    const result = classifyDirty(
      view({
        commandName: "PropagateTrackLabels",
        scopedFrames: [
          { videoRef: v, frameIdx: 4 },
          { videoRef: v, frameIdx: 5 },
        ],
        activeVideo: v,
        activeFrameIdx: 3,
      }),
    );
    expect(result).toEqual({
      kind: "frames",
      frames: [
        { video: v, frameIdx: 4 },
        { video: v, frameIdx: 5 },
      ],
    });
  });

  it("treats an all-frames (bulk) snapshot as structural", () => {
    const v = fakeVideo("a");
    const result = classifyDirty(
      view({
        commandName: "DeleteAllPredictions",
        allFrames: [{ videoRef: v, frameIdx: 0 }],
      }),
    );
    expect(result).toEqual({ kind: "structural" });
  });

  it("treats a track-set change as structural even with a single-frame snapshot", () => {
    const v = fakeVideo("a");
    for (const commandName of ["AddTrack", "DeleteTrack", "SetTrackName"]) {
      const result = classifyDirty(
        view({ commandName, frame: { videoRef: v, frameIdx: 1 } }),
      );
      expect(result, commandName).toEqual({ kind: "structural" });
    }
  });

  it("treats skeleton and merge commands as structural", () => {
    const v = fakeVideo("a");
    for (const commandName of ["AddNode", "DeleteNode", "MergeIntoProject", "NewProject"]) {
      const result = classifyDirty(
        view({ commandName, frame: { videoRef: v, frameIdx: 1 } }),
      );
      expect(result, commandName).toEqual({ kind: "structural" });
    }
  });

  it("defaults an unknown command to structural (never silently drops an edit)", () => {
    const v = fakeVideo("a");
    const result = classifyDirty(
      view({ commandName: "SomeFutureCommand", frame: { videoRef: v, frameIdx: 1 } }),
    );
    expect(result).toEqual({ kind: "structural" });
  });

  it("is structural when a frame-level edit has no identifiable frame (defensive)", () => {
    const result = classifyDirty(
      view({ commandName: "AddInstance", frame: null, activeVideo: null }),
    );
    expect(result).toEqual({ kind: "structural" });
  });

  it("never reads instance/point data off the snapshot (G2 perf guard)", () => {
    const v = fakeVideo("a");
    const trap = {
      videoRef: v,
      frameIdx: 9,
      get instances(): never {
        throw new Error("classifyDirty must not read .instances");
      },
      get isNegative(): never {
        throw new Error("classifyDirty must not read .isNegative");
      },
    };
    const snap = view({ commandName: "AddInstance", frame: trap as never });
    expect(() => classifyDirty(snap)).not.toThrow();
    expect(classifyDirty(snap)).toEqual({
      kind: "frames",
      frames: [{ video: v, frameIdx: 9 }],
    });
  });
});

describe("DirtyFrameTracker", () => {
  let tracker: DirtyFrameTracker;
  beforeEach(() => {
    tracker = new DirtyFrameTracker();
  });

  it("starts empty", () => {
    expect(tracker.hasPending()).toBe(false);
    expect(tracker.needsFullSnapshot).toBe(false);
    expect(tracker.peekFrames()).toEqual([]);
  });

  it("accumulates dirty frames and dedupes repeats", () => {
    const v = fakeVideo("a");
    tracker.markFrame(v, 1);
    tracker.markFrame(v, 1);
    tracker.markFrame(v, 2);
    expect(tracker.hasPending()).toBe(true);
    expect(tracker.peekFrames()).toEqual([
      { video: v, frameIdx: 1 },
      { video: v, frameIdx: 2 },
    ]);
  });

  it("tracks multiple videos independently", () => {
    const a = fakeVideo("a");
    const b = fakeVideo("b");
    tracker.markFrame(a, 1);
    tracker.markFrame(b, 1);
    const frames = tracker.peekFrames();
    expect(frames).toContainEqual({ video: a, frameIdx: 1 });
    expect(frames).toContainEqual({ video: b, frameIdx: 1 });
    expect(frames.length).toBe(2);
  });

  it("markStructural sets needsFullSnapshot and pending", () => {
    tracker.markStructural();
    expect(tracker.needsFullSnapshot).toBe(true);
    expect(tracker.hasPending()).toBe(true);
  });

  it("routes markFromSnapshot to frames vs structural", () => {
    const v = fakeVideo("a");
    tracker.markFromSnapshot(view({ commandName: "AddInstance", frame: { videoRef: v, frameIdx: 5 } }));
    expect(tracker.peekFrames()).toEqual([{ video: v, frameIdx: 5 }]);
    expect(tracker.needsFullSnapshot).toBe(false);

    tracker.markFromSnapshot(view({ commandName: "AddTrack", frame: { videoRef: v, frameIdx: 5 } }));
    expect(tracker.needsFullSnapshot).toBe(true);
  });

  it("drain returns the current state and resets the tracker", () => {
    const v = fakeVideo("a");
    tracker.markFrame(v, 1);
    tracker.markFrame(v, 2);
    const drained = tracker.drain();
    expect(drained.needsFullSnapshot).toBe(false);
    expect(drained.frames).toEqual([
      { video: v, frameIdx: 1 },
      { video: v, frameIdx: 2 },
    ]);
    // Drained → empty.
    expect(tracker.hasPending()).toBe(false);
    expect(tracker.peekFrames()).toEqual([]);
  });

  it("drain reports needsFullSnapshot and clears it", () => {
    tracker.markStructural();
    const drained = tracker.drain();
    expect(drained.needsFullSnapshot).toBe(true);
    expect(tracker.needsFullSnapshot).toBe(false);
    expect(tracker.hasPending()).toBe(false);
  });

  it("clear resets both frames and the structural flag", () => {
    const v = fakeVideo("a");
    tracker.markFrame(v, 1);
    tracker.markStructural();
    tracker.clear();
    expect(tracker.hasPending()).toBe(false);
    expect(tracker.needsFullSnapshot).toBe(false);
    expect(tracker.peekFrames()).toEqual([]);
  });

  it("never throws on a malformed snapshot; fails safe to structural", () => {
    // A snapshot missing every field must not throw inside a command's execute.
    expect(() => tracker.markFromSnapshot({} as DirtySnapshotView)).not.toThrow();
    expect(tracker.needsFullSnapshot).toBe(true);
  });
});

describe("dirtyFrameTracker singleton (G1 — non-reactive)", () => {
  beforeEach(() => {
    dirtyFrameTracker.clear();
  });

  it("marking a frame dirty does not trigger a store update", () => {
    const v = fakeVideo("a");
    let notified = 0;
    const unsub = useAppStore.subscribe(() => {
      notified += 1;
    });
    try {
      dirtyFrameTracker.markFrame(v, 1);
      dirtyFrameTracker.markStructural();
    } finally {
      unsub();
    }
    expect(notified).toBe(0);
    dirtyFrameTracker.clear();
  });
});
