/**
 * Frame-delta journal codec for the incremental autosave (Phase 2a).
 *
 * Between full "base" snapshots, each autosave tick appends the frames dirtied
 * since the previous tick to an append-only journal — a tiny write instead of
 * re-serializing the whole project (the fix for the multi-second autosave
 * freeze on large projects). This module encodes/decodes those per-frame
 * records and replays them onto a loaded base at recovery time.
 *
 * Fidelity: a delta captures ONE frame's imageless annotation state at exactly
 * the fidelity the app's own undo system preserves (mirrors CommandContext's
 * `cloneInstances`: skeleton, points {xy, visible, complete, name, score,
 * labeled}, track, predicted + score, isNegative, and the instance, frame and
 * box metadata of SLP format 3.0), plus the frame's bounding boxes. A recovered edited frame therefore
 * matches what an undo would have produced. Instances reference the base's
 * videos/tracks/skeletons BY INDEX — valid because any structural change (new/
 * removed/renamed track, skeleton edit, new video, merge) rewrites the base and
 * truncates the journal, so a live journal never outlives the indices it uses.
 *
 * On-disk framing is WAL-style: each record is `[u32 len][u32 crc32][payload]`
 * (big-endian, JSON payload). A crash mid-append leaves a torn or corrupt final
 * record; {@link decodeJournal} detects it (length overrun or CRC mismatch) and
 * drops the tail rather than corrupting recovery.
 */
import {
  Instance,
  PredictedInstance,
  LabeledFrame,
  UserBoundingBox,
  PredictedBoundingBox,
  UserCentroid,
  PredictedCentroid,
  type BoundingBox,
  type Labels,
  type Video,
  type Track,
  type Skeleton,
} from "@talmolab/sleap-io.js";
import {
  copyPoint,
  copySourceMark,
  isPointLabeled,
  metadataOf,
  setMetadata,
  type RecordMetadata,
} from "@/lib/slpFormat";

/** One keypoint's state (short keys keep the journal compact). */
export interface PointDelta {
  /** Node name (from the skeleton); null if unnamed. */
  n: string | null;
  x: number;
  y: number;
  /** Visible. */
  v: boolean;
  /** Complete. */
  c: boolean;
  /** Point score; null if unscored. */
  s: number | null;
  /**
   * `false` for a node not labelled (SLP format 3.0); absent otherwise, so
   * older journals read as labelled.
   */
  l?: false;
}

/** One instance's state, referencing base track/skeleton by index. */
export interface InstanceDelta {
  /** Index into base.tracks, or -1 if untracked. */
  t: number;
  /** Index into base.skeletons. */
  k: number;
  /** Predicted instance? */
  p: boolean;
  /** Instance-level score (predicted only); null otherwise. */
  s: number | null;
  pts: PointDelta[];
  /** Instance metadata (SLP format 3.0); absent when none. */
  md?: RecordMetadata;
}

/** One bounding box's state. */
export interface BboxDelta {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Rotation (radians); 0 for axis-aligned. */
  a: number;
  /** Predicted box? */
  p: boolean;
  /** Score (predicted only); null otherwise. */
  s: number | null;
  /** Index into base.tracks, or -1 if untracked. */
  t: number;
  /** Tracking score; null if unrecorded. */
  ts: number | null;
  /** Index of the linked instance in this frame's `ins`, or -1. */
  i: number;
  /** Category, name, source. */
  c: string;
  n: string;
  src: string;
  /** Box metadata (SLP format 3.0); absent when none. */
  md?: RecordMetadata;
}

/** One centroid's state (e.g. a Centroid Only run's predictions). */
export interface CentroidDelta {
  x: number;
  y: number;
  /** Predicted centroid? */
  p: boolean;
  /** Score (predicted only); null otherwise. */
  s: number | null;
  /** Index into base.tracks, or -1 if untracked. */
  t: number;
  /** Tracking score; null if unrecorded. */
  ts: number | null;
  /** Index of the linked instance in this frame's `ins`, or -1. */
  i: number;
  /** Category, name, source. */
  c: string;
  n: string;
  src: string;
}

/** One frame's full imageless state. */
export interface FrameDelta {
  /** Index into base.videos. */
  v: number;
  /** Frame index within the video. */
  f: number;
  /** isNegative flag. */
  neg: boolean;
  ins: InstanceDelta[];
  /**
   * Bounding boxes. Absent in journals written before boxes were recorded;
   * replay then leaves the base frame's boxes as they are.
   */
  bb?: BboxDelta[];
  /** Frame metadata (SLP format 3.0); absent when none. */
  md?: RecordMetadata;
  /**
   * Centroids. Absent in journals written before centroids were recorded;
   * replay then leaves the base frame's centroids as they are.
   */
  ce?: CentroidDelta[];
  /**
   * The frame no longer exists (deleted, or its creation undone); replay
   * removes it. Absent in journals written before deletions were recorded.
   */
  del?: true;
}

/** Reverse lookups from base entities to their array indices (built per tick). */
export interface BaseIndex {
  videos: Map<Video, number>;
  tracks: Map<Track, number>;
  skeletons: Map<Skeleton, number>;
}

/** Build the base→index maps once per autosave tick (O(videos+tracks+skeletons)). */
export function buildBaseIndex(labels: Labels): BaseIndex {
  const videos = new Map<Video, number>();
  labels.videos.forEach((v, i) => videos.set(v, i));
  const tracks = new Map<Track, number>();
  labels.tracks.forEach((t, i) => tracks.set(t, i));
  const skeletons = new Map<Skeleton, number>();
  labels.skeletons.forEach((s, i) => skeletons.set(s, i));
  return { videos, tracks, skeletons };
}

/** A delta recording that (video, frameIdx) no longer has a labeled frame. */
export function encodeFrameDeletion(
  video: Video,
  frameIdx: number,
  index: BaseIndex,
): FrameDelta {
  return { v: index.videos.get(video) ?? -1, f: frameIdx, neg: false, ins: [], del: true };
}

/** Encode one labeled frame to a delta, referencing base entities by index. */
export function encodeFrameDelta(frame: LabeledFrame, index: BaseIndex): FrameDelta {
  const delta: FrameDelta = {
    v: index.videos.get(frame.video) ?? -1,
    f: frame.frameIdx,
    neg: frame.isNegative,
    ins: frame.instances.map((inst) => encodeInstance(inst, index)),
    bb: (frame.bboxes ?? []).map((box) => encodeBbox(box, frame, index)),
    ce: (frame.centroids ?? []).map((c) => ({
      x: c.x,
      y: c.y,
      p: c.isPredicted,
      s: c instanceof PredictedCentroid ? c.score ?? null : null,
      t: c.track ? index.tracks.get(c.track) ?? -1 : -1,
      ts: c.trackingScore ?? null,
      i: c.instance ? frame.instances.indexOf(c.instance) : -1,
      c: c.category ?? "",
      n: c.name ?? "",
      src: c.source ?? "",
    })),
  };
  const md = metadataOf(frame);
  if (md) delta.md = { ...md };
  return delta;
}

function encodeBbox(box: BoundingBox, frame: LabeledFrame, index: BaseIndex): BboxDelta {
  const predicted = box instanceof PredictedBoundingBox;
  const md = metadataOf(box);
  return {
    ...(md ? { md: { ...md } } : {}),
    x1: box.x1,
    y1: box.y1,
    x2: box.x2,
    y2: box.y2,
    a: box.angle ?? 0,
    p: predicted,
    s: predicted ? (box as PredictedBoundingBox).score ?? null : null,
    t: box.track ? index.tracks.get(box.track) ?? -1 : -1,
    ts: box.trackingScore ?? null,
    i: box.instance ? frame.instances.indexOf(box.instance) : -1,
    c: box.category ?? "",
    n: box.name ?? "",
    src: box.source ?? "",
  };
}

function encodeInstance(inst: Instance, index: BaseIndex): InstanceDelta {
  const predicted = inst instanceof PredictedInstance;
  const md = metadataOf(inst);
  return {
    t: inst.track ? index.tracks.get(inst.track) ?? -1 : -1,
    k: index.skeletons.get(inst.skeleton) ?? -1,
    p: predicted,
    s: predicted ? (inst as PredictedInstance).score ?? null : null,
    pts: inst.points.map((pt) => ({
      n: pt.name ?? null,
      x: pt.xy[0],
      y: pt.xy[1],
      v: pt.visible,
      c: pt.complete,
      s: pt.score ?? null,
      ...(isPointLabeled(pt) ? {} : { l: false as const }),
    })),
    ...(md ? { md: { ...md } } : {}),
  };
}

// --- On-disk record framing --------------------------------------------------

/** Frame one delta as `[u32 len][u32 crc32][JSON payload]` (big-endian). */
export function frameDeltaToRecord(delta: FrameDelta): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(delta));
  const out = new Uint8Array(8 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.length, false);
  view.setUint32(4, crc32(payload), false);
  out.set(payload, 8);
  return out;
}

/**
 * Decode all intact records from a journal byte buffer. A torn tail (a record
 * whose declared length overruns the buffer) or a corrupt record (CRC mismatch
 * / unparseable payload) stops decoding and sets `truncatedTail` — earlier
 * records are still returned, so a crash mid-append loses only the last write.
 */
export function decodeJournal(bytes: Uint8Array): {
  deltas: FrameDelta[];
  truncatedTail: boolean;
} {
  const deltas: FrameDelta[] = [];
  if (bytes.length === 0) return { deltas, truncatedTail: false };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  while (pos + 8 <= bytes.length) {
    const len = view.getUint32(pos, false);
    const crc = view.getUint32(pos + 4, false);
    const start = pos + 8;
    const end = start + len;
    if (end > bytes.length) return { deltas, truncatedTail: true };
    const payload = bytes.subarray(start, end);
    if (crc32(payload) !== crc) return { deltas, truncatedTail: true };
    try {
      deltas.push(JSON.parse(new TextDecoder().decode(payload)) as FrameDelta);
    } catch {
      return { deltas, truncatedTail: true };
    }
    pos = end;
  }
  // A trailing partial header (fewer than 8 bytes left) is also a torn write.
  return { deltas, truncatedTail: pos !== bytes.length };
}

// --- Replay ------------------------------------------------------------------

/**
 * Apply journal deltas onto a loaded base `Labels`, in order (last write per
 * (video, frameIdx) wins). Existing frames have their instances replaced;
 * frames absent from the base are created; a deletion record removes the
 * frame. Instances are rebuilt against the base's own track/skeleton objects
 * (by index) so identity is preserved.
 * Defensive: a delta referencing an out-of-range video/skeleton is skipped
 * rather than throwing (recovery must never crash on a bad record).
 */
export function applyDeltas(base: Labels, deltas: FrameDelta[]): void {
  if (deltas.length === 0) return;

  // Index existing frames by (video, frameIdx) for O(1) find-or-create — never
  // `base.find({video})` per delta (the sleap-io.js O(project) slow path).
  const byVideo = new Map<Video, Map<number, LabeledFrame>>();
  for (const lf of base.labeledFrames) {
    let m = byVideo.get(lf.video);
    if (!m) {
      m = new Map();
      byVideo.set(lf.video, m);
    }
    m.set(lf.frameIdx, lf);
  }

  const removed = new Set<LabeledFrame>();
  for (const delta of deltas) {
    const video = base.videos[delta.v];
    if (!video) continue; // unknown/out-of-range video — skip defensively
    let m = byVideo.get(video);
    if (!m) {
      m = new Map();
      byVideo.set(video, m);
    }
    if (delta.del) {
      const gone = m.get(delta.f);
      if (gone) removed.add(gone);
      m.delete(delta.f);
      continue;
    }
    let lf = m.get(delta.f);
    if (!lf) {
      lf = new LabeledFrame({ video, frameIdx: delta.f });
      base.labeledFrames.push(lf);
      m.set(delta.f, lf);
    }
    // Keep a slot per delta instance (null when it can't be rebuilt) so box
    // `i` indices still line up.
    const slots = delta.ins.map((ins) => rebuildInstance(ins, base));
    lf.instances = slots.filter((inst): inst is Instance => inst !== null);
    lf.isNegative = delta.neg;
    setMetadata(lf, delta.md);
    if (delta.bb) lf.bboxes = delta.bb.map((b) => rebuildBbox(b, base, slots));
    if (delta.ce) {
      lf.centroids = delta.ce.map((c) => {
        const opts = {
          x: c.x ?? Number.NaN,
          y: c.y ?? Number.NaN,
          track: c.t >= 0 ? base.tracks[c.t] ?? null : null,
          trackingScore: c.ts,
          instance: c.i >= 0 ? slots[c.i] ?? null : null,
          category: c.c,
          name: c.n,
          source: c.src,
        };
        return c.p ? new PredictedCentroid({ ...opts, score: c.s ?? Number.NaN }) : new UserCentroid(opts);
      });
    }
    // Rebuilt records belong to the frame they replay into: they take its
    // open-time format 3.0 choice, if the base was read from such a file.
    for (const inst of lf.instances) copySourceMark(lf, inst);
    for (const box of lf.bboxes) copySourceMark(lf, box);
    for (const centroid of lf.centroids ?? []) copySourceMark(lf, centroid);
  }
  if (removed.size > 0) {
    base.labeledFrames = base.labeledFrames.filter((lf) => !removed.has(lf));
  }

  // We mutated `labeledFrames`/`instances` directly, so io's count-guarded
  // indices are stale — rebuild once (as CommandContext.restoreSnapshot does).
  base.reindex();
}

function rebuildBbox(
  b: BboxDelta,
  base: Labels,
  instances: (Instance | null)[],
): BoundingBox {
  const opts = {
    x1: b.x1 ?? Number.NaN,
    y1: b.y1 ?? Number.NaN,
    x2: b.x2 ?? Number.NaN,
    y2: b.y2 ?? Number.NaN,
    angle: b.a ?? 0,
    track: b.t >= 0 ? base.tracks[b.t] ?? null : null,
    trackingScore: b.ts,
    instance: b.i >= 0 ? instances[b.i] ?? null : null,
    category: b.c,
    name: b.n,
    source: b.src,
  };
  const box = b.p
    ? new PredictedBoundingBox({ ...opts, score: b.s ?? 0 })
    : new UserBoundingBox(opts);
  setMetadata(box, b.md);
  return box;
}

function rebuildInstance(ins: InstanceDelta, base: Labels): Instance | null {
  const skeleton = base.skeletons[ins.k];
  if (!skeleton) return null; // can't rebuild without a skeleton
  const track = ins.t >= 0 ? base.tracks[ins.t] ?? null : null;
  // JSON stores NaN as null: read a missing coordinate back as NaN.
  const point = (p: PointDelta, score: number | undefined) =>
    copyPoint({
      xy: [p.x ?? Number.NaN, p.y ?? Number.NaN],
      visible: p.v,
      complete: p.c,
      name: p.n ?? undefined,
      score,
      ...(p.l === false ? { labeled: false } : {}),
    });
  let inst: Instance;
  if (ins.p) {
    inst = new PredictedInstance({
      skeleton,
      points: ins.pts.map((p) => ({ ...point(p, undefined), score: p.s ?? 0 })),
      track,
      score: ins.s ?? 0,
    });
  } else {
    inst = new Instance({
      skeleton,
      points: ins.pts.map((p) => point(p, p.s ?? undefined)),
      track,
    });
  }
  setMetadata(inst, ins.md);
  return inst;
}

// --- CRC32 (standard IEEE polynomial 0xEDB88320) -----------------------------

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
