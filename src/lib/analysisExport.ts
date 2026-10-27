/**
 * Analysis export (HDF5 / CSV) helpers, mirroring PyQt SLEAP's
 * `ExportAnalysisFile` (`sleap/gui/commands.py`): which videos to export, and
 * the default file name for each.
 */
import type { Labels, Video } from "@talmolab/sleap-io.js";

export type AnalysisFormat = "h5" | "csv";

/** Final path component of a path or filename (either separator). */
function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

/** Python's `Path(p).stem`: the basename without its last suffix. */
function pathStem(path: string): string {
  const base = basename(path);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * The videos an analysis export writes: the current video (or the first) or
 * all of them, keeping only those with labeled frames, as PyQt.
 */
export function videosForAnalysis(
  labels: Labels,
  currentVideo: Video | null,
  allVideos: boolean
): Video[] {
  const candidates = allVideos
    ? labels.videos
    : [currentVideo ?? labels.videos[0]].filter((v): v is Video => !!v);
  const labeled = new Set(labels.labeledFrames.map((f) => f.video));
  return candidates.filter((v) => labeled.has(v));
}

/**
 * PyQt's default analysis file name for a video:
 * `{project stem}.{video index:03}_{video stem}.analysis.{ext}`, e.g.
 * `labels.v001.000_mice.analysis.h5`. The project stem is "labels" for an
 * unsaved project; an image-sequence video uses its first image's name.
 */
export function analysisFilename(
  projectFilename: string | null,
  labels: Labels,
  video: Video,
  format: AnalysisFormat
): string {
  const project = pathStem(projectFilename ?? "labels");
  const index = String(labels.videos.indexOf(video)).padStart(3, "0");
  const videoFile = Array.isArray(video.filename)
    ? (video.filename[0] ?? "")
    : video.filename;
  return `${project}.${index}_${pathStem(videoFile)}.analysis.${format}`;
}

/** The directory part of a path (no trailing separator), or null if none. */
export function directoryOf(path: string | null): string | null {
  if (!path) return null;
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut > 0 ? path.slice(0, cut) : null;
}
