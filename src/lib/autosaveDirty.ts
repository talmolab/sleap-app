/**
 * Incremental-autosave dirty-frame tracking (Phase 1).
 *
 * The incremental autosave persists only the frames an edit touched since the
 * last tick (a small append to a delta journal) instead of re-serializing the
 * whole project — the fix for the multi-second autosave freeze on large
 * projects. This module is the piece that answers "which frames changed?" and
 * "was the change structural (so the base must be rewritten)?", derived from
 * the undo snapshot a command ALREADY captured — no new project traversal.
 *
 * NOTHING here is wired to the store or React: {@link DirtyFrameTracker} is a
 * plain accumulator the command layer marks on every edit and the autosave tick
 * later drains. Marking is O(1) per single-frame edit / O(scope) for a scoped
 * bulk op, reads only frame IDENTITY (never instance/point data), and triggers
 * no re-render — the efficiency guardrails that keep the "runs on every edit"
 * hook from becoming an O(project) regression (the #366/#334/#318 bug class).
 *
 * Consumption (drain, journal append, replay) lands in a later phase; here the
 * tracker is populated but not yet read, so this phase can prove — in isolation
 * — that every edit (including undo/redo and merges) is classified correctly.
 */
import type { Video } from "@talmolab/sleap-io.js";

/** A single dirtied frame, identified by its video (by reference) + index. */
export interface FrameKey {
  video: Video;
  frameIdx: number;
}

/**
 * The minimal slice of an undo snapshot the classifier reads. Structurally
 * satisfied by {@link import("@/commands/CommandContext").UndoSnapshot} — the
 * classifier depends only on this subset (NOT on `instances`/`isNegative`) so
 * it stays decoupled and provably never touches instance/point data (G2).
 */
export interface DirtySnapshotView {
  /** The command that produced the snapshot — the classifier's primary signal. */
  commandName: string;
  /** Single-frame edits: the affected frame (null if it did not exist yet). */
  frame: { videoRef: Video; frameIdx: number } | null;
  /** Scoped bulk edits (one video, bounded range, no create/delete). */
  scopedFrames: { videoRef: Video; frameIdx: number }[] | null;
  /** Whole-project bulk snapshot — a coarse op we treat as structural. */
  allFrames: unknown[] | null;
  /** The active (video, frameIdx) — used when `frame` is null (frame creation). */
  activeVideo: Video | null;
  activeFrameIdx: number;
}

/** What an edit did, for autosave purposes. */
export type DirtyClassification =
  | { kind: "frames"; frames: FrameKey[] }
  | { kind: "structural" };

/**
 * Command names whose edit is confined to a specific frame (or a bounded scoped
 * set) and does NOT change project-level identity (tracks, skeleton, videos).
 * These get the fast per-frame delta path. EVERYTHING NOT LISTED defaults to
 * structural — the deliberately-safe direction: a new/unclassified command
 * forces a full snapshot (correct, just not yet optimized) rather than risk a
 * journal record referencing something the base lacks (which would corrupt
 * recovery). Add a command here only after confirming it neither changes the
 * track/skeleton/video set nor creates/deletes anything outside its own frame.
 */
const FRAME_LEVEL_COMMANDS: ReadonlySet<string> = new Set([
  "AddInstance",
  "DeleteSelectedInstance",
  "PasteInstance",
  "DuplicateInstance",
  "DeleteFramePredictions",
  "ConvertPredictionToInstance",
  "ToggleNegativeFrame",
  "RotateInstance",
  "BeginEdit",
  "AddInstancesFromAllPredictions",
  // Track REASSIGNMENT (not track-set changes): these only rewrite `.track` on
  // existing instances in one frame / one scoped range — captured in the frame
  // state, referencing tracks that already exist in the base.
  "SetInstanceTrack",
  "TransposeInstances",
  "PropagateTrackLabels",
]);

/**
 * Classify what an edit dirtied, from the snapshot the command already captured.
 * Pure and total (never throws — it runs inside every command's execute):
 * anything ambiguous resolves to `structural`.
 */
export function classifyDirty(snapshot: DirtySnapshotView): DirtyClassification {
  const name = snapshot?.commandName;
  // Unknown / non-frame-level command → full snapshot (safe default).
  if (!name || !FRAME_LEVEL_COMMANDS.has(name)) return { kind: "structural" };
  // A frame-level command that nonetheless captured the whole project is a
  // coarse op; treat it structurally rather than journal every frame.
  if (snapshot.allFrames && snapshot.allFrames.length > 0) {
    return { kind: "structural" };
  }

  // Scoped bulk op (e.g. PropagateTrackLabels): exactly its frames.
  if (snapshot.scopedFrames && snapshot.scopedFrames.length > 0) {
    return {
      kind: "frames",
      frames: snapshot.scopedFrames.map((f) => ({
        video: f.videoRef,
        frameIdx: f.frameIdx,
      })),
    };
  }

  // Single existing frame.
  if (snapshot.frame) {
    return {
      kind: "frames",
      frames: [{ video: snapshot.frame.videoRef, frameIdx: snapshot.frame.frameIdx }],
    };
  }

  // Frame did not exist yet (creating the first instance on a fresh frame):
  // the active (video, frameIdx) identifies the frame being created.
  if (snapshot.activeVideo && Number.isFinite(snapshot.activeFrameIdx) && snapshot.activeFrameIdx >= 0) {
    return {
      kind: "frames",
      frames: [{ video: snapshot.activeVideo, frameIdx: snapshot.activeFrameIdx }],
    };
  }

  // Frame-level command but nothing identifies the frame — fail safe.
  return { kind: "structural" };
}

/**
 * Non-reactive accumulator of the frames dirtied since the last autosave (plus
 * a "the base must be fully rewritten" flag for structural changes). The command
 * layer marks it on every edit; the autosave tick drains it. Deliberately a
 * plain object with no store/React coupling (G1) so marking can never trigger a
 * render, and dirty state uses `Map<Video, Set<number>>` so a repeat edit of the
 * same frame is an O(1) no-op.
 */
export class DirtyFrameTracker {
  private dirty = new Map<Video, Set<number>>();
  private needsFull = false;

  /** Whether the next autosave must rewrite the whole base snapshot. */
  get needsFullSnapshot(): boolean {
    return this.needsFull;
  }

  /** Whether there is anything to persist (dirty frames or a structural change). */
  hasPending(): boolean {
    if (this.needsFull) return true;
    for (const set of this.dirty.values()) if (set.size > 0) return true;
    return false;
  }

  /** Mark one frame dirty. O(1); no instance/point access. */
  markFrame(video: Video, frameIdx: number): void {
    let set = this.dirty.get(video);
    if (!set) {
      set = new Set<number>();
      this.dirty.set(video, set);
    }
    set.add(frameIdx);
  }

  /** Flag the change as structural — the next autosave rewrites the base. */
  markStructural(): void {
    this.needsFull = true;
  }

  /**
   * Mark from a command's undo snapshot. Total: any error (or a structural
   * classification) fails safe to a full snapshot rather than dropping the edit.
   */
  markFromSnapshot(snapshot: DirtySnapshotView): void {
    try {
      const result = classifyDirty(snapshot);
      if (result.kind === "structural") {
        this.needsFull = true;
        return;
      }
      for (const f of result.frames) this.markFrame(f.video, f.frameIdx);
    } catch {
      // A hook that runs inside every command must never throw; on any
      // unexpected shape, fall back to the correct-but-coarse full snapshot.
      this.needsFull = true;
    }
  }

  /** Snapshot the pending frames without clearing (for tests / inspection). */
  peekFrames(): FrameKey[] {
    const out: FrameKey[] = [];
    for (const [video, set] of this.dirty) {
      for (const frameIdx of set) out.push({ video, frameIdx });
    }
    return out;
  }

  /** Return the pending state AND reset — the autosave tick's read. */
  drain(): { needsFullSnapshot: boolean; frames: FrameKey[] } {
    const result = { needsFullSnapshot: this.needsFull, frames: this.peekFrames() };
    this.clear();
    return result;
  }

  /** Reset all pending state (e.g. on project load or a full save). */
  clear(): void {
    this.dirty.clear();
    this.needsFull = false;
  }
}

/** Process-wide tracker the command layer marks and the autosave tick drains. */
export const dirtyFrameTracker = new DirtyFrameTracker();
