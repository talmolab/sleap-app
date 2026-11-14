/**
 * Label QC "Mark as OK" marks, kept on this computer/browser (never in the .slp).
 *
 * A mark says "I checked this instance and its pose is fine": it hides every
 * QC flag on that instance. It is keyed by position AND pose, as
 * `videoIdx:frameIdx:userInstIdx:fingerprint`, so it applies only while the
 * pose is unchanged: editing an approved pose drops its OK and QC flags it
 * again. The fingerprint also makes marks harmless across two projects that
 * share a file name.
 *
 * Storage is one IndexedDB record per mark (compound key [projectKey,
 * markKey], indexed by projectKey), so marking is O(1) however many marks a
 * project has, and a project's marks load in one indexed read. Its own
 * database ("sleap-app-qc"), not a store in draftManifest's "sleap-app", so the
 * two never fight over version upgrades. Without IndexedDB (happy-dom tests,
 * or a browser that blocks it) marks live in memory for the session.
 */
import type { Instance } from "@/types";

/**
 * FNV-1a (32-bit, hex) of an instance's points, rounded to 0.01 px, plus
 * visibility. Same pose → same string; moving a point or toggling its
 * visibility changes it.
 */
export function poseFingerprint(inst: Instance): string {
  let s = "";
  for (const p of inst.points) {
    const [x, y] = p.xy;
    const r = (v: number) => (Number.isFinite(v) ? String(Math.round(v * 100)) : "n");
    s += `${r(x)},${r(y)},${p.visible ? 1 : 0};`;
  }
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** The mark key for one user instance (QC indexes `userInstances`). */
export const qcMarkKey = (videoIdx: number, frameIdx: number, userInstIdx: number, inst: Instance) =>
  `${videoIdx}:${frameIdx}:${userInstIdx}:${poseFingerprint(inst)}`;

/** Where marks are kept. Writes are fire-and-forget: the in-memory set is the truth for the session. */
export interface QcReviewedBackend {
  load(projectKey: string): Promise<string[]>;
  add(projectKey: string, markKeys: string[]): Promise<void>;
  remove(projectKey: string, markKey: string): Promise<void>;
}

/** Marks in memory only (lost on reload). */
export function memoryBackend(): QcReviewedBackend {
  const byProject = new Map<string, Set<string>>();
  const of = (k: string) => {
    let s = byProject.get(k);
    if (!s) byProject.set(k, (s = new Set()));
    return s;
  };
  return {
    load: async (k) => [...of(k)],
    add: async (k, keys) => {
      for (const m of keys) of(k).add(m);
    },
    remove: async (k, m) => {
      of(k).delete(m);
    },
  };
}

const DB_NAME = "sleap-app-qc";
const DB_VERSION = 1;
const STORE = "reviewed";
const BY_PROJECT = "projectKey";

interface MarkRecord {
  projectKey: string;
  markKey: string;
  /** When it was marked (ms epoch); not used yet, but cheap to keep. */
  at: number;
}

/** Marks in IndexedDB, one record per mark. */
export function idbBackend(factory: IDBFactory = indexedDB): QcReviewedBackend {
  let db: Promise<IDBDatabase> | null = null;
  const open = () =>
    (db ??= new Promise((resolve, reject) => {
      const req = factory.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: ["projectKey", "markKey"] });
        store.createIndex(BY_PROJECT, "projectKey");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  const tx = (mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest | void) =>
    open().then(
      (d) =>
        new Promise<IDBRequest | void>((resolve, reject) => {
          const t = d.transaction(STORE, mode);
          const req = run(t.objectStore(STORE));
          t.oncomplete = () => resolve(req);
          t.onerror = () => reject(t.error);
          t.onabort = () => reject(t.error);
        }),
    );
  return {
    load: async (k) => {
      const req = (await tx("readonly", (s) => s.index(BY_PROJECT).getAll(k))) as IDBRequest<
        MarkRecord[]
      >;
      return req.result.map((r) => r.markKey);
    },
    add: async (k, keys) => {
      const at = Date.now();
      await tx("readwrite", (s) => {
        for (const markKey of keys) s.put({ projectKey: k, markKey, at } satisfies MarkRecord);
      });
    },
    remove: async (k, m) => {
      await tx("readwrite", (s) => s.delete([k, m]));
    },
  };
}

let backend: QcReviewedBackend | null = null;

/** IndexedDB when there is one, else memory. */
function getBackend(): QcReviewedBackend {
  return (backend ??= typeof indexedDB === "undefined" ? memoryBackend() : idbBackend());
}

/** Swap the backend (tests). */
export function setQcReviewedBackend(b: QcReviewedBackend | null): void {
  backend = b;
}

/** IndexedDB failed (blocked, private mode…): keep the session's marks in memory instead. */
function fallBack(e: unknown, keep: Iterable<[string, string[]]> = []): void {
  console.warn("Label QC marks: IndexedDB unavailable, keeping them for this session only.", e);
  const mem = memoryBackend();
  for (const [k, keys] of keep) void mem.add(k, keys);
  backend = mem;
}

/** A project's marks. Never rejects (empty on failure). */
export async function loadQcMarks(projectKey: string): Promise<string[]> {
  try {
    return await getBackend().load(projectKey);
  } catch (e) {
    fallBack(e);
    return [];
  }
}

/** Save marks (one or many). Never rejects. */
export async function addQcMarks(projectKey: string, markKeys: string[]): Promise<void> {
  if (markKeys.length === 0) return;
  try {
    await getBackend().add(projectKey, markKeys);
  } catch (e) {
    fallBack(e, [[projectKey, markKeys]]);
  }
}

/** Remove a mark. Never rejects. */
export async function removeQcMark(projectKey: string, markKey: string): Promise<void> {
  try {
    await getBackend().remove(projectKey, markKey);
  } catch (e) {
    fallBack(e);
  }
}
