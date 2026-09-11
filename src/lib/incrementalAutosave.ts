/**
 * Incremental-autosave orchestration (Phase 2b core).
 *
 * The runtime-agnostic "brain" the debounced autosave tick calls when the
 * incremental-autosave flag is on. Given the drained dirty-frame set (from the
 * command-layer {@link import("@/lib/autosaveDirty").DirtyFrameTracker}), it
 * decides whether to rewrite the whole base draft, append one delta record per
 * dirty frame to the journal, or do nothing — then drives an injected
 * {@link JournalStore}. The storage leaves (OPFS/Tauri append) and the live
 * wiring live in the runtime modules; keeping the decision + encode/append flow
 * here (with an in-memory store) makes the tricky part CI-testable.
 *
 * A full snapshot is chosen when: there is no base yet (first write), the change
 * was structural (new/removed/renamed track, skeleton edit, new video, merge,
 * bulk delete), a dirty frame carries advanced SLP 2.5+/2.7+ fields the compact
 * delta doesn't round-trip (identity/category — so those are never lost vs
 * today's full-snapshot autosave), or the journal has grown past its size cap
 * (compaction). Otherwise the tick appends — the cheap, freeze-free path.
 */
import type { Labels, LabeledFrame } from "@talmolab/sleap-io.js";
import type { FrameKey } from "@/lib/autosaveDirty";
import {
  buildBaseIndex,
  encodeFrameDelta,
  frameDeltaToRecord,
  decodeJournal,
  applyDeltas,
} from "@/lib/autosaveJournal";

/** Rewrite the base once the journal passes this size (keeps recovery bounded). */
export const DEFAULT_JOURNAL_MAX_BYTES = 2 * 1024 * 1024;

export type FireAction = "full" | "append" | "noop";

export interface FireInput {
  /** Has a base draft been written this session yet? */
  hasBase: boolean;
  /** Did a structural (base-invalidating) change occur since the last write? */
  needsFullSnapshot: boolean;
  /** Number of frames dirtied since the last write. */
  dirtyFrameCount: number;
  /** Current on-disk journal size. */
  journalBytes: number;
  /** Size at/after which we compact by rewriting the base. */
  journalMaxBytes: number;
}

/** Decide the autosave write for this tick. Pure. */
export function decideAutosaveWrite(input: FireInput): FireAction {
  // The first write of a session must lay down a base snapshot before any delta
  // can reference it.
  if (!input.hasBase) {
    return input.needsFullSnapshot || input.dirtyFrameCount > 0 ? "full" : "noop";
  }
  if (input.needsFullSnapshot) return "full";
  if (input.dirtyFrameCount === 0) return "noop";
  // Compaction: a journal larger than the cap would slow recovery — fold it
  // back into a fresh base.
  if (input.journalBytes >= input.journalMaxBytes) return "full";
  return "append";
}

/**
 * Whether any instance on `frame` carries advanced re-ID / classification fields
 * (SLP 2.5+ `identity`, SLP 2.7+ `category`) that the compact frame delta does
 * NOT round-trip. Such a frame is escalated to a full snapshot so those fields
 * are preserved on recovery. Runs only over one frame's instances (tick-time,
 * O(dirty frames) — never the hot per-edit path).
 */
export function frameHasAdvancedInstanceFields(frame: LabeledFrame): boolean {
  for (const inst of frame.instances) {
    const adv = inst as unknown as {
      identity?: unknown;
      category?: unknown;
    };
    if (adv.identity != null || adv.category != null) return true;
  }
  return false;
}

/** Append-only journal storage for one base draft (runtime-specific backends). */
export interface JournalStore {
  /** Append framed records to the end of the journal. */
  appendRecords(records: Uint8Array[]): Promise<void>;
  /** Read the whole journal (for recovery replay). */
  readAll(): Promise<Uint8Array>;
  /** Current journal size in bytes (0 if absent) — for the compaction check. */
  size(): Promise<number>;
  /** Empty the journal (after a base rewrite / compaction / save). */
  truncate(): Promise<void>;
}

/** In-memory {@link JournalStore} — for tests and the orchestration flow. */
export class InMemoryJournalStore implements JournalStore {
  private chunks: Uint8Array[] = [];
  async appendRecords(records: Uint8Array[]): Promise<void> {
    for (const r of records) this.chunks.push(r);
  }
  async readAll(): Promise<Uint8Array> {
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
  async size(): Promise<number> {
    return this.chunks.reduce((n, c) => n + c.length, 0);
  }
  async truncate(): Promise<void> {
    this.chunks = [];
  }
}

export interface RunIncrementalAutosaveDeps {
  labels: Labels;
  drained: { needsFullSnapshot: boolean; frames: FrameKey[] };
  store: JournalStore;
  /** Write the full base draft (the existing recordDraftSave/recordTauriDraftSave). */
  writeBase: () => Promise<void>;
  hasBase: boolean;
  journalBytes: number;
  journalMaxBytes?: number;
}

/**
 * Run one incremental autosave: decide, then either rewrite the base (and
 * truncate the journal) or append a delta record per dirty frame. Returns the
 * action taken. Any dirty frame that no longer exists (e.g. raced with a
 * structural op) is skipped; if that leaves nothing to append, it's a no-op.
 */
export async function runIncrementalAutosave(
  deps: RunIncrementalAutosaveDeps,
): Promise<FireAction> {
  const { labels, drained, store, writeBase, hasBase, journalBytes } = deps;
  const journalMaxBytes = deps.journalMaxBytes ?? DEFAULT_JOURNAL_MAX_BYTES;

  let needsFull = drained.needsFullSnapshot;
  // Escalate to a full snapshot if any dirty frame carries advanced fields the
  // delta can't round-trip (identity/category) — no fidelity loss vs full save.
  if (!needsFull) {
    for (const fk of drained.frames) {
      const lf = labels.find({ video: fk.video, frameIdx: fk.frameIdx })[0];
      if (lf && frameHasAdvancedInstanceFields(lf)) {
        needsFull = true;
        break;
      }
    }
  }

  const action = decideAutosaveWrite({
    hasBase,
    needsFullSnapshot: needsFull,
    dirtyFrameCount: drained.frames.length,
    journalBytes,
    journalMaxBytes,
  });

  if (action === "noop") return "noop";
  if (action === "full") {
    await writeBase();
    await store.truncate();
    return "full";
  }

  // Append: encode each still-present dirty frame against the base's indices.
  const index = buildBaseIndex(labels);
  const records: Uint8Array[] = [];
  for (const fk of drained.frames) {
    const lf = labels.find({ video: fk.video, frameIdx: fk.frameIdx })[0];
    if (!lf) continue; // frame gone (raced a structural op) — skip
    records.push(frameDeltaToRecord(encodeFrameDelta(lf, index)));
  }
  if (records.length === 0) return "noop";
  await store.appendRecords(records);
  return "append";
}

/**
 * Replay a base draft's journal onto the just-loaded base `labels` (recovery).
 * Unconditional and total: an absent/empty journal is a no-op, a torn or corrupt
 * tail is dropped by {@link decodeJournal}, and any failure is swallowed (the
 * base labels are already loaded — recovery must never crash on the journal).
 */
export async function replayJournal(store: JournalStore, labels: Labels): Promise<void> {
  try {
    const bytes = await store.readAll();
    if (bytes.length === 0) return;
    const { deltas } = decodeJournal(bytes);
    if (deltas.length > 0) applyDeltas(labels, deltas);
  } catch (err) {
    console.warn("[autosave] journal replay failed:", err);
  }
}
