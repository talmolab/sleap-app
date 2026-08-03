/**
 * Export Labels Package commands (embedded-image `.pkg.slp`).
 *
 * PyQt SLEAP's "Export Labels Package" writes a self-contained `.pkg.slp` that
 * EMBEDS the labeled frame images, so the project is portable without the source
 * videos. Three levels mirror the PyQt dialog (`ExportUserLabelsPackage` /
 * `ExportTrainingPackage` / `ExportFullPackage` in sleap `gui/commands.py`), which
 * differ by two flags — `all_labeled` (include predicted-only frames) and
 * `suggested` (include suggestion frames):
 *   - `user`     (L1, all_labeled=F, suggested=F): user-labeled frames only
 *   - `training` (L2, all_labeled=F, suggested=T): user-labeled + suggested frames
 *   - `full`     (L3, all_labeled=T, suggested=T): all labeled frames (incl. predictions)
 *
 * ── FRAME SELECTION (which LabeledFrames land in the package) ─────────────────
 * `saveSlpToBytes`'s `embed` option controls only which frame IMAGES are embedded;
 * it writes EVERY `labels.labeledFrame` to the package metadata regardless (the io
 * writer mirrors PyQt/sleap-io here — both write `len(labels)` frame rows). So for
 * a project with e.g. 40k predicted frames, a bare `embed:"user"` export still
 * writes all 40k frame rows — only a handful get images. That is not what the PyQt
 * levels mean. We therefore first build a per-level SUBSET of the labels via
 * `Labels.extract(indices, false)` (`copy: false`):
 *   - `user` / `training`: extract only the user-labeled frames (predicted-only
 *     frames are dropped). `extract` also carries along the suggestion frames for
 *     the extracted videos, so `training`'s `embed:"user+suggestions"` can embed
 *     their images.
 *   - `full`: no filtering — the whole project (all labeled frames) is exported.
 * `copy: false` is REQUIRED: it shares the original `Video` objects (and their live
 * backends) so embedding's `getFrame()` can still read pixels — a deep copy would
 * sever the decoder/HDF5 handle. `saveSlpToBytes` does not mutate the videos it is
 * given, so sharing them is safe.
 *
 * ── IO GAP 1 (continuous / mp4 sources do NOT embed) ──────────────────────────
 * io only embeds a frame when the video backend's `getFrame()` yields ENCODED
 * byte blobs (`Uint8Array` / `ArrayBuffer`). The continuous-video backends
 * (MediaBunny / Mp4Box) return an `ImageBitmap`, which io's `frameToBytes()`
 * rejects (→ null → the frame is skipped). Net effect: for a project backed by a
 * continuous video (e.g. `.mp4`), NO frames are embedded — the package instead
 * references the source video, exactly like a plain `.slp`. Already-embedded
 * `pkg.slp` sources copy their stored blobs verbatim and round-trip byte-exact.
 * Verified empirically 2026-08-01 (encode-path round-trip works with encoded
 * bytes; ImageBitmap → `hasEmbeddedImages: false`). The fix belongs in
 * sleap-io.js: rasterize + re-encode `ImageBitmap`/`ImageData` to PNG/JPEG
 * before storing. We surface a toast warning at export time — but ONLY when the
 * WRITTEN package genuinely left frames unembedded (see
 * {@link packageLeavesFramesUnembedded}), so a build of io that CAN embed
 * continuous frames never triggers a false warning.
 *
 * ── SUGGESTION IMAGES on `full` (follow-up, io-gated) ────────────────────────
 * PyQt's Level 3 is `all_labeled=T, suggested=T` → the ideal embed mode is
 * `"all+suggestions"` (all labeled frame images PLUS suggestion frame images).
 * That mode isn't in the published io (0.5.7) yet, so `full` uses `"all"` — every
 * labeled frame's image, but not suggestion-only frame images. Bump to
 * `"all+suggestions"` alongside the io embed-fix dep bump (both land together).
 */

import type { Labels, Video } from "@talmolab/sleap-io.js";
import { saveSlpToBytes, loadSlp } from "@talmolab/sleap-io.js";
import type { Command } from "./types";
import type { CommandContext } from "./CommandContext";
import { saveBytesFile } from "./fileCommands";
import { toast } from "@/lib/notify";

/** The three PyQt package levels. */
export type ExportPackageLevel = "user" | "training" | "full";

/** io `embed` mode used by {@link saveSlpToBytes} for each level. */
export type EmbedMode = "user" | "user+suggestions" | "all";

const LEVEL_TO_EMBED_MODE: Record<ExportPackageLevel, EmbedMode> = {
  user: "user",
  training: "user+suggestions",
  // `full` should be "all+suggestions" (embed suggestion-frame images too), but
  // that mode isn't in the published io (0.5.7) yet — "all" embeds all LABELED
  // frames only. Bump to "all+suggestions" together with the io embed-fix dep
  // bump (see the FRAME SELECTION / suggestion-image follow-up).
  full: "all",
};

/** Map a package level to the io `embed` mode (which frame IMAGES get embedded). */
export function embedModeForLevel(level: ExportPackageLevel): EmbedMode {
  return LEVEL_TO_EMBED_MODE[level];
}

/**
 * Derive the package filename from the current project filename.
 * Strips a trailing `.slp` / `.json` / `.pkg` then appends `.pkg.slp`.
 * e.g. `"session.slp"` → `"session.pkg.slp"`, `"x.pkg.slp"` → `"x.pkg.slp"`.
 */
export function derivePackageFilename(filename: string | null): string {
  const base = (filename ?? "labels")
    .replace(/\.slp$/i, "")
    .replace(/\.json$/i, "")
    .replace(/\.pkg$/i, "");
  return `${base}.pkg.slp`;
}

/** Stable per-frame key (video index + frame index) for de-duplication. */
function frameKey(labels: Labels, video: Video, frameIdx: number): string {
  return `${labels.videos.indexOf(video)}:${frameIdx}`;
}

/** Level 1 count: user-labeled frames only. */
export function countUserFrames(labels: Labels): number {
  return labels.labeledFrames.filter((f) => f.hasUserInstances).length;
}

/** Level 2 count: user-labeled frames + suggestion frames not already labeled. */
export function countTrainingFrames(labels: Labels): number {
  const seen = new Set<string>();
  for (const f of labels.labeledFrames) {
    if (f.hasUserInstances) seen.add(frameKey(labels, f.video, f.frameIdx));
  }
  for (const s of labels.suggestions) {
    seen.add(frameKey(labels, s.video, s.frameIdx));
  }
  return seen.size;
}

/** Level 3 count: all labeled frames ∪ suggestion frames (conceptual PyQt L3). */
export function countFullFrames(labels: Labels): number {
  const seen = new Set<string>();
  for (const f of labels.labeledFrames) {
    seen.add(frameKey(labels, f.video, f.frameIdx));
  }
  for (const s of labels.suggestions) {
    seen.add(frameKey(labels, s.video, s.frameIdx));
  }
  return seen.size;
}

/** Indices into `labels.labeledFrames` of the user-labeled frames. */
function userLabeledFrameIndices(labels: Labels): number[] {
  const inds: number[] = [];
  labels.labeledFrames.forEach((f, i) => {
    if (f.hasUserInstances) inds.push(i);
  });
  return inds;
}

/**
 * Build the subset of `labels` to actually write for a package level.
 *
 * `user`/`training` drop predicted-only frames by extracting just the
 * user-labeled frames (`extract` also carries the suggestion frames for those
 * videos along, which `training`'s embed mode then embeds). `full` exports the
 * whole project unchanged. `copy: false` shares the original `Video` objects so
 * their live backends remain readable for image embedding (see the module doc).
 */
export function labelsForLevel(
  labels: Labels,
  level: ExportPackageLevel
): Labels {
  if (level === "full") return labels;
  return labels.extract(userLabeledFrameIndices(labels), false);
}

/**
 * Whether the just-written package still links to an external video instead of
 * embedding its frames — the accurate, RESULT-based signal for the export-time
 * warning. Reloads `bytes` (metadata only; the embedded image datasets stay
 * lazy) and checks each video's `hasEmbeddedImages`.
 *
 * Short-circuits to `false` when the SOURCE has no continuous video (every video
 * already carries embedded images, e.g. a `.pkg.slp` source): nothing was at
 * risk of failing to embed, so we skip the reload entirely — already-embedded
 * (often large) projects never pay for the verification.
 *
 * Checking the WRITTEN result (not the source project's in-memory videos, which
 * read as "not embedded" for an `.mp4` source even when the export DID embed
 * them) makes the warning correct on any io: a build that can encode continuous
 * frames embeds them → no warning; one that can't leaves an external ref → warn.
 */
export async function packageLeavesFramesUnembedded(
  labels: Labels,
  bytes: Uint8Array
): Promise<boolean> {
  // Only continuous (non-embedded) source videos can fail to embed.
  if (!labels.videos.some((v) => !v.hasEmbeddedImages)) return false;
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  const reloaded = await loadSlp(ab, { openVideos: false });
  return reloaded.videos.some((v) => !v.hasEmbeddedImages);
}

/** Live frame count for a level, for the dialog's per-option preview. */
export function frameCountForLevel(labels: Labels, level: ExportPackageLevel): number {
  switch (level) {
    case "user":
      return countUserFrames(labels);
    case "training":
      return countTrainingFrames(labels);
    case "full":
      return countFullFrames(labels);
  }
}

/**
 * Export a labels package: serialize `labels` to an embedded-image `.pkg.slp`
 * (via `saveSlpToBytes({ embed })`) and write it through the Save-As plumbing
 * (Tauri native dialog / File System Access picker / download fallback).
 */
export async function exportLabelsPackage(
  labels: Labels | null,
  filename: string | null,
  level: ExportPackageLevel
): Promise<void> {
  if (!labels) return;

  const mode = embedModeForLevel(level);
  try {
    // Restrict the package to the frames this level means (predicted-only frames
    // are dropped for user/training) BEFORE serializing — `embed` alone would
    // still write every frame's metadata. See the module doc (FRAME SELECTION).
    const exportLabels = labelsForLevel(labels, level);
    const bytes = await saveSlpToBytes(exportLabels, { embed: mode });
    const suggestedName = derivePackageFilename(filename);
    const saved = await saveBytesFile(bytes, suggestedName, {
      name: "SLEAP Labels Package",
      ext: "slp",
    });
    if (!saved) return; // user cancelled the dialog/picker

    toast.success("Labels package exported", { description: saved });

    // Warn ONLY if the WRITTEN package genuinely left frames unembedded (accurate
    // by construction — see packageLeavesFramesUnembedded). Checking the export
    // result, not the source's in-memory state, means a build of io that CAN
    // embed continuous (.mp4) frames never shows a spurious warning.
    let missingEmbeds = false;
    try {
      missingEmbeds = await packageLeavesFramesUnembedded(labels, bytes);
    } catch (e) {
      // The verification reload failed (unexpected — these are our own bytes).
      // The export itself already succeeded, so stay silent rather than surface a
      // warning we can't stand behind.
      console.warn("[ExportLabelsPackage] embed verification failed:", e);
    }
    if (missingEmbeds) {
      toast.warning("Frames from continuous videos were not embedded", {
        description:
          "This project references a source video (e.g. .mp4) and its frame " +
          "images could not be embedded, so the package links to the source " +
          "video instead. Keep the source video alongside this package.",
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    toast.error("Failed to export labels package", { description: msg });
    console.error("[ExportLabelsPackage] Failed to export:", err);
  }
}

/** Level 1 — user-labeled frames only. */
export const ExportUserLabelsPackageCommand: Command = {
  name: "ExportUserLabelsPackage",
  topics: [],
  async execute(ctx: CommandContext) {
    await exportLabelsPackage(ctx.state.labels, ctx.state.filename, "user");
  },
};

/** Level 2 — user-labeled + suggested frames (recommended for training). */
export const ExportTrainingPackageCommand: Command = {
  name: "ExportTrainingPackage",
  topics: [],
  async execute(ctx: CommandContext) {
    await exportLabelsPackage(ctx.state.labels, ctx.state.filename, "training");
  },
};

/** Level 3 — all labeled frames, including predictions. */
export const ExportFullPackageCommand: Command = {
  name: "ExportFullPackage",
  topics: [],
  async execute(ctx: CommandContext) {
    await exportLabelsPackage(ctx.state.labels, ctx.state.filename, "full");
  },
};
