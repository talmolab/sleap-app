/**
 * Persistent registry of browser labels drafts, for resume-after-close.
 *
 * A labels draft (labelsDraft.ts) lives in OPFS and survives a tab close, but a
 * freshly-opened tab has no idea it exists or which project's images it needs.
 * This manifest — a tiny IndexedDB store — records, per draft: its OPFS path,
 * the ORIGINAL file's `FileSystemFileHandle` (structured-cloneable, so it round-
 * trips through IndexedDB; re-permissioned on restore to re-read the images), a
 * display name, and when it was saved. On launch the Welcome screen lists these
 * so the user can restore or discard each. The manifest is origin-shared, so all
 * tabs see the same drafts.
 *
 * IndexedDB / OPFS are unavailable in happy-dom, so this is manual-E2E-verified
 * (like the other browser-storage helpers), not unit-tested.
 */
import type { Labels } from "@talmolab/sleap-io.js";
import {
  saveLabelsDraft,
  requestOpfsPersistence,
} from "@/lib/labelsDraft";
import { videoSignature } from "@/lib/videoGraft";

const DB_NAME = "sleap-app";
const DB_VERSION = 1;
const STORE = "labels-drafts";

/** One recoverable draft: enough to restore its labels + re-attach its images. */
export interface DraftManifestEntry {
  /** OPFS path of the imageless labels draft (also the primary key). */
  draftPath: string;
  /** The original file's handle, re-permissioned on restore to read images.
   *  Null when the project was opened without a durable handle (drag-drop / bare
   *  File) — restore then asks the user to re-select the original. */
  sourceHandle: FileSystemFileHandle | null;
  /** Human-readable project name for the restore list. */
  displayName: string;
  /** Last-saved wall-clock time (ms) — shown as "saved N ago" + newest-first. */
  savedAt: number;
  /** Video count (kept for display/telemetry). */
  videoCount: number;
  /** Per-video identity signatures ({@link videoSignature}), in draft-video
   *  order. Restore matches these against the re-opened original so it grafts
   *  the RIGHT images (or leaves a video blank) even if the video set diverged
   *  or the wrong file was re-picked. */
  videoSignatures: string[];
  /** Whether the project uses embedded images (a large pkg.slp). Restore uses
   *  it to decide HOW to re-attach images: embedded → re-open the original +
   *  graft its backends; not embedded (external videos / regular .slp) → just
   *  resolve the external videos by path. */
  embedded: boolean;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "draftPath" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      }),
  );
}

/** Insert or update a draft manifest entry (keyed by `draftPath`). */
export async function putDraftEntry(entry: DraftManifestEntry): Promise<void> {
  await tx("readwrite", (s) => s.put(entry));
}

/** All recoverable drafts, newest-saved first. */
export async function listDraftEntries(): Promise<DraftManifestEntry[]> {
  const all = await tx<DraftManifestEntry[]>("readonly", (s) =>
    s.getAll() as IDBRequest<DraftManifestEntry[]>,
  );
  return (all ?? []).sort((a, b) => b.savedAt - a.savedAt);
}

/** Remove a draft's manifest entry (e.g. after export or discard). */
export async function deleteDraftEntry(draftPath: string): Promise<void> {
  await tx("readwrite", (s) => s.delete(draftPath));
}

/**
 * Persist `labels` as a draft AND record it for resume: write the imageless
 * draft to OPFS, upsert its manifest entry, and request durable storage. One
 * call for both the manual ⌘S and the debounced auto-save so they can't drift.
 */
export async function recordDraftSave(
  labels: Labels,
  opts: {
    draftPath: string;
    sourceHandle: FileSystemFileHandle | null;
    displayName: string;
    savedAt: number;
  },
): Promise<void> {
  await saveLabelsDraft(labels, opts.draftPath);
  await putDraftEntry({
    draftPath: opts.draftPath,
    sourceHandle: opts.sourceHandle,
    displayName: opts.displayName,
    savedAt: opts.savedAt,
    videoCount: labels.videos.length,
    videoSignatures: labels.videos.map((v) =>
      videoSignature({ filename: v.filename, shape: v.shape }),
    ),
    embedded: labels.videos.some((v) => v.hasEmbeddedImages),
  });
  void requestOpfsPersistence();
}
