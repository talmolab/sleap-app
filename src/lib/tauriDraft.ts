/**
 * Desktop (Tauri) labels-draft persistence — the disk-backed sibling of the
 * browser OPFS draft ({@link import("@/lib/labelsDraft")}).
 *
 * On desktop, auto-save writes the SAME imageless labels draft the browser does
 * (`serializeLabelsDraft` = structure only, NO pixels), but to an app-local data
 * directory (`<appLocalData>/sleap-drafts/`) rather than OPFS, and it records the
 * draft in an on-disk JSON manifest ({@link import("@/lib/tauriDraftManifest")})
 * rather than IndexedDB. Unlike the browser large-pkg case, the desktop draft is
 * ONLY a crash-recovery net: ⌘S still writes the real disk file, so a draft write
 * never marks the project clean, and a successful ⌘S / discard clears the draft.
 *
 * This module is the Tauri glue: it resolves the drafts directory + manifest path
 * via `@tauri-apps/api/path`, supplies a {@link TauriDraftFs} backed by
 * `@tauri-apps/plugin-fs`, writes the draft `.slp`, and keeps the manifest in
 * sync. The pure manifest logic + the injectable-fs read/write live in
 * {@link import("@/lib/tauriDraftManifest")} and ARE unit-tested; the leaves here
 * touch the real filesystem, so — like the browser OPFS leaves — they're
 * manual/tauri-pilot-verified. The pure path derivation ({@link tauriDraftPathFor}
 * / {@link joinDraftPath}) IS unit-tested.
 */
import type { Labels } from "@talmolab/sleap-io.js";
import {
  draftPathFor,
  newDraftPath,
  serializeLabelsDraft,
} from "@/lib/labelsDraft";
import { videoSignature } from "@/lib/videoGraft";
import {
  type TauriDraftFs,
  type TauriDraftManifestEntry,
  readManifestWithFs,
  writeManifestWithFs,
  upsertManifestEntry,
  removeManifestEntry,
  mergeDraftEntry,
  sortEntriesNewestFirst,
} from "@/lib/tauriDraftManifest";

/** Sub-directory (under the app's local data dir) holding all draft `.slp`s + the
 *  manifest. Enumerable/cleanable, mirrors the browser `sleap-draft-` prefix. */
export const DRAFTS_DIR_NAME = "sleap-drafts";
/** Manifest filename within {@link DRAFTS_DIR_NAME}. */
export const MANIFEST_FILE = "draft-manifest.json";

/**
 * Join a draft filename onto a directory with a forward slash. The filename is a
 * sanitized {@link draftPathFor} slug (no separators), and the Tauri `fs` plugin +
 * the native readers go through Rust `std::fs`, which accepts `/` on every OS
 * (see fsResolver.ts) — so a plain `/` join resolves cross-platform without a Tauri
 * `path.join` round-trip. Pure, so callers/tests need no Tauri runtime. */
export function joinDraftPath(dir: string, name: string): string {
  return `${dir.replace(/[\\/]+$/, "")}/${name}`;
}

/**
 * Full draft path for `projectName` under drafts `dir`, disambiguated by
 * `uniqueSuffix`. Pure (composes {@link joinDraftPath} + {@link draftPathFor}) so
 * the derivation is unit-testable without the async Tauri app-data-dir lookup. */
export function tauriDraftPathFor(
  dir: string,
  projectName: string,
  uniqueSuffix: string,
): string {
  return joinDraftPath(dir, draftPathFor(projectName, uniqueSuffix));
}

/** A {@link TauriDraftFs} backed by `@tauri-apps/plugin-fs` (Tauri runtime only). */
async function tauriDraftFs(): Promise<TauriDraftFs> {
  const { exists, mkdir, readTextFile, writeTextFile, remove } = await import(
    "@tauri-apps/plugin-fs"
  );
  return { exists, mkdir, readTextFile, writeTextFile, remove };
}

/** `<appLocalData>/sleap-drafts` — the on-disk drafts directory (Tauri). */
export async function draftsDir(): Promise<string> {
  const { appLocalDataDir } = await import("@tauri-apps/api/path");
  return joinDraftPath(await appLocalDataDir(), DRAFTS_DIR_NAME);
}

/** Absolute path of the drafts manifest JSON. */
async function manifestPath(): Promise<string> {
  return joinDraftPath(await draftsDir(), MANIFEST_FILE);
}

/** A runtime-unique full draft path for `projectName` in the app's drafts dir. */
export async function newTauriDraftPath(projectName?: string): Promise<string> {
  return joinDraftPath(await draftsDir(), newDraftPath(projectName));
}

/**
 * Persist `labels` as an imageless draft `.slp` AND record it in the manifest.
 * One call for the debounced auto-save so the file + manifest can't drift. The
 * source-identity snapshot (sourceSize/sourceLastModified) is preserved across
 * repeated saves of the SAME draft: an autosave only captures it when minting, so
 * later saves pass `undefined` and we keep the value already recorded.
 */
export async function recordTauriDraftSave(
  labels: Labels,
  opts: {
    draftPath: string;
    projectPath: string | null;
    displayName: string;
    savedAt: number;
    sourceSize?: number;
    sourceLastModified?: number;
  },
): Promise<void> {
  const fs = await tauriDraftFs();
  const { writeFile } = await import("@tauri-apps/plugin-fs");
  const dir = await draftsDir();
  const mpath = await manifestPath();

  // Write the imageless draft (refs only, no pixels → no memory ceiling).
  if (!(await fs.exists(dir))) await fs.mkdir(dir, { recursive: true });
  const bytes = await serializeLabelsDraft(labels);
  await writeFile(opts.draftPath, bytes);

  // Upsert the manifest entry, PRESERVING durable fields (the original pkg's
  // path + the source-identity snapshot) from any prior save of this same draft
  // — see mergeDraftEntry. A resume while the source volume was unmounted nulls
  // store.projectPath, so without this a re-save would erase the path and orphan
  // the embedded draft from its images permanently.
  const entries = await readManifestWithFs(fs, mpath);
  const prior = entries.find((e) => e.draftPath === opts.draftPath);
  const entry: TauriDraftManifestEntry = mergeDraftEntry(prior, {
    draftPath: opts.draftPath,
    projectPath: opts.projectPath,
    displayName: opts.displayName,
    savedAt: opts.savedAt,
    videoCount: labels.videos.length,
    videoSignatures: labels.videos.map((v) =>
      videoSignature({
        filename: v.filename,
        shape: v.shape,
        embeddedFrameIndices: v.embeddedFrameIndices,
        sourceName: v.originalVideo?.filename,
      }),
    ),
    embedded: labels.videos.some((v) => v.hasEmbeddedImages),
    sourceSize: opts.sourceSize,
    sourceLastModified: opts.sourceLastModified,
  });
  await writeManifestWithFs(
    fs,
    dir,
    mpath,
    upsertManifestEntry(entries, entry),
  );
}

/** Best-effort removal of a draft: delete its `.slp` AND drop its manifest entry
 *  (a missing file / entry is not an error, so this is idempotent). Called on a
 *  successful real disk save, project replace/discard, and decline-restore. */
export async function removeTauriDraft(draftPath: string): Promise<void> {
  try {
    const fs = await tauriDraftFs();
    const dir = await draftsDir();
    const mpath = await manifestPath();
    if (await fs.exists(draftPath)) await fs.remove(draftPath);
    const entries = await readManifestWithFs(fs, mpath);
    await writeManifestWithFs(
      fs,
      dir,
      mpath,
      removeManifestEntry(entries, draftPath),
    );
  } catch (err) {
    console.warn("[tauriDraft] failed to remove draft:", err);
  }
}

/** All recoverable desktop drafts, newest-saved first. */
export async function listTauriDraftEntries(): Promise<
  TauriDraftManifestEntry[]
> {
  const fs = await tauriDraftFs();
  return sortEntriesNewestFirst(await readManifestWithFs(fs, await manifestPath()));
}

/** Whether a draft `.slp` still exists on disk (Tauri). */
export async function tauriDraftExists(draftPath: string): Promise<boolean> {
  try {
    const { exists } = await import("@tauri-apps/plugin-fs");
    return await exists(draftPath);
  } catch {
    return false;
  }
}
