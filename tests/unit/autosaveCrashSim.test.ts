/**
 * Automated crash-simulation for the incremental autosave (Phase 3 gate).
 *
 * The unit suites cover each piece (classifier, codec framing, replay,
 * orchestration) in isolation, and a manual desktop E2E covered the real
 * OPFS/Tauri byte I/O. This ties the pieces together into the actual failure
 * mode the feature exists for: a session that wrote a base + appended deltas,
 * then died WITHOUT a clean save/truncate — and asserts recovery (reload the
 * base + replay the surviving journal) reconstructs the exact live state.
 *
 * The base "on disk" is a deep, independent snapshot captured at each full
 * write (what serialization would have persisted); the journal survives the
 * crash as the in-memory store's bytes. Recovery starts from a fresh copy of
 * that base — so an edit that only ever reached the journal MUST come back via
 * replay, or the assertion fails.
 */
import { describe, it, expect } from "../bun-test";
import {
  runIncrementalAutosave,
  replayJournal,
  InMemoryJournalStore,
  type JournalStore,
} from "@/lib/incrementalAutosave";
import { decodeJournal } from "@/lib/autosaveJournal";
import type { FrameKey } from "@/lib/autosaveDirty";
import {
  Labels,
  LabeledFrame,
  Instance,
  PredictedInstance,
  Video,
  Skeleton,
  Track,
} from "@talmolab/sleap-io.js";

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

/** A project with `n` single-instance frames on one video/skeleton/track. */
function makeProject(n = 3) {
  const sk = makeSkeleton();
  const video = makeVideo("main");
  const trackA = new Track("A");
  const frames: LabeledFrame[] = [];
  for (let i = 0; i < n; i++) {
    const inst = Instance.fromArray([[i, i], [i + 10, i + 10]], sk);
    inst.track = trackA;
    frames.push(new LabeledFrame({ video, frameIdx: i, instances: [inst] }));
  }
  const labels = new Labels({
    labeledFrames: frames,
    skeletons: [sk],
    videos: [video],
    tracks: [trackA],
  });
  return { labels, sk, video, trackA, frames };
}

function cloneInst(inst: Instance): Instance {
  const pts = inst.points.map((p) => ({
    xy: [p.xy[0], p.xy[1]] as [number, number],
    visible: p.visible,
    complete: p.complete,
    name: p.name,
    score: p.score,
  }));
  if (inst instanceof PredictedInstance) {
    return new PredictedInstance({
      skeleton: inst.skeleton,
      points: pts.map((p) => ({ ...p, score: p.score ?? 0 })),
      track: inst.track,
      score: inst.score,
    });
  }
  return new Instance({ skeleton: inst.skeleton, points: pts, track: inst.track });
}

/** Deep, independent snapshot of `l` (the "base on disk"), keeping the same
 *  video/track/skeleton objects (index order is what replay relies on). */
function snapshotLabels(l: Labels): Labels {
  return new Labels({
    labeledFrames: l.labeledFrames.map((lf) => {
      const c = new LabeledFrame({ video: lf.video, frameIdx: lf.frameIdx });
      c.instances = lf.instances.map(cloneInst);
      c.isNegative = lf.isNegative;
      return c;
    }),
    skeletons: [...l.skeletons],
    videos: [...l.videos],
    tracks: [...l.tracks],
  });
}

/** Canonical, comparable signature of the whole project's frame content. */
function sig(l: Labels): unknown {
  return l.labeledFrames
    .map((lf) => ({
      v: l.videos.indexOf(lf.video),
      f: lf.frameIdx,
      neg: lf.isNegative,
      ins: lf.instances.map((i) => ({
        p: i instanceof PredictedInstance,
        t: i.track ? l.tracks.indexOf(i.track) : -1,
        k: l.skeletons.indexOf(i.skeleton),
        pts: i.points.map((pt) => [pt.xy[0], pt.xy[1], pt.visible, pt.complete]),
      })),
    }))
    .sort((a, b) => a.v - b.v || a.f - b.f);
}

/** Move the first point of a frame's first instance (a frame-level edit). */
function movePoint(l: Labels, video: Video, frameIdx: number, x: number, y: number) {
  const lf = l.find({ video, frameIdx })[0];
  lf.instances[0].points[0].xy = [x, y];
}

const FK = (video: Video, frameIdx: number): FrameKey => ({ video, frameIdx });

describe("incremental autosave — crash simulation", () => {
  it("recovers base + journal-only appends after a crash", async () => {
    const proj = makeProject(3);
    const { labels, video } = proj;
    const store = new InMemoryJournalStore();
    let base: Labels | null = null;
    const writeBase = async () => {
      base = snapshotLabels(labels);
    };

    // Tick 1 (first write): edit frame 0 → full base (captures f0 edit).
    movePoint(labels, video, 0, 100, 100);
    let action = await runIncrementalAutosave({
      labels, drained: { needsFullSnapshot: false, frames: [FK(video, 0)] },
      store, writeBase, hasBase: false, journalBytes: 0,
    });
    expect(action).toBe("full");

    // Ticks 2 & 3: edit frames 1 and 2 → appends (journal-only; NOT in base).
    movePoint(labels, video, 1, 200, 200);
    action = await runIncrementalAutosave({
      labels, drained: { needsFullSnapshot: false, frames: [FK(video, 1)] },
      store, writeBase, hasBase: true, journalBytes: await store.size(),
    });
    expect(action).toBe("append");

    movePoint(labels, video, 2, 300, 300);
    action = await runIncrementalAutosave({
      labels, drained: { needsFullSnapshot: false, frames: [FK(video, 2)] },
      store, writeBase, hasBase: true, journalBytes: await store.size(),
    });
    expect(action).toBe("append");

    // --- CRASH: keep `base` (on disk) + `store` (journal); discard `labels`. ---
    const recovered = base!;
    // Prove the base ALONE is stale: frames 1 & 2's edits are not in it yet.
    expect(sig(recovered)).not.toEqual(sig(labels));

    await replayJournal(store, recovered);

    // After replay, the recovered project matches the live state exactly —
    // frames 1 & 2 were reconstructed from the journal, not the base.
    expect(sig(recovered)).toEqual(sig(labels));
  });

  it("stays correct when a structural change rewrites the base mid-session", async () => {
    const proj = makeProject(3);
    const { labels, video, sk } = proj;
    const store = new InMemoryJournalStore();
    let base: Labels | null = null;
    const writeBase = async () => {
      base = snapshotLabels(labels);
    };

    // full → append
    movePoint(labels, video, 0, 100, 100);
    await runIncrementalAutosave({
      labels, drained: { needsFullSnapshot: false, frames: [FK(video, 0)] },
      store, writeBase, hasBase: false, journalBytes: 0,
    });
    movePoint(labels, video, 1, 200, 200);
    await runIncrementalAutosave({
      labels, drained: { needsFullSnapshot: false, frames: [FK(video, 1)] },
      store, writeBase, hasBase: true, journalBytes: await store.size(),
    });

    // STRUCTURAL: add a new track + assign it → forces a full base rewrite,
    // truncating the journal (the old appends fold into the new base).
    const trackB = new Track("B");
    labels.tracks.push(trackB);
    labels.find({ video, frameIdx: 2 })[0].instances[0].track = trackB;
    const structuralAction = await runIncrementalAutosave({
      labels, drained: { needsFullSnapshot: true, frames: [] },
      store, writeBase, hasBase: true, journalBytes: await store.size(),
    });
    expect(structuralAction).toBe("full");
    expect((await store.readAll()).length).toBe(0); // journal truncated

    // A frame edit AFTER the rewrite appends against the NEW base (has track B).
    movePoint(labels, video, 0, 111, 111);
    const afterAction = await runIncrementalAutosave({
      labels, drained: { needsFullSnapshot: false, frames: [FK(video, 0)] },
      store, writeBase, hasBase: true, journalBytes: await store.size(),
    });
    expect(afterAction).toBe("append");

    // CRASH → recover from the post-structural base + the surviving journal.
    const recovered = base!;
    await replayJournal(store, recovered);
    expect(sig(recovered)).toEqual(sig(labels));
    // The new track survived (it was in the rewritten base).
    expect(recovered.tracks.length).toBe(2);
    void sk;
  });

  it("drops a torn journal tail on recovery without losing intact appends", async () => {
    const proj = makeProject(3);
    const { labels, video } = proj;
    const store = new InMemoryJournalStore();
    let base: Labels | null = null;
    const writeBase = async () => {
      base = snapshotLabels(labels);
    };

    movePoint(labels, video, 0, 100, 100);
    await runIncrementalAutosave({
      labels, drained: { needsFullSnapshot: false, frames: [FK(video, 0)] },
      store, writeBase, hasBase: false, journalBytes: 0,
    });
    movePoint(labels, video, 1, 200, 200);
    const liveAfterF1 = snapshotLabels(labels); // ground truth incl. f1 edit
    await runIncrementalAutosave({
      labels, drained: { needsFullSnapshot: false, frames: [FK(video, 1)] },
      store, writeBase, hasBase: true, journalBytes: await store.size(),
    });
    // A second append (f2) whose write is torn by the crash.
    movePoint(labels, video, 2, 300, 300);
    await runIncrementalAutosave({
      labels, drained: { needsFullSnapshot: false, frames: [FK(video, 2)] },
      store, writeBase, hasBase: true, journalBytes: await store.size(),
    });

    // Simulate a crash mid-append: the last record's tail is missing on disk.
    const full = await store.readAll();
    const torn = full.slice(0, full.length - 4);
    const { deltas, truncatedTail } = decodeJournal(torn);
    expect(truncatedTail).toBe(true);
    expect(deltas.length).toBe(1); // only the f1 append survived intact

    const tornStore: JournalStore = {
      appendRecords: async () => {},
      size: async () => torn.length,
      truncate: async () => {},
      readAll: async () => torn,
    };

    // Recover from base + the torn journal — must not throw, and the intact
    // f1 append is applied (f2's torn append is dropped, as if never written).
    const recovered = base!;
    await replayJournal(tornStore, recovered);
    expect(sig(recovered)).toEqual(sig(liveAfterF1));
  });
});
