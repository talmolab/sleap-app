/**
 * Labels "draft" persistence for the browser EDL-style fast-save.
 *
 * Treats the LABELS (annotations) as the working project and the embedded images
 * as a referenced, unchanging asset — like a video editor's edit-decision-list
 * vs its footage. A save writes ONLY the labels (a bare-bones `.slp`: skeletons /
 * instances / points / tracks + video refs, NO embedded images) to a small OPFS
 * file: instant, KB–MB, no multi-GB image copy. The full `pkg.slp` is produced
 * only on an explicit Export ("compile"), which merges these labels with the
 * ORIGINAL file's images (see {@link saveEmbeddedPkgOpfs}). This is why saving is
 * instant regardless of project size — the expensive image pass happens once, on
 * export, not on every save.
 *
 * The draft is a genuine (imageless) `.slp`, so it also seeds resume-on-open (a
 * later piece): reload → restore labels from the draft + re-link the original as
 * the image source. Only the pure path derivation is unit-tested; the OPFS
 * read/write leaves are manual-E2E-verified (happy-dom has no OPFS).
 */
import { saveSlpStructureToBytes, type Labels } from "@talmolab/sleap-io.js";

/**
 * Derive a deterministic OPFS filename for a labels draft of `projectName`,
 * disambiguated by `uniqueSuffix`. `sleap-draft-` prefix (enumerable/cleanable),
 * the final `.slp` stripped and re-appended once, path-unsafe characters
 * collapsed to single dashes. Pure — the caller supplies the unique component.
 */
export function draftPathFor(projectName: string, uniqueSuffix: string): string {
  const base =
    (projectName || "")
      .replace(/\.slp$/i, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project";
  return `sleap-draft-${base}-${uniqueSuffix}.slp`;
}

/** A runtime-unique labels-draft path for `projectName`. */
export function newDraftPath(projectName?: string): string {
  const unique = `${Date.now().toString(36)}-${Math.random()
    .toString(16)
    .slice(2, 10)}`;
  return draftPathFor(projectName ?? "project", unique);
}

/** Serialize the current labels as a bare-bones (imageless) `.slp` — the draft. */
export async function serializeLabelsDraft(labels: Labels): Promise<Uint8Array> {
  return saveSlpStructureToBytes(labels, { embed: false });
}

/** Overwrite the OPFS draft file at `opfsPath` with `bytes` (small file, written
 *  from the main thread via `createWritable` — no worker/sync-handle needed). */
export async function writeLabelsDraft(
  opfsPath: string,
  bytes: Uint8Array,
): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const fh = await root.getFileHandle(opfsPath, { create: true });
  const writable = await fh.createWritable();
  await writable.write(bytes);
  await writable.close();
}

/** Serialize + persist the labels draft in one call; returns the byte length. */
export async function saveLabelsDraft(
  labels: Labels,
  opfsPath: string,
): Promise<number> {
  const bytes = await serializeLabelsDraft(labels);
  await writeLabelsDraft(opfsPath, bytes);
  return bytes.byteLength;
}

/** Best-effort removal of a draft OPFS file (missing file is not an error). */
export async function removeLabelsDraft(opfsPath: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(opfsPath);
  } catch {
    // best-effort cleanup
  }
}
