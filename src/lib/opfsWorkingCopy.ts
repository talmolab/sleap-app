/**
 * OPFS working-copy lifecycle for the browser large-embedded-pkg fast-save.
 *
 * A large embedded `.pkg.slp` (multi-GB of image blobs) cannot be re-saved in
 * the browser by building the whole file in the ~4 GB wasm heap, and streaming
 * the whole thing to the user's disk on every edit is far too slow (it copies
 * every image byte just to move one keypoint). This module gives edits a
 * near-local ⌘S by keeping a durable **working copy** of the project in OPFS and
 * patching only its small label tables in place:
 *
 *   - SEED ({@link seedWorkingCopy}) — write a full, self-contained embedded pkg
 *     into an OPFS file: the small labels/metadata structure
 *     (`saveSlpStructureToBytes`) plus a raw-copy of the already-embedded image
 *     datasets from the opened source (`appendEmbeddedVideos`), all in a Worker
 *     via an OPFS sync-access handle — so NO SharedArrayBuffer / cross-origin
 *     isolation (works on GitHub Pages). Because our own writer creates the
 *     label tables flat + chunked (non-enum), the seeded copy is always
 *     in-place-patchable — unlike a Python-written pkg, whose enum point members
 *     the in-place writer refuses.
 *
 *   - SAVE ({@link saveWorkingCopy}) — on ⌘S, gate the edit with the no-SAB
 *     confinement check ({@link checkInPlaceWritableNoSab}); if it is confined to
 *     the label tables, open the OPFS copy non-truncating (`openWriteOpfs` with
 *     its current size) and patch just those tables (`updateLabelsInPlace`) —
 *     kilobytes written, images untouched. A structural change (video/track/
 *     suggestion add-remove, or a metadata change the update can't carry) is
 *     refused → `needs-reseed`.
 *
 *   - COMMIT ({@link commitToWorkingCopy}) — the patch-or-reseed orchestration:
 *     try to patch; on `needs-reseed`, build a FRESH working copy (from the old
 *     copy's own images) and only THEN remove the old one, so a failed re-seed
 *     leaves the recoverable old copy intact.
 *
 *   - EXPORT ({@link exportWorkingCopy}) — stream the OPFS working copy to the
 *     user's chosen destination on an explicit Export/Save-to-disk action,
 *     KEEPING the working copy (it stays the durable, resumable source of truth).
 *
 * SCOPE: this is the fast path for an already-embedded pkg. Adding a brand-new
 * video whose frames must be encoded is NOT covered — `buildSerializableEmbedPlan`
 * throws for the encode path; that error propagates to `saveProjectAsSlp`'s catch
 * as a "Failed to save project" toast (there is no automatic Save-As fallback — a
 * large pkg needing fresh-frame encoding can't be browser fast-saved yet).
 * Regular/small `.slp` files save to disk directly and never use a working copy.
 * Chromium only (needs OPFS + Worker); the caller gates on `isOpfsSaveSupported()`
 * before routing here.
 */
import {
  StreamingH5Writer,
  saveSlpStructureToBytes,
  buildSerializableEmbedPlan,
  type Labels,
} from "@talmolab/sleap-io.js";
import {
  captureInPlaceBaseline,
  checkInPlaceWritableNoSab,
  advanceBaselineAfterInPlaceSave,
  type InPlaceBaseline,
} from "./opfsInPlaceGate";

// Same derivation as saveEmbeddedPkgOpfs.ts / loadProject.ts: h5wasm served
// same-origin (works with or without cross-origin isolation).
const H5WASM_URL =
  typeof location !== "undefined"
    ? `${location.origin}/h5wasm/h5wasm.js`
    : undefined;

/**
 * A live handle to an OPFS working copy: its OPFS path plus the in-place
 * baseline (the on-disk structure as WE wrote it) the gate diffs each edit
 * against. Advanced on every successful patch and re-captured on every re-seed.
 */
export interface WorkingCopy {
  opfsPath: string;
  baseline: InPlaceBaseline;
}

/** Outcome of one {@link saveWorkingCopy}: either the copy was patched in place
 *  (carrying the advanced handle), or the edit is structural and the caller must
 *  re-seed a fresh copy. */
export type SaveWorkingCopyResult =
  | { kind: "patched"; workingCopy: WorkingCopy }
  | { kind: "needs-reseed"; reason: string };

/** The lifecycle operations {@link commitToWorkingCopy} composes. Real
 *  implementations touch OPFS; tests inject fakes to drive the control flow. */
export interface CommitOps {
  save: (labels: Labels, wc: WorkingCopy) => Promise<SaveWorkingCopyResult>;
  reseedSource: (wc: WorkingCopy) => Promise<File | FileSystemFileHandle>;
  newPath: () => string;
  seed: (
    labels: Labels,
    source: File | FileSystemFileHandle,
    opfsPath: string,
  ) => Promise<WorkingCopy>;
  remove: (opfsPath: string) => Promise<void>;
}

/**
 * Derive a deterministic OPFS filename for a working copy of `projectName`,
 * disambiguated by `uniqueSuffix`. `sleap-wc-` prefix (so all working copies are
 * enumerable/cleanable by prefix), the final `.slp` extension stripped from the
 * name and re-appended once, and path-unsafe characters collapsed to single
 * dashes. Pure — the caller supplies the unique component.
 */
export function workingCopyPathFor(
  projectName: string,
  uniqueSuffix: string,
): string {
  const base =
    (projectName || "")
      .replace(/\.slp$/i, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project";
  return `sleap-wc-${base}-${uniqueSuffix}.slp`;
}

/**
 * A runtime-unique working-copy path for `projectName`. Uniqueness comes from
 * the clock + a random tag (this is not a Workflow script, so those are fine);
 * {@link workingCopyPathFor} owns the deterministic, testable shaping.
 */
export function newWorkingCopyPath(projectName?: string): string {
  const unique = `${Date.now().toString(36)}-${Math.random()
    .toString(16)
    .slice(2, 10)}`;
  return workingCopyPathFor(projectName ?? "project", unique);
}

/** Read an OPFS file's current size (bytes) from the main thread. */
async function opfsFileSize(opfsPath: string): Promise<number> {
  const root = await navigator.storage.getDirectory();
  const fh = await root.getFileHandle(opfsPath, { create: false });
  const file = await fh.getFile();
  return file.size;
}

/**
 * Best-effort request that the browser keep OPFS data persistent (exempt from
 * eviction under storage pressure). Safe to call repeatedly. Returns whether
 * persistence is granted (false if unsupported/denied); the working copy is
 * usable either way, but a grant makes eviction of a multi-GB copy far less
 * likely. Warns when not granted so the "durable" contract isn't silently false.
 */
export async function requestOpfsPersistence(): Promise<boolean> {
  try {
    if (
      typeof navigator !== "undefined" &&
      navigator.storage &&
      typeof navigator.storage.persist === "function"
    ) {
      const granted = await navigator.storage.persist();
      if (!granted) {
        console.warn(
          "[opfsWorkingCopy] storage.persist() not granted — the OPFS working " +
            "copy is best-effort and may be evicted under storage pressure",
        );
      }
      return granted;
    }
  } catch (err) {
    console.warn("[opfsWorkingCopy] storage.persist() failed:", err);
  }
  return false;
}

/** Best-effort removal of an OPFS file (missing file is not an error). */
export async function removeOpfsFile(opfsPath: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(opfsPath);
  } catch {
    // best-effort cleanup
  }
}

/** Remove a working copy's OPFS file (e.g. on discard / after a clean export
 *  the user chose to finalize). */
export async function removeWorkingCopy(wc: WorkingCopy): Promise<void> {
  await removeOpfsFile(wc.opfsPath);
}

/**
 * Seed a fresh, self-contained OPFS working copy of `labels` at `opfsPath`,
 * raw-copying the already-embedded images from `source` (the file the user
 * opened, or a prior working copy). Mirrors the build half of
 * `saveEmbeddedPkgOpfs`, but KEEPS the OPFS file (it becomes the durable working
 * copy) and returns its handle with a fresh in-place baseline.
 *
 * Throws if `source` needs the new-embed encode path (`buildSerializableEmbedPlan`
 * rejects it) — out of scope for the fast path; the throw surfaces to the
 * caller's save error (no automatic fallback).
 */
export async function seedWorkingCopy(
  labels: Labels,
  source: File | FileSystemFileHandle,
  opfsPath: string,
  onProgress?: (done: number, total: number) => void,
): Promise<WorkingCopy> {
  // Ask the browser to keep OPFS persistent before we rely on it as the durable
  // home for edits saved locally but not yet exported (best-effort).
  await requestOpfsPersistence();
  // Re-read a handle FRESH (a File captured earlier may be stale after a dialog
  // stole focus / on a network volume) — see saveEmbeddedPkgOpfs.
  const sourceFile = "getFile" in source ? await source.getFile() : source;
  const structureBytes = await saveSlpStructureToBytes(labels, { embed: false });
  const plan = await buildSerializableEmbedPlan(labels, false, sourceFile.name);

  const writer = new StreamingH5Writer();
  try {
    await writer.openAppendOpfs(
      opfsPath,
      sourceFile,
      structureBytes,
      sourceFile.name,
      H5WASM_URL,
    );
    if (plan.entries.length > 0) {
      const res = await writer.appendEmbeddedVideos(plan.entries, onProgress);
      if (res.success !== true) {
        throw new Error(
          `seedWorkingCopy: appendEmbeddedVideos failed: ${
            res.error ?? JSON.stringify(res)
          }`,
        );
      }
    }
  } finally {
    await writer.close().catch(() => {});
  }
  return { opfsPath, baseline: captureInPlaceBaseline(labels) };
}

/**
 * Save `labels` into the working copy `wc` by patching only its label tables in
 * place. Gates the edit with the no-SAB confinement check; a structural change
 * returns `needs-reseed` (nothing written). On an OK gate, opens the OPFS file
 * non-truncating at its current size and patches the tables + any changed
 * `/metadata`, then returns the advanced handle.
 *
 * The working copy is disposable (the user's real file is untouched until an
 * explicit export), so — unlike the desktop `saveLabelsInPlace`, which writes
 * the real file and must verify loudly — this relies on `res.success` plus io's
 * internal post-resize assertions. A browser-side no-SAB read-back verify is a
 * deferred follow-up (a whole-file MEMFS read would hit the 4 GB wall).
 */
export async function saveWorkingCopy(
  labels: Labels,
  wc: WorkingCopy,
): Promise<SaveWorkingCopyResult> {
  const gate = checkInPlaceWritableNoSab(labels, wc.baseline);
  if (!gate.ok) return { kind: "needs-reseed", reason: gate.reason };

  const size = await opfsFileSize(wc.opfsPath);
  const writer = new StreamingH5Writer();
  try {
    await writer.openWriteOpfs(wc.opfsPath, size, H5WASM_URL);
    const res = await writer.updateLabelsInPlace(gate.update);
    if (res.success !== true) {
      throw new Error(
        `saveWorkingCopy: updateLabelsInPlace failed: ${
          res.error ?? JSON.stringify(res)
        }`,
      );
    }
  } finally {
    await writer.close().catch(() => {});
  }
  return {
    kind: "patched",
    workingCopy: {
      opfsPath: wc.opfsPath,
      baseline: advanceBaselineAfterInPlaceSave(wc.baseline, labels),
    },
  };
}

/** Default (real-OPFS) lifecycle ops for {@link commitToWorkingCopy}. The
 *  re-seed source is the current working copy itself (it already holds every
 *  embedded image), so a re-seed after a non-image-adding structural change
 *  needs no access to the originally-opened file. */
function defaultCommitOps(projectName?: string): CommitOps {
  return {
    save: (labels, wc) => saveWorkingCopy(labels, wc),
    reseedSource: async (wc) => {
      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle(wc.opfsPath, { create: false });
      return fh.getFile();
    },
    newPath: () => newWorkingCopyPath(projectName),
    seed: (labels, source, opfsPath) => seedWorkingCopy(labels, source, opfsPath),
    remove: (opfsPath) => removeOpfsFile(opfsPath),
  };
}

/**
 * Save `labels` to the working copy, patching in place when the edit is confined
 * and re-seeding a fresh copy when it is structural.
 *
 * DATA SAFETY: on a re-seed we build the new copy FIRST and only remove the old
 * one after the new one exists, so a seed failure throws with the recoverable
 * old copy intact. A THROWN patch failure is treated exactly like a structural
 * needs-reseed — an in-place patch is not journaled, so a mid-write throw may
 * leave the working copy's LABEL TABLES half-written; re-seeding rebuilds a
 * fresh, valid copy from the old copy's own (untouched) image datasets rather
 * than leaving a possibly-corrupt file as the authoritative export source.
 * Returns the current {@link WorkingCopy} (same handle when patched; a new path
 * when re-seeded — the caller persists whichever it gets).
 *
 * `opts.ops` overrides any lifecycle op (tests inject fakes); `opts.projectName`
 * names re-seeded working copies.
 */
export async function commitToWorkingCopy(
  labels: Labels,
  wc: WorkingCopy,
  opts: { projectName?: string; ops?: Partial<CommitOps> } = {},
): Promise<WorkingCopy> {
  const ops = { ...defaultCommitOps(opts.projectName), ...opts.ops };

  let res: SaveWorkingCopyResult;
  try {
    res = await ops.save(labels, wc);
  } catch (err) {
    // Patch threw (I/O / quota / worker error) — the label tables may be
    // half-written. Fall through to a re-seed, which overwrites them wholesale
    // from the current labels while raw-copying the intact image datasets.
    res = {
      kind: "needs-reseed",
      reason: `in-place patch failed (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  if (res.kind === "patched") return res.workingCopy;

  // Structural change (or a failed patch) → re-seed. Build the fresh copy from
  // the old copy's own images BEFORE removing the old one (data safety).
  const source = await ops.reseedSource(wc);
  const freshPath = ops.newPath();
  const next = await ops.seed(labels, source, freshPath);
  if (next.opfsPath !== wc.opfsPath) await ops.remove(wc.opfsPath);
  return next;
}

/**
 * Stream the working copy to the user's chosen `destHandle` (explicit Export /
 * Save-to-disk), never buffering the whole file. Unlike `saveEmbeddedPkgOpfs`,
 * the working copy is KEPT afterwards — it remains the durable, resumable source
 * of truth. Returns the destination name.
 */
export async function exportWorkingCopy(
  wc: WorkingCopy,
  destHandle: FileSystemFileHandle,
  onProgress?: (written: number, total: number) => void,
): Promise<string> {
  const root = await navigator.storage.getDirectory();
  const fh = await root.getFileHandle(wc.opfsPath, { create: false });
  const file = await fh.getFile();
  const total = file.size;
  const writable = await destHandle.createWritable();
  let source: ReadableStream<Uint8Array> = file.stream();
  if (onProgress) {
    // Count bytes as they flow through so the caller can show export progress;
    // never buffers (one chunk passes through at a time).
    let written = 0;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        written += chunk.byteLength;
        onProgress(written, total);
        controller.enqueue(chunk);
      },
    });
    source = file.stream().pipeThrough(counter);
  }
  await source.pipeTo(writable as unknown as WritableStream<Uint8Array>);
  return destHandle.name;
}
