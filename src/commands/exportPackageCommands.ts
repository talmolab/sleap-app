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
 * ── WRITE PATHS ────────────────────────────────────────────────────────────────
 * Desktop exports of continuous (e.g. `.mp4`) videos follow PyQt: the Save
 * dialog comes first, then the package is written straight to that file by
 * {@link saveEmbeddedPkgStreaming}. Frames are read here (an mp4 decodes in its
 * own worker) and encoded (PNG or JPEG) + appended by the h5 writer's worker,
 * so the window stays responsive and only a few frames are in memory at a time.
 * The browser does the same where it can (Chromium): the Save picker first,
 * then the package is built in an OPFS file by the writer's worker and streamed
 * into the picked file ({@link exportNewPkgOpfs}, the path Save As of a large
 * package already uses). Already-embedded (`.pkg.slp`) projects, and other
 * browsers, build the package in memory with `saveSlpToBytes` and save it
 * afterwards; the toast warning there
 * fires ONLY when the WRITTEN package genuinely left frames unembedded (see
 * {@link packageLeavesFramesUnembedded}). Both paths show progress with Cancel
 * (io's `onProgress` returning `false` → `ExportCancelled`; nothing is written).
 *
 * ── FRAME FORMAT ──────────────────────────────────────────────────────────────
 * Frames are embedded as PNG unless the export dialog chose JPEG (`image`,
 * see `packageImageFormat.ts`), which every write path passes to io as
 * `imageFormat: "jpg"` / `imageQuality` (`withImageFormat`). PNG passes no
 * option at all, so a PNG export writes exactly what it always did. On
 * desktop, ffmpeg extracts PNG frames for either format; for JPEG, io's
 * worker decodes them and encodes the JPEG (`extractFrames.ts`).
 *
 * ── SUGGESTION IMAGES on `full` (follow-up, io-gated) ────────────────────────
 * PyQt's Level 3 is `all_labeled=T, suggested=T` → the ideal embed mode is
 * `"all+suggestions"` (all labeled frame images PLUS suggestion frame images).
 * That mode isn't in the published io (0.5.7) yet, so `full` uses `"all"` — every
 * labeled frame's image, but not suggestion-only frame images. Bump to
 * `"all+suggestions"` alongside the io embed-fix dep bump (both land together).
 */

import type { Labels, Video } from "@talmolab/sleap-io.js";
import { ExportCancelled, saveSlpToBytes } from "@talmolab/sleap-io.js";
import { loadSlp } from "@/lib/slpRead";
import type { Command } from "./types";
import type { CommandContext } from "./CommandContext";
import { saveBytesFile } from "./fileCommands";
import { toast } from "@/lib/notify";
import { prepareVideosForFrameReads } from "@/lib/resolveVideos";
import { saveEmbeddedPkgStreaming } from "@/lib/saveEmbeddedPkgStreaming";
import {
  exportNewPkgOpfs,
  isOpfsSaveSupported,
  pickSlpSaveDestination,
} from "@/lib/saveEmbeddedPkgOpfs";
import {
  createFfmpegFrameReader,
  createTauriExtractFramesDeps,
} from "@/lib/transcode/extractFrames";
import { toastExported } from "@/lib/exportToast";
import { getPlatform } from "../platform/index";
import { useAppStore } from "@/stores/appStore";
import { withImageFormat, withLegacyLayout } from "@/lib/slpFormatCompat";
import { projectFileReplaced, refuseStaleVideoNames } from "@/lib/inPlaceBinding";
import { refuseWhileSaving } from "@/lib/saveInProgress";
import { hasDiskBackedVideos } from "@/lib/diskBackedVideos";
import { normalizePackageImage, type PackageImageOptions } from "@/lib/packageImageFormat";
import { ensureWritable } from "@/lib/slpAccess";

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

/**
 * Level 1 count: user-labeled frames only — any user labeling, negative
 * (background) frames included, as sleap-io's `user_labeled_frames`.
 */
export function countUserFrames(labels: Labels): number {
  return labels.labeledFrames.filter((f) => f.isUserLabeled).length;
}

/** Level 2 count: user-labeled frames + suggestion frames not already labeled. */
export function countTrainingFrames(labels: Labels): number {
  const seen = new Set<string>();
  for (const f of labels.labeledFrames) {
    if (f.isUserLabeled) seen.add(frameKey(labels, f.video, f.frameIdx));
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

/**
 * Indices into `labels.labeledFrames` of the user-labeled frames (negative
 * frames included, so `embed: "user"` can embed their images like sleap-io).
 */
function userLabeledFrameIndices(labels: Labels): number[] {
  const inds: number[] = [];
  labels.labeledFrames.forEach((f, i) => {
    if (f.isUserLabeled) inds.push(i);
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
 * The videos a package level reads frame images from: those of its labeled
 * frames, plus its suggestion frames' for the levels that embed suggestions.
 */
export function videosToEmbed(
  labels: Labels,
  level: ExportPackageLevel
): Video[] {
  const videos = new Set<Video>(labels.labeledFrames.map((f) => f.video));
  if (level !== "user") {
    for (const s of labels.suggestions) videos.add(s.video);
  }
  return labels.videos.filter((v) => videos.has(v));
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
  // The app's own bytes, just written in the 2.x layout and only inspected:
  // no format 3.0 question applies, and failures stay with the caller.
  const reloaded = await loadSlp(ab, { openVideos: false, format3: "view", refusal: "throw" });
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
 * The desktop frame reader for a package: ffmpeg extracts each local video's
 * frames as PNGs, whatever format the package stores (io encodes a JPEG
 * package's frames from them).
 */
function ffmpegFrameReader() {
  const extractDeps = createTauriExtractFramesDeps();
  return (video: Video, frames: readonly number[]) =>
    createFfmpegFrameReader(video, frames, extractDeps);
}

/**
 * The `image` param of the package commands (set by the export dialogs),
 * cleaned: a missing or junk quality becomes the default, an out-of-range
 * one is clamped. Undefined (PNG, as before) without a known format.
 */
export function packageImageParam(
  params: Record<string, unknown> | undefined
): PackageImageOptions | undefined {
  const image = params?.image as Partial<PackageImageOptions> | undefined;
  if (!image || typeof image !== "object") return undefined;
  if (image.format !== "png" && image.format !== "jpg") return undefined;
  return normalizePackageImage(image.format, image.quality);
}

/**
 * A package exported over the open project's own file replaces it, as a full
 * save does: the fast in-place save must not patch it as the project's file,
 * and a project that reads its embedded images from that file (a large
 * file's open) is rebound to the package's videos (`written`, in its order),
 * or marked until it is reopened when that fails (see projectFileReplaced and
 * rebindAfterExportOverProject).
 */
async function forgetProjectFileIfOverwritten(path: string, written: readonly Video[]): Promise<void> {
  const { projectPath, labels } = useAppStore.getState();
  if (!labels || !projectPath || path !== projectPath) return;
  projectFileReplaced(labels);
  // Nothing embedded and nothing read from the file on disk: nothing to rebind.
  if (!written.some((v) => v.hasEmbeddedImages) && !hasDiskBackedVideos(labels)) return;
  const { rebindAfterExportOverProject } = await import("@/lib/rebindEmbeddedVideos");
  await rebindAfterExportOverProject(labels, path, written);
}

/** Is the streaming desktop write (worker + native file writes) available? */
export async function canStreamPackage(): Promise<boolean> {
  return (
    (await getPlatform()).isTauri &&
    typeof SharedArrayBuffer !== "undefined" &&
    !!(globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated
  );
}

/**
 * Run `work` under the progress overlay with a Cancel button. `work` gets an
 * io `onProgress` that updates the overlay and returns `false` once Cancel is
 * clicked, which makes io stop with `ExportCancelled`. Always clears the
 * overlay.
 *
 * The in-memory save reports two passes — "Embedding frames" (read + encode),
 * then "Writing frames" — each counting from 1. With `twoPasses`, the bar
 * spends 90% on the first and the last 10% on the second, so it never jumps
 * back; the streamed export has one pass and uses the whole bar.
 */
export async function withEmbedProgress<T>(
  twoPasses: boolean,
  work: (
    onProgress: (current: number, total: number, message?: string) => boolean
  ) => Promise<T>
): Promise<T> {
  const { setLoading, setLoadingCancel } = useAppStore.getState();
  let cancelled = false;
  setLoading(true, "Embedding frames…", 0);
  setLoadingCancel(() => {
    cancelled = true;
    setLoading(true, "Cancelling…");
  });
  const onProgress = (current: number, total: number, message?: string) => {
    if (cancelled) return false;
    const writing = message === "Writing frames";
    const fraction = total > 0 ? current / total : 0;
    const pct = !twoPasses ? fraction : writing ? 0.9 + 0.1 * fraction : 0.9 * fraction;
    setLoading(
      true,
      `${writing ? "Writing frames" : "Embedding frames"} (${current}/${total})`,
      Math.round(pct * 100)
    );
    return true;
  };
  try {
    return await work(onProgress);
  } finally {
    setLoading(false);
  }
}

export function warnUnembedded(): void {
  toast.warning("Frames from continuous videos were not embedded", {
    description:
      "This project references a source video (e.g. .mp4) and its frame " +
      "images could not be embedded, so the package links to the source " +
      "video instead. Keep the source video alongside this package.",
  });
}

/**
 * Export a labels package (embedded-image `.pkg.slp`).
 *
 * Desktop, as PyQt SLEAP: ask where to save first, then write the package
 * straight to that file — the frames are read here and encoded + written
 * by a worker ({@link saveEmbeddedPkgStreaming}), so the window stays
 * responsive and only a few frames are in memory at a time, with progress and
 * Cancel. Projects whose videos are already embedded (a `.pkg.slp`), and the
 * browser, build the package in memory via `saveSlpToBytes` and then save it
 * through the Save-As plumbing (File System Access picker / download).
 *
 * Returns where the package was saved (a path on desktop, a name in the
 * browser), or null if nothing was written (cancelled or failed).
 */
export async function exportLabelsPackage(
  labels: Labels | null,
  filename: string | null,
  level: ExportPackageLevel,
  options: {
    /** Default file name in the Save dialog (default: `<project>.pkg.slp`). */
    suggestedName?: string;
    /** Frame format (default PNG, written exactly as before the option). */
    image?: PackageImageOptions;
  } = {}
): Promise<string | null> {
  if (!labels) return null;
  // Not while a save runs: it may be replacing the file these images are
  // read from (see saveInProgress.ts).
  if (refuseWhileSaving()) return null;
  // A project opened View only is never written, packages included, unless
  // the user allows editing (the prompt lists what the 2.x layout drops).
  if (!(await ensureWritable(labels, "export"))) return null;
  return withExportLock(() => exportLabelsPackageNow(labels, filename, level, options));
}

let exportRunning = false;

/**
 * Run one package-building export at a time: a second would race the first
 * for the progress overlay and the native file handle (and halve both's
 * speed). Returns null (with a note) when another export is still running.
 * Shared with the training job package export (trainingJobExport.ts).
 */
export async function withExportLock<T>(work: () => Promise<T | null>): Promise<T | null> {
  if (exportRunning) {
    toast.info("An export is already running", {
      description: "Wait for it to finish, or cancel it, before starting another.",
    });
    return null;
  }
  exportRunning = true;
  try {
    return await work();
  } finally {
    exportRunning = false;
  }
}

/**
 * Write a package of `labels` at `level` straight to `destPath` on desktop,
 * with no Save dialog — the streaming write when the source videos are
 * continuous, else built in memory and written. Used by the training job
 * package export, which writes the package to a temp file before zipping it.
 * Call inside {@link withEmbedProgress} (pass its `onProgress`). `image` is
 * the frame format (default PNG, as before).
 * Returns true when a video's frames could not be embedded.
 */
export async function writeLabelsPackageToPath(
  labels: Labels,
  level: ExportPackageLevel,
  destPath: string,
  onProgress: (current: number, total: number, message?: string) => boolean,
  image?: PackageImageOptions
): Promise<boolean> {
  const mode = embedModeForLevel(level);
  const exportLabels = labelsForLevel(labels, level);
  const embedVideos = videosToEmbed(exportLabels, level);
  await prepareVideosForFrameReads(embedVideos);
  if ((await canStreamPackage()) && !exportLabels.videos.some((v) => v.hasEmbeddedImages)) {
    await saveEmbeddedPkgStreaming(exportLabels, destPath, null, {
      embed: mode,
      onProgress,
      frameReader: ffmpegFrameReader(),
      image,
    });
    return embedVideos.some((v) => !v.backend);
  }
  const bytes = await saveSlpToBytes(
    exportLabels,
    withLegacyLayout(withImageFormat({ embed: mode, onProgress }, image))
  );
  await (await getPlatform()).writeFile(destPath, bytes);
  return packageLeavesFramesUnembedded(labels, bytes).catch(() => false);
}

/**
 * Build a package of `labels` at `level` in memory (browser path of the
 * training job package). `image` is the frame format (default PNG).
 */
export async function labelsPackageBytes(
  labels: Labels,
  level: ExportPackageLevel,
  onProgress: (current: number, total: number, message?: string) => boolean,
  image?: PackageImageOptions
): Promise<Uint8Array> {
  const exportLabels = labelsForLevel(labels, level);
  await prepareVideosForFrameReads(videosToEmbed(exportLabels, level));
  return saveSlpToBytes(
    exportLabels,
    withLegacyLayout(withImageFormat({ embed: embedModeForLevel(level), onProgress }, image))
  );
}

async function exportLabelsPackageNow(
  labels: Labels,
  filename: string | null,
  level: ExportPackageLevel,
  options: { suggestedName?: string; image?: PackageImageOptions }
): Promise<string | null> {
  // The open project's embedded images may be read under stale names (see
  // inPlaceBinding.ts): copying them could store another video's images.
  if (refuseStaleVideoNames(useAppStore.getState().labels, "Reopen this project before exporting")) {
    return null;
  }

  const mode = embedModeForLevel(level);
  const image = options.image;
  const suggestedName = options.suggestedName ?? derivePackageFilename(filename);
  const filter = { name: "SLEAP Labels Package", ext: "slp" };
  try {
    // Restrict the package to the frames this level means (predicted-only frames
    // are dropped for user/training) BEFORE serializing — `embed` alone would
    // still write every frame's metadata. See the module doc (FRAME SELECTION).
    const exportLabels = labelsForLevel(labels, level);
    const embedVideos = videosToEmbed(exportLabels, level);

    // Already-embedded videos copy their stored images from their own file;
    // the streaming export only embeds continuous videos.
    if (
      (await canStreamPackage()) &&
      !exportLabels.videos.some((v) => v.hasEmbeddedImages)
    ) {
      const platform = await getPlatform();
      const destPath = await platform.showSaveDialog({
        filters: [{ name: filter.name, extensions: [filter.ext] }],
        defaultName: suggestedName,
      });
      if (!destPath) return null; // user cancelled the dialog

      const unembedded = await withEmbedProgress(false, async (onProgress) => {
        // Open videos that haven't been viewed yet (their frames would otherwise
        // be skipped) and decode on a worker where possible.
        await prepareVideosForFrameReads(embedVideos);
        // Frames of local video files come from ffmpeg (native, all cores);
        // anything ffmpeg can't read is decoded and encoded in the app.
        await saveEmbeddedPkgStreaming(exportLabels, destPath, null, {
          embed: mode,
          onProgress,
          frameReader: ffmpegFrameReader(),
          image,
        });
        // A video with no open decoder can't be embedded and stays a link.
        return embedVideos.some((v) => !v.backend);
      });
      await forgetProjectFileIfOverwritten(destPath, exportLabels.videos);
      toastExported("Labels package exported", destPath, true);
      if (unembedded) warnUnembedded();
      return destPath;
    }

    // Browser (Chromium): stream through OPFS, as Save As of a large package
    // does. The picker comes first, while the Export click still counts as a
    // user gesture (the browser requires one to open it).
    if (
      !(await getPlatform()).isTauri &&
      isOpfsSaveSupported() &&
      !exportLabels.videos.some((v) => v.hasEmbeddedImages)
    ) {
      let destHandle: FileSystemFileHandle;
      try {
        destHandle = await pickSlpSaveDestination(suggestedName);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return null;
        throw err;
      }
      const unembedded = await withEmbedProgress(false, async (onProgress) => {
        await prepareVideosForFrameReads(embedVideos);
        await exportNewPkgOpfs(exportLabels, destHandle, { embed: mode, onProgress, image });
        return embedVideos.some((v) => !v.backend);
      });
      toastExported("Labels package exported", destHandle.name, false);
      if (unembedded) warnUnembedded();
      return destHandle.name;
    }

    // In memory: read + encode each frame here (seconds per frame for an mp4
    // with sparse keyframes) under the progress overlay, then pick where to
    // save.
    const bytes = await withEmbedProgress(true, async (onProgress) => {
      await prepareVideosForFrameReads(embedVideos);
      return saveSlpToBytes(
        exportLabels,
        withLegacyLayout(withImageFormat({ embed: mode, onProgress }, image))
      );
    });
    const saved = await saveBytesFile(bytes, suggestedName, filter);
    if (!saved) return null; // user cancelled the dialog/picker
    await forgetProjectFileIfOverwritten(saved, exportLabels.videos);

    toastExported("Labels package exported", saved, false);

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
    if (missingEmbeds) warnUnembedded();
    return saved;
  } catch (err) {
    if (err instanceof ExportCancelled) {
      toast.info("Export cancelled", { description: "No package was written." });
      return null;
    }
    const msg = err instanceof Error ? err.message : String(err);
    toast.error("Failed to export labels package", { description: msg });
    console.error("[ExportLabelsPackage] Failed to export:", err);
    return null;
  }
}

/** Level 1 — user-labeled frames only. */
export const ExportUserLabelsPackageCommand: Command = {
  name: "ExportUserLabelsPackage",
  topics: [],
  async execute(ctx: CommandContext, params?: Record<string, unknown>) {
    await exportLabelsPackage(ctx.state.labels, ctx.state.filename, "user", {
      image: packageImageParam(params),
    });
  },
};

/** Level 2 — user-labeled + suggested frames (recommended for training). */
export const ExportTrainingPackageCommand: Command = {
  name: "ExportTrainingPackage",
  topics: [],
  async execute(ctx: CommandContext, params?: Record<string, unknown>) {
    await exportLabelsPackage(ctx.state.labels, ctx.state.filename, "training", {
      image: packageImageParam(params),
    });
  },
};

/** Level 3 — all labeled frames, including predictions. */
export const ExportFullPackageCommand: Command = {
  name: "ExportFullPackage",
  topics: [],
  async execute(ctx: CommandContext, params?: Record<string, unknown>) {
    await exportLabelsPackage(ctx.state.labels, ctx.state.filename, "full", {
      image: packageImageParam(params),
    });
  },
};
