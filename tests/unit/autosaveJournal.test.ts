/**
 * Unit tests for the incremental-autosave frame-delta journal codec (Phase 2a).
 *
 * The journal is an append-only log of per-frame deltas written between full
 * base snapshots. Each record captures ONE frame's imageless annotation state
 * at the same fidelity the app's own undo system preserves (`cloneInstances`:
 * skeleton, points {xy, visible, complete, name, score}, track, predicted +
 * score, isNegative) — so a recovered edited frame matches what an undo would
 * have produced. Instances reference the base's videos/tracks/skeletons BY
 * INDEX (stable because any structural change rewrites the base).
 *
 * On-disk framing is WAL-style: each record is length-prefixed + CRC32-checked,
 * so a torn or corrupt tail (a crash mid-append) is detected and dropped on
 * replay rather than corrupting recovery. Replay applies deltas last-per-frame.
 */
import { describe, it, expect } from "../bun-test";
import {
  buildBaseIndex,
  encodeFrameDelta,
  frameDeltaToRecord,
  decodeJournal,
  applyDeltas,
  type FrameDelta,
} from "@/lib/autosaveJournal";
import {
  Labels,
  LabeledFrame,
  Instance,
  PredictedInstance,
  Video,
  Skeleton,
  Track,
} from "@talmolab/sleap-io.js";

function makeSkeleton(name = "s"): Skeleton {
  const s = new Skeleton({ nodes: ["a", "b"], name });
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

/** A base project: 1 video, 1 skeleton, 2 tracks, one labeled frame. */
function makeBase() {
  const sk = makeSkeleton();
  const video = makeVideo("main");
  const trackA = new Track("A");
  const trackB = new Track("B");
  const userInst = Instance.fromArray(
    [
      [10, 20],
      [30, 40],
    ],
    sk,
  );
  userInst.track = trackA;
  const lf = new LabeledFrame({ video, frameIdx: 0, instances: [userInst] });
  const labels = new Labels({
    labeledFrames: [lf],
    skeletons: [sk],
    videos: [video],
    tracks: [trackA, trackB],
  });
  return { labels, sk, video, trackA, trackB, lf };
}

describe("buildBaseIndex", () => {
  it("maps videos/tracks/skeletons to their array indices by reference", () => {
    const { labels, sk, video, trackA, trackB } = makeBase();
    const idx = buildBaseIndex(labels);
    expect(idx.videos.get(video)).toBe(0);
    expect(idx.tracks.get(trackA)).toBe(0);
    expect(idx.tracks.get(trackB)).toBe(1);
    expect(idx.skeletons.get(sk)).toBe(0);
  });
});

describe("encodeFrameDelta", () => {
  it("captures a user instance's frame state by base index", () => {
    const { labels, video, trackA, lf } = makeBase();
    const idx = buildBaseIndex(labels);
    const delta = encodeFrameDelta(lf, idx);
    expect(delta.v).toBe(idx.videos.get(video)!);
    expect(delta.f).toBe(0);
    expect(delta.neg).toBe(false);
    expect(delta.ins.length).toBe(1);
    const ins = delta.ins[0];
    expect(ins.p).toBe(false); // not predicted
    expect(ins.t).toBe(idx.tracks.get(trackA)!);
    expect(ins.k).toBe(0); // skeleton index
    expect(ins.pts.map((p) => [p.x, p.y])).toEqual([
      [10, 20],
      [30, 40],
    ]);
  });

  it("captures a predicted instance's predicted flag and score", () => {
    const { labels, video } = makeBase();
    const sk = labels.skeletons[0];
    const pred = new PredictedInstance({
      skeleton: sk,
      points: [
        { xy: [1, 2], visible: true, complete: false, score: 0.9 },
        { xy: [3, 4], visible: false, complete: false, score: 0.1 },
      ],
      score: 0.75,
    });
    const lf = new LabeledFrame({ video, frameIdx: 5, instances: [pred], isNegative: false });
    const idx = buildBaseIndex(labels);
    const delta = encodeFrameDelta(lf, idx);
    expect(delta.ins[0].p).toBe(true);
    expect(delta.ins[0].s ?? NaN).toBeCloseTo(0.75);
    expect(delta.ins[0].t).toBe(-1); // untracked
  });

  it("captures isNegative frames", () => {
    const { labels, video } = makeBase();
    const lf = new LabeledFrame({ video, frameIdx: 9, instances: [], isNegative: true });
    const delta = encodeFrameDelta(lf, buildBaseIndex(labels));
    expect(delta.neg).toBe(true);
    expect(delta.ins).toEqual([]);
  });
});

describe("record framing + decodeJournal round-trip", () => {
  it("round-trips a single record", () => {
    const { labels, lf } = makeBase();
    const delta = encodeFrameDelta(lf, buildBaseIndex(labels));
    const bytes = frameDeltaToRecord(delta);
    const { deltas, truncatedTail } = decodeJournal(bytes);
    expect(truncatedTail).toBe(false);
    expect(deltas).toEqual([delta]);
  });

  it("decodes multiple concatenated records in order", () => {
    const { labels, video } = makeBase();
    const idx = buildBaseIndex(labels);
    const d1 = encodeFrameDelta(new LabeledFrame({ video, frameIdx: 1, instances: [] }), idx);
    const d2 = encodeFrameDelta(
      new LabeledFrame({ video, frameIdx: 2, instances: [], isNegative: true }),
      idx,
    );
    const buf = concat([frameDeltaToRecord(d1), frameDeltaToRecord(d2)]);
    const { deltas, truncatedTail } = decodeJournal(buf);
    expect(truncatedTail).toBe(false);
    expect(deltas).toEqual([d1, d2]);
  });

  it("empty journal decodes to no deltas", () => {
    const { deltas, truncatedTail } = decodeJournal(new Uint8Array(0));
    expect(deltas).toEqual([]);
    expect(truncatedTail).toBe(false);
  });

  it("drops a torn tail (truncated final record) and keeps earlier records", () => {
    const { labels, video } = makeBase();
    const idx = buildBaseIndex(labels);
    const d1 = encodeFrameDelta(new LabeledFrame({ video, frameIdx: 1, instances: [] }), idx);
    const d2 = encodeFrameDelta(new LabeledFrame({ video, frameIdx: 2, instances: [] }), idx);
    const full = concat([frameDeltaToRecord(d1), frameDeltaToRecord(d2)]);
    // Cut off the last few bytes of the second record — a crash mid-append.
    const torn = full.slice(0, full.length - 3);
    const { deltas, truncatedTail } = decodeJournal(torn);
    expect(deltas).toEqual([d1]);
    expect(truncatedTail).toBe(true);
  });

  it("stops at a corrupt (CRC-mismatch) record", () => {
    const { labels, video } = makeBase();
    const idx = buildBaseIndex(labels);
    const d1 = encodeFrameDelta(new LabeledFrame({ video, frameIdx: 1, instances: [] }), idx);
    const d2 = encodeFrameDelta(new LabeledFrame({ video, frameIdx: 2, instances: [] }), idx);
    const buf = concat([frameDeltaToRecord(d1), frameDeltaToRecord(d2)]);
    // Flip a byte inside the second record's payload (after d1 + 8-byte header).
    const corrupt = new Uint8Array(buf);
    corrupt[frameDeltaToRecord(d1).length + 10] ^= 0xff;
    const { deltas, truncatedTail } = decodeJournal(corrupt);
    expect(deltas).toEqual([d1]);
    expect(truncatedTail).toBe(true);
  });
});

describe("applyDeltas (replay)", () => {
  it("replaces an existing frame's instances, resolving base track/skeleton by index", () => {
    const { labels, video, sk, trackB, lf } = makeBase();
    const idx = buildBaseIndex(labels);
    // A delta that changes frame 0 to a single instance on trackB.
    const replacement = Instance.fromArray(
      [
        [99, 98],
        [97, 96],
      ],
      sk,
    );
    replacement.track = trackB;
    const delta = encodeFrameDelta(
      new LabeledFrame({ video, frameIdx: 0, instances: [replacement] }),
      idx,
    );

    applyDeltas(labels, [delta]);

    expect(lf.instances.length).toBe(1);
    expect(lf.instances[0].track).toBe(trackB); // resolved to the SAME base Track
    expect(lf.instances[0].skeleton).toBe(sk);
    expect(lf.instances[0].points.map((p) => [p.xy[0], p.xy[1]])).toEqual([
      [99, 98],
      [97, 96],
    ]);
  });

  it("creates a frame that does not exist in the base", () => {
    const { labels, video, sk, trackA } = makeBase();
    const idx = buildBaseIndex(labels);
    const inst = Instance.fromArray([[1, 1], [2, 2]], sk);
    inst.track = trackA;
    const delta = encodeFrameDelta(
      new LabeledFrame({ video, frameIdx: 7, instances: [inst] }),
      idx,
    );

    applyDeltas(labels, [delta]);

    const created = labels.find({ video, frameIdx: 7 });
    expect(created.length).toBe(1);
    expect(created[0].instances[0].track).toBe(trackA);
  });

  it("reconstructs a predicted instance as a PredictedInstance with its score", () => {
    const { labels, video } = makeBase();
    const sk = labels.skeletons[0];
    const pred = new PredictedInstance({
      skeleton: sk,
      points: [
        { xy: [1, 2], visible: true, complete: false, score: 0.9 },
        { xy: [3, 4], visible: true, complete: false, score: 0.8 },
      ],
      score: 0.6,
    });
    const idx = buildBaseIndex(labels);
    const delta = encodeFrameDelta(
      new LabeledFrame({ video, frameIdx: 3, instances: [pred] }),
      idx,
    );

    applyDeltas(labels, [delta]);
    const frame = labels.find({ video, frameIdx: 3 })[0];
    expect(frame.instances[0]).toBeInstanceOf(PredictedInstance);
    expect((frame.instances[0] as PredictedInstance).score).toBeCloseTo(0.6);
  });

  it("applies last-write-wins for repeated (video, frameIdx)", () => {
    const { labels, video, sk } = makeBase();
    const idx = buildBaseIndex(labels);
    const first = encodeFrameDelta(
      new LabeledFrame({ video, frameIdx: 0, instances: [Instance.fromArray([[1, 1], [1, 1]], sk)] }),
      idx,
    );
    const second = encodeFrameDelta(
      new LabeledFrame({ video, frameIdx: 0, instances: [] }),
      idx,
    );
    applyDeltas(labels, [first, second]);
    expect(labels.find({ video, frameIdx: 0 })[0].instances.length).toBe(0);
  });

  it("applies an isNegative flag", () => {
    const { labels, video, lf } = makeBase();
    const idx = buildBaseIndex(labels);
    const delta = encodeFrameDelta(
      new LabeledFrame({ video, frameIdx: 0, instances: [], isNegative: true }),
      idx,
    );
    applyDeltas(labels, [delta]);
    expect(lf.isNegative).toBe(true);
  });

  it("skips a delta whose video/skeleton index is out of range (defensive, no throw)", () => {
    const { labels, video } = makeBase();
    const bad: FrameDelta = {
      v: 99,
      f: 0,
      neg: false,
      ins: [{ t: -1, k: 0, p: false, s: null, pts: [] }],
    };
    expect(() => applyDeltas(labels, [bad])).not.toThrow();
    // Original frame untouched.
    expect(labels.find({ video, frameIdx: 0 })[0].instances.length).toBe(1);
  });
});

/** Concatenate byte chunks (test helper mirroring an append log). */
function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
