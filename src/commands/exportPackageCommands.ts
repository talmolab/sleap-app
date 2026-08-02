/**
 * Export Labels Package commands (embedded-image `.pkg.slp`).
 *
 * PyQt SLEAP's "Export Labels Package" writes a self-contained `.pkg.slp` that
 * EMBEDS the labeled frame images, so the project is portable without the source
 * videos. Three levels mirror the PyQt dialog:
 *   - `user`     (Level 1): user-labeled frames only                → embed "user"
 *   - `training` (Level 2): user-labeled + suggested frames         → embed "user+suggestions"
 *   - `full`     (Level 3): all labeled frames (incl. predictions)  → embed "all"
 *
 * The heavy lifting is io's `saveSlpToBytes(labels, { embed })`, which resolves
 * the frames to embed per mode via `collectFramesForEmbedding`.
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
 * before storing. We surface a toast warning at export time (see below).
 *
 * ── IO GAP 2 (Level 3 omits suggestion-only frames) ──────────────────────────
 * embed `"all"` embeds every LABELED frame but EXCLUDES suggestion-only frames —
 * there is no `"all+suggestions"` mode in io yet — so the Level 3 package omits
 * suggested-but-unlabeled frames. This is an approximation of PyQt Level 3; io
 * could add `"all+suggestions"` later. The dialog's Level 3 frame count still
 * shows the conceptual (labeled ∪ suggestions) total.
 */

import type { Labels, Video } from "@talmolab/sleap-io.js";
import { saveSlpToBytes } from "@talmolab/sleap-io.js";
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
  full: "all",
};

/** Map a package level to the io `embed` mode (see IO GAP 2 for `full`/`all`). */
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
    const bytes = await saveSlpToBytes(labels, { embed: mode });
    const suggestedName = derivePackageFilename(filename);
    const saved = await saveBytesFile(bytes, suggestedName, {
      name: "SLEAP Labels Package",
      ext: "slp",
    });
    if (!saved) return; // user cancelled the dialog/picker

    toast.success("Labels package exported", { description: saved });

    // IO GAP 1: continuous (non-embedded) videos don't get their frames embedded
    // yet — warn so the user isn't misled into thinking the package is portable.
    if (labels.videos.some((v) => !v.hasEmbeddedImages)) {
      toast.warning("Frames from continuous videos were not embedded", {
        description:
          "This project references a source video (e.g. .mp4). Embedding its " +
          "frame images isn't supported yet, so the package links to the source " +
          "video instead. Already-embedded (.pkg.slp) projects embed fully.",
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
