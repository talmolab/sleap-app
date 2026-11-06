/**
 * Labels → Extract Clip and Labels / Extract Clip Labels Package — PyQt SLEAP's
 * `ExportLabelsSubset` (`sleap/gui/commands.py`): export the seekbar's selected
 * frame range of the current video as a project of its own, then open it in a
 * new window. As in PyQt, both need a selected range (the menu items are
 * disabled without one), and run from the Extract Clip dialog
 * (`ExtractClipDialog.tsx`, PyQt's Export Clip Options), which passes
 * {@link ExtractClipParams}.
 *
 *  - **Clip and Labels**: a trimmed copy of the video (an mp4 of the range's
 *    frames, no overlays) plus a `.slp` whose frames are renumbered to start at
 *    0 and point at that clip.
 *  - **Clip Labels Package**: the range's labeled and suggested frames, with
 *    their images embedded, in a `.pkg.slp` that keeps the original video's
 *    frame numbers (PyQt's Level 3 package of the subset).
 *
 * Unlike PyQt, the `.slp` variant always writes a clip when the range is not
 * the whole video. (PyQt skips the clip when the range runs to the video's
 * last frame but still renumbers the frames, which misaligns them.)
 */
import {
  Labels,
  SuggestionFrame,
  Video,
  saveSlpToBytes,
} from "@talmolab/sleap-io.js";
import type { Command } from "./types";
import type { CommandContext } from "./CommandContext";
import {
  ClipExportCancelled,
  computeClipOutputDimensions,
  computeInitialClipRange,
  evaluateClipEncodeSupport,
  runClipExport,
  type FrameRange,
} from "@/lib/videoExport";
import { exportLabelsPackage } from "./exportPackageCommands";
import { getPlatform } from "../platform/index";
import { downloadFile } from "@/lib/exportUtils";
import { directoryOf } from "@/lib/analysisExport";
import { openNewInstance } from "@/lib/newInstance";
import { toast } from "@/lib/notify";
import { toastExported } from "@/lib/exportToast";
import { useAppStore } from "@/stores/appStore";

/** Options from the Extract Clip dialog. */
export interface ExtractClipParams {
  /** The clip's frame rate (Extract Clip and Labels; default: the video's). */
  fps?: number;
  /** Open the new project in a new window when done (default true, as PyQt). */
  openWhenDone?: boolean;
}

/**
 * The frames to extract from `video`: the seekbar selection (inclusive),
 * clamped to the video. Null when nothing is selected or the video's length
 * isn't known.
 */
export function extractRange(
  frameRange: readonly [number, number] | null,
  video: Video
): FrameRange | null {
  const n = video.shape?.[0] ?? 0;
  if (n <= 0 || !frameRange) return null;
  const { start, end } = computeInitialClipRange(frameRange, n);
  return { start, end, count: end - start + 1 };
}

/** `<project>.clip_<start>-<end>.<ext>`, e.g. `labels.clip_100-249.slp`. */
export function extractFilename(
  projectFilename: string | null,
  range: { start: number; end: number },
  ext: "slp" | "pkg.slp" | "mp4"
): string {
  const name = (projectFilename ?? "labels").split(/[\\/]/).pop() || "labels";
  const base = name.replace(/\.pkg\.slp$/i, "").replace(/\.(slp|json)$/i, "");
  return `${base}.clip_${range.start}-${range.end}.${ext}`;
}

/**
 * The labels of `video`'s frames inside `range` (inclusive): its labeled and
 * suggested frames there, with the project's skeletons.
 *
 * With `clip`, the frames are copies renumbered to start at 0 and pointing at
 * `clip` (the trimmed video). Without, they keep the original video and frame
 * numbers, and share the original frames (nothing is modified), so its
 * images can be read for embedding.
 */
export function labelsForRange(
  labels: Labels,
  video: Video,
  range: { start: number; end: number },
  clip?: Video
): Labels {
  const inRange = (f: number) => f >= range.start && f <= range.end;
  const inds = labels.labeledFrames
    .filter((lf) => lf.video === video && inRange(lf.frameIdx))
    .map((lf) => [video, lf.frameIdx] as [Video, number]);
  const subset = inds.length > 0 ? labels.extract(inds, clip !== undefined) : null;
  const frames = subset?.labeledFrames ?? [];
  const target = clip ?? video;
  const shift = clip ? range.start : 0;
  if (clip) {
    for (const lf of frames) {
      lf.video = clip;
      lf.frameIdx -= shift;
    }
  }
  const suggestions = labels.suggestions
    .filter((s) => s.video === video && inRange(s.frameIdx))
    .map((s) =>
      clip
        ? new SuggestionFrame({ video: clip, frameIdx: s.frameIdx - shift, group: s.group })
        : s
    );
  return new Labels({
    labeledFrames: frames,
    videos: [target],
    skeletons: labels.skeletons,
    tracks: subset?.tracks ?? [],
    suggestions,
    provenance: { ...labels.provenance },
  });
}

/** Make sure the video's dimensions are known (decode frame 0 once). */
async function ensureShape(video: Video): Promise<boolean> {
  const has = () => !!(video.shape?.[0] && video.shape[1] && video.shape[2]);
  if (!has() && video.backend) {
    try {
      await video.backend.getFrame(0);
      if (video.backend.shape) video.shape = video.backend.shape;
    } catch {
      // Stays unknown; the caller reports it.
    }
  }
  return has();
}

/** Encode `range` of `video` (no overlays, full size, its own fps) to mp4. */
async function encodeRawClip(
  video: Video,
  range: FrameRange,
  fps: number,
  signal: AbortSignal,
  onProgress: (done: number, total: number) => void
): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const sourceWidth = video.shape![2];
  const sourceHeight = video.shape![1];
  const output = computeClipOutputDimensions(sourceWidth, sourceHeight, 1);
  const { buildClipExportPipeline, decodeExportFrame, clipEncodeProbe } = await import(
    "@/lib/videoExportPipeline"
  );
  const support = await evaluateClipEncodeSupport(clipEncodeProbe, output);
  if (!support.supported) throw new Error(support.message);
  const deps = buildClipExportPipeline({
    output,
    fps,
    video,
    decodeFrame: (frameIdx) => decodeExportFrame(video, frameIdx),
    overlayForFrame: () => [],
  });
  const bytes = await runClipExport(
    {
      range,
      fps,
      scale: 1,
      sourceWidth,
      sourceHeight,
      output,
      renderOptions: {
        markerSize: 0,
        nodeLabelSize: 0,
        edgeStyle: "Line",
        showInstances: false,
        showLabels: false,
        showEdges: false,
        showNonVisibleNodes: false,
        colorPredicted: false,
        showTrackScore: false,
      },
    },
    { ...deps, renderOverlay: () => {} },
    { signal, onProgress }
  );
  return { bytes, width: output.width, height: output.height };
}

/** The current video and the range to extract, or null (after telling the user). */
async function rangeToExtract(
  ctx: CommandContext
): Promise<{ labels: Labels; video: Video; range: FrameRange } | null> {
  const { labels, video } = ctx.state;
  if (!labels || !video) {
    toast.info("Open a video to extract a clip from.");
    return null;
  }
  if (!ctx.state.frameRange) {
    toast.info("Select a frame range first", {
      description: "Shift-drag on the seekbar to select the frames to extract.",
    });
    return null;
  }
  const range = (await ensureShape(video))
    ? extractRange(ctx.state.frameRange, video)
    : null;
  if (!range) {
    toast.error("Can't extract a clip", {
      description: "The video's length and size aren't known yet. Wait for it to load, then try again.",
    });
    return null;
  }
  return { labels, video, range };
}

/** Labels → Extract Clip and Labels: a trimmed mp4 + a `.slp` that uses it. */
export const ExtractClipAndLabelsCommand: Command = {
  name: "ExtractClipAndLabels",
  topics: [],
  async execute(ctx: CommandContext, params?: ExtractClipParams) {
    const target = await rangeToExtract(ctx);
    if (!target) return;
    const { labels, video, range } = target;
    const platform = await getPlatform();

    // Desktop: one Save dialog for the .slp; the clip goes next to it.
    let slpPath = extractFilename(ctx.state.filename, range, "slp");
    if (platform.isTauri) {
      const dir = directoryOf(ctx.state.projectPath);
      const chosen = await platform.showSaveDialog({
        filters: [{ name: "SLEAP Labels", extensions: ["slp"] }],
        defaultName: dir ? `${dir}/${slpPath}` : slpPath,
      });
      if (!chosen) return;
      slpPath = chosen;
    }
    const clipPath = `${slpPath.replace(/\.slp$/i, "")}.mp4`;

    const { setLoading, setLoadingCancel } = useAppStore.getState();
    const controller = new AbortController();
    setLoading(true, "Writing the clip…", 0);
    setLoadingCancel(() => {
      controller.abort();
      setLoading(true, "Cancelling…");
    });
    try {
      const fps =
        params?.fps && params.fps > 0 ? params.fps : video.fps && video.fps > 0 ? video.fps : 30;
      const clip = await encodeRawClip(video, range, fps, controller.signal, (done, total) =>
        setLoading(true, `Writing the clip (${done}/${total})`, Math.round((done / total) * 100))
      );
      const channels = video.shape?.[3] ?? 3;
      const clipVideo = new Video({
        filename: platform.isTauri ? clipPath : (clipPath.split(/[\\/]/).pop() ?? clipPath),
        backendMetadata: {
          shape: [range.count, clip.height, clip.width, channels],
          fps,
          grayscale: channels === 1,
        },
        openBackend: false,
      });
      const slpBytes = await saveSlpToBytes(labelsForRange(labels, video, range, clipVideo));
      setLoading(false);

      if (platform.isTauri) {
        await platform.writeFile(clipPath, clip.bytes);
        await platform.writeFile(slpPath, slpBytes);
        toastExported("Clip and labels extracted", slpPath, true);
        if (params?.openWhenDone !== false) await openNewInstance({ file: slpPath });
      } else {
        downloadFile(new Blob([clip.bytes as BlobPart]), clipVideo.filename as string, "video/mp4");
        downloadFile(new Blob([slpBytes as BlobPart]), slpPath, "application/octet-stream");
        toast.success("Clip and labels extracted", {
          description: `${slpPath} and ${clipVideo.filename} (keep them in the same folder)`,
        });
      }
    } catch (err) {
      if (err instanceof ClipExportCancelled) {
        toast.info("Extract cancelled", { description: "Nothing was written." });
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      toast.error("Failed to extract the clip", { description: msg });
      console.error("[ExtractClipAndLabels] Failed:", err);
    } finally {
      setLoading(false);
    }
  },
};

/**
 * Labels → Extract Clip Labels Package: the range's labeled + suggested frames,
 * images embedded, in a `.pkg.slp` (original frame numbers).
 */
export const ExtractClipLabelsPackageCommand: Command = {
  name: "ExtractClipLabelsPackage",
  topics: [],
  async execute(ctx: CommandContext, params?: ExtractClipParams) {
    const target = await rangeToExtract(ctx);
    if (!target) return;
    const { labels, video, range } = target;
    const saved = await exportLabelsPackage(
      labelsForRange(labels, video, range),
      ctx.state.filename,
      "full",
      { suggestedName: extractFilename(ctx.state.filename, range, "pkg.slp") }
    );
    if (saved && params?.openWhenDone !== false && (await getPlatform()).isTauri) {
      await openNewInstance({ file: saved });
    }
  },
};
