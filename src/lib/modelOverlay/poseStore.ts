/**
 * Compare model predictions: one model's poses for a whole video, stored
 * compactly.
 *
 * A long video with several models has millions of poses. Keeping each pose as
 * its own small `Float64Array` (plus an object around it) made the JavaScript
 * heap so large that garbage collection dominated everything else: drawing a
 * frame, ◀ ▶ and the traces all slowed down by hundreds of times between a 10k-
 * and a 100k-frame video (see scripts/bench-compare-models.ts). Here a model's
 * poses live in a handful of flat typed arrays; a frame's {@link OverlayPose}
 * objects are made on demand (views into the flat array, no copy) and the last
 * few frames asked for are kept, so a repaint doesn't make them again.
 *
 * {@link PoseFrames} is the read-only part both this store and a plain
 * `Map<number, OverlayPose[]>` (tests, small mocks) offer.
 */
import type { OverlayPose } from "./core";

/** What Compare Models reads from a model's poses: a `ReadonlyMap`-like view. */
export interface PoseFrames {
  get(frame: number): OverlayPose[] | undefined;
  has(frame: number): boolean;
  /** Frames with at least one pose. */
  keys(): IterableIterator<number>;
  readonly size: number;
}

/** Frames whose poses are kept once made (the frame on screen and its neighbours). */
const CACHE_FRAMES = 8;

export class PoseStore implements PoseFrames {
  /** Nodes per pose. */
  readonly nNodes: number;
  /** Frames with poses, ascending. */
  readonly frameIdx: Int32Array;
  /** Poses of `frameIdx[r]` are `poseStart[r] … poseStart[r+1]-1`. Length frames + 1. */
  readonly poseStart: Int32Array;
  /** `[x0, y0, x1, y1, …]` per pose, poses back to back; NaN where a node is missing. */
  readonly xy: Float64Array;
  /** Instance score per pose; NaN = none. */
  readonly scores: Float64Array;
  /** Index into {@link trackNameList} per pose; -1 = no track. */
  readonly trackIds: Int32Array;
  readonly trackNameList: readonly string[];
  private cache = new Map<number, OverlayPose[]>();

  constructor(init: {
    nNodes: number;
    frameIdx: Int32Array;
    poseStart: Int32Array;
    xy: Float64Array;
    scores: Float64Array;
    trackIds: Int32Array;
    trackNameList: readonly string[];
  }) {
    this.nNodes = init.nNodes;
    this.frameIdx = init.frameIdx;
    this.poseStart = init.poseStart;
    this.xy = init.xy;
    this.scores = init.scores;
    this.trackIds = init.trackIds;
    this.trackNameList = init.trackNameList;
  }

  get size(): number {
    return this.frameIdx.length;
  }

  /** Total poses over all frames. */
  get poseCount(): number {
    return this.poseStart[this.poseStart.length - 1] ?? 0;
  }

  /** Row of `frame` in {@link frameIdx} (binary search), or -1. */
  row(frame: number): number {
    const f = this.frameIdx;
    let lo = 0;
    let hi = f.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = f[mid];
      if (v === frame) return mid;
      if (v < frame) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  has(frame: number): boolean {
    return this.row(frame) >= 0;
  }

  /** Poses on this frame, without making pose objects. */
  posesOnFrame(frame: number): number {
    const r = this.row(frame);
    return r < 0 ? 0 : this.poseStart[r + 1] - this.poseStart[r];
  }

  get(frame: number): OverlayPose[] | undefined {
    const hit = this.cache.get(frame);
    if (hit) return hit;
    const r = this.row(frame);
    if (r < 0) return undefined;
    const out = this.makeRow(r);
    if (this.cache.size >= CACHE_FRAMES) this.cache.delete(this.cache.keys().next().value as number);
    this.cache.set(frame, out);
    return out;
  }

  /** A frame's poses, made fresh and not cached (for passes over every frame). Empty when none. */
  make(frame: number): OverlayPose[] {
    const r = this.row(frame);
    return r < 0 ? [] : this.makeRow(r);
  }

  private makeRow(r: number): OverlayPose[] {
    const stride = this.nNodes * 2;
    const out: OverlayPose[] = [];
    for (let p = this.poseStart[r]; p < this.poseStart[r + 1]; p++) {
      const s = this.scores[p];
      const t = this.trackIds[p];
      out.push({
        xy: this.xy.subarray(p * stride, (p + 1) * stride),
        score: Number.isFinite(s) ? s : null,
        trackName: t >= 0 ? this.trackNameList[t] : null,
      });
    }
    return out;
  }

  keys(): IterableIterator<number> {
    return this.frameIdx.values();
  }

  /** Track names used by any pose. */
  trackNames(): Set<string> {
    const used = new Set<number>();
    for (const t of this.trackIds) if (t >= 0) used.add(t);
    return new Set([...used].map((t) => this.trackNameList[t]));
  }

  /** A store with the same poses as `frames` (a Map, or anything {@link PoseFrames}). */
  static from(frames: PoseFrames, nNodes?: number): PoseStore {
    if (frames instanceof PoseStore) return frames;
    const order = [...frames.keys()].sort((a, b) => a - b);
    const b = new PoseStoreBuilder(nNodes ?? firstPoseNodes(frames, order));
    for (const f of order) for (const p of frames.get(f) ?? []) b.add(f, p.xy, p.score, p.trackName);
    return b.build();
  }
}

function firstPoseNodes(frames: PoseFrames, order: readonly number[]): number {
  for (const f of order) {
    const p = frames.get(f)?.[0];
    if (p) return p.xy.length / 2;
  }
  return 0;
}

/**
 * Builds a {@link PoseStore} pose by pose. Poses may come in any frame order;
 * within a frame they keep the order they were added in.
 */
export class PoseStoreBuilder {
  private xy: Float64Array;
  private scores: Float64Array;
  private trackIds: Int32Array;
  private frames: Int32Array;
  private n = 0;
  private sorted = true;
  private trackIndex = new Map<string, number>();
  private trackNameList: string[] = [];
  readonly nNodes: number;

  constructor(nNodes: number, capacity = 1024) {
    this.nNodes = nNodes;
    const cap = Math.max(1, capacity);
    this.xy = new Float64Array(cap * nNodes * 2);
    this.scores = new Float64Array(cap);
    this.trackIds = new Int32Array(cap);
    this.frames = new Int32Array(cap);
  }

  private grow(): void {
    const cap = this.scores.length * 2;
    const xy = new Float64Array(cap * this.nNodes * 2);
    xy.set(this.xy);
    this.xy = xy;
    const scores = new Float64Array(cap);
    scores.set(this.scores);
    this.scores = scores;
    const t = new Int32Array(cap);
    t.set(this.trackIds);
    this.trackIds = t;
    const f = new Int32Array(cap);
    f.set(this.frames);
    this.frames = f;
  }

  /**
   * Room for one more pose on `frame`. Returns the offset in {@link buffer}
   * where its `nNodes * 2` values go.
   */
  begin(frame: number, score: number | null, trackName: string | null): number {
    if (this.n === this.scores.length) this.grow();
    const i = this.n++;
    if (i > 0 && frame < this.frames[i - 1]) this.sorted = false;
    this.frames[i] = frame;
    this.scores[i] = score ?? NaN;
    let t = -1;
    if (trackName !== null) {
      t = this.trackIndex.get(trackName) ?? -1;
      if (t < 0) {
        t = this.trackNameList.length;
        this.trackNameList.push(trackName);
        this.trackIndex.set(trackName, t);
      }
    }
    this.trackIds[i] = t;
    return i * this.nNodes * 2;
  }

  /** The xy buffer to write into at the offset {@link begin} returned (valid until the next `begin`). */
  get buffer(): Float64Array {
    return this.xy;
  }

  add(frame: number, xy: ArrayLike<number>, score: number | null, trackName: string | null): void {
    const off = this.begin(frame, score, trackName);
    const m = this.nNodes * 2;
    for (let k = 0; k < m; k++) this.xy[off + k] = k < xy.length ? xy[k] : NaN;
  }

  build(): PoseStore {
    const n = this.n;
    const stride = this.nNodes * 2;
    let order: Int32Array | null = null;
    if (!this.sorted) {
      // Stable sort by frame (ties keep insertion order).
      const idx = Array.from({ length: n }, (_, i) => i);
      idx.sort((a, b) => this.frames[a] - this.frames[b] || a - b);
      order = Int32Array.from(idx);
    }
    const xy = order ? new Float64Array(n * stride) : this.xy.slice(0, n * stride);
    const scores = new Float64Array(n);
    const trackIds = new Int32Array(n);
    const frameList: number[] = [];
    const starts: number[] = [];
    for (let i = 0; i < n; i++) {
      const src = order ? order[i] : i;
      if (order) xy.set(this.xy.subarray(src * stride, (src + 1) * stride), i * stride);
      scores[i] = this.scores[src];
      trackIds[i] = this.trackIds[src];
      const f = this.frames[src];
      if (frameList.length === 0 || frameList[frameList.length - 1] !== f) {
        frameList.push(f);
        starts.push(i);
      }
    }
    starts.push(n);
    return new PoseStore({
      nNodes: this.nNodes,
      frameIdx: Int32Array.from(frameList),
      poseStart: Int32Array.from(starts),
      xy,
      scores,
      trackIds,
      trackNameList: [...this.trackNameList],
    });
  }
}

/** Track names in `frames` (fast for a {@link PoseStore}). */
export function trackNamesOf(frames: PoseFrames): Set<string> {
  if (frames instanceof PoseStore) return frames.trackNames();
  const names = new Set<string>();
  for (const f of frames.keys()) for (const p of frames.get(f) ?? []) if (p.trackName !== null) names.add(p.trackName);
  return names;
}

/** Poses on `frame`, without making pose objects when the store can count them. */
export function poseCountOn(frames: PoseFrames, frame: number): number {
  return frames instanceof PoseStore ? frames.posesOnFrame(frame) : (frames.get(frame)?.length ?? 0);
}
