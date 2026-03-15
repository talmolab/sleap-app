/**
 * Resolve external video files that couldn't be loaded from the SLP.
 * When loadSlp() encounters external MP4 references, the video.backend
 * may be null because the bare filename can't be fetched in the browser.
 * This module provides helpers to locate those files via the Videos panel,
 * and auto-resolution via the filesystem in Tauri mode.
 */

import { Mp4BoxVideoBackend } from "@talmolab/sleap-io.js";
import { toast } from "sonner";
import type { Labels, Video } from "../types";

/** Extract just the basename from a path or filename. */
export function getBasename(filename: string | string[]): string {
  const f = Array.isArray(filename) ? filename[0] ?? "" : filename;
  const parts = f.split(/[\\/]/);
  return parts[parts.length - 1] ?? f;
}

/** Check if a filename looks like a fetchable URL. */
export function isFetchableUrl(filename: string | string[]): boolean {
  const f = Array.isArray(filename) ? filename[0] ?? "" : filename;
  return /^(https?:|blob:|data:)/i.test(f);
}

/** Check if a video is missing its backend (unresolved external file). */
export function isVideoMissing(video: Video): boolean {
  return video.backend === null && !isFetchableUrl(video.filename);
}

/**
 * Resolve a video filename to an absolute path given the project file path.
 * Handles absolute paths (returned as-is), relative paths (resolved against
 * the project directory), and basenames.
 */
export function resolveVideoPath(
  video: Video,
  projectPath: string | null
): string {
  const raw = Array.isArray(video.filename)
    ? video.filename[0]
    : video.filename;
  if (!raw) return "";
  // Already absolute (Unix or Windows)
  if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) return raw;
  // Resolve relative paths against the project file's directory
  if (projectPath) {
    const sep = projectPath.includes("\\") ? "\\" : "/";
    const dir = projectPath.substring(0, projectPath.lastIndexOf(sep));
    return dir + sep + raw.replace(/[\\/]/g, sep);
  }
  return raw;
}

/**
 * Generate candidate absolute paths for a video file, given the project path.
 * Returns paths to try in priority order:
 * 1. The raw filename if it's already absolute
 * 2. The relative path resolved against the project directory
 * 3. The basename resolved against the project directory (for moved projects)
 */
export function getVideoPathCandidates(
  video: Video,
  projectPath: string
): string[] {
  const raw = Array.isArray(video.filename)
    ? video.filename[0] ?? ""
    : video.filename;
  if (!raw) return [];

  const sep = projectPath.includes("\\") ? "\\" : "/";
  const projectDir = projectPath.substring(0, projectPath.lastIndexOf(sep));
  const baseName = getBasename(raw);
  const isAbsolute =
    raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw);

  const candidates: string[] = [];

  // 1. If absolute, try as-is
  if (isAbsolute) {
    candidates.push(raw);
  }

  // 2. Relative path resolved against project dir
  if (!isAbsolute) {
    candidates.push(projectDir + sep + raw.replace(/[\\/]/g, sep));
  }

  // 3. Basename only, in project dir (for moved/reorganized projects)
  const basenameCandidate = projectDir + sep + baseName;
  if (!candidates.includes(basenameCandidate)) {
    candidates.push(basenameCandidate);
  }

  return candidates;
}

/** Options for auto-resolving videos from the filesystem. */
export interface AutoResolveOptions {
  /** Full path to the SLP project file. */
  projectPath: string;
  /** Check if a file exists at the given path. */
  exists: (path: string) => Promise<boolean>;
  /** Read a file from the filesystem. */
  readFile: (path: string) => Promise<Uint8Array>;
}

/**
 * After loadSlp() returns, detect videos with no backend (external MP4s that
 * couldn't be resolved) and attempt auto-resolution.
 *
 * In Tauri mode (when options are provided), tries to resolve each video's
 * path relative to the project directory, reads the file via the FS plugin,
 * and creates a backend from the bytes. Falls back to showing a toast for
 * any videos that can't be auto-resolved.
 */
export async function resolveExternalVideos(
  labels: Labels,
  options?: AutoResolveOptions
): Promise<void> {
  // Validate existing backends: loadSlp may have created Mp4BoxVideoBackend
  // instances with invalid paths (e.g. Windows paths on Mac). These have
  // backend !== null but their ready promise will reject. Await each and
  // null out broken ones so they get picked up by auto-resolution.
  await Promise.all(
    labels.videos.map(async (video) => {
      if (!video.backend || !("ready" in video.backend)) return;
      try {
        await (video.backend as { ready: Promise<unknown> }).ready;
      } catch {
        console.log(
          `[video] Backend failed for "${Array.isArray(video.filename) ? video.filename[0] : video.filename}", clearing for re-resolution`
        );
        video.backend = null;
      }
    })
  );

  const unresolvedVideos = labels.videos.filter(isVideoMissing);
  if (unresolvedVideos.length === 0) return;

  let resolvedCount = 0;

  // Try auto-resolution if we have filesystem access and a project path
  if (options) {
    for (const video of unresolvedVideos) {
      const candidates = getVideoPathCandidates(video, options.projectPath);
      console.log(
        `[video] Resolving "${Array.isArray(video.filename) ? video.filename[0] : video.filename}", candidates:`,
        candidates
      );
      for (const candidatePath of candidates) {
        try {
          const found = await options.exists(candidatePath);
          if (found) {
            console.log(`[video] Found at: ${candidatePath}`);
            const bytes = await options.readFile(candidatePath);
            const name = getBasename(candidatePath);
            const file = new File([bytes], name, { type: "video/mp4" });
            await assignVideoBackend(video, file);
            if (video.backend) {
              // Preserve the original SLP path in metadata before updating
              const origFilename = Array.isArray(video.filename)
                ? video.filename[0] ?? ""
                : video.filename;
              if (origFilename !== candidatePath) {
                (video.backendMetadata as Record<string, unknown>).sourceFilename = origFilename;
              }
              video.filename = candidatePath;
              resolvedCount++;
              break;
            }
          }
        } catch (err) {
          console.warn(`[video] Failed to resolve "${candidatePath}":`, err);
        }
      }
    }
  }

  // Show toast for any remaining unresolved videos
  const stillMissing = labels.videos.filter(isVideoMissing);
  if (stillMissing.length > 0) {
    const n = stillMissing.length;
    toast.info(
      `${n} video${n > 1 ? "s" : ""} not found. Use the Videos panel to locate them.`,
      {
        description:
          "Annotations will be visible but video frames will be blank.",
      }
    );
  }

  if (resolvedCount > 0) {
    toast.success(
      `Auto-resolved ${resolvedCount} video${resolvedCount > 1 ? "s" : ""}`
    );
  }
}

/**
 * Open a file picker for a single video and assign its backend.
 * Returns true if a video was successfully loaded.
 */
export async function resolveVideoFile(video: Video): Promise<boolean> {
  let pickedFiles: File[];

  try {
    if ("showOpenFilePicker" in window) {
      const handles = await (window as any).showOpenFilePicker({
        multiple: false,
        types: [
          {
            description: "Video files",
            accept: { "video/*": [".mp4", ".avi", ".mov", ".mkv", ".webm"] },
          },
        ],
      });
      pickedFiles = await Promise.all(
        handles.map((h: any) => h.getFile() as Promise<File>)
      );
    } else {
      pickedFiles = await new Promise<File[]>((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "video/*";
        input.onchange = () => {
          const files = input.files ? Array.from(input.files) : [];
          resolve(files);
        };
        input.addEventListener("cancel", () => resolve([]));
        input.click();
      });
    }
  } catch {
    return false;
  }

  if (pickedFiles.length === 0) return false;

  await assignVideoBackend(video, pickedFiles[0]);
  toast.success(`Loaded video: ${pickedFiles[0].name}`);
  return true;
}

/**
 * Open a multi-file picker to batch-resolve multiple missing videos.
 * Matches picked files to videos by basename (case-insensitive).
 * Returns the number of videos successfully resolved.
 */
export async function resolveAllVideoFiles(
  videos: Video[]
): Promise<number> {
  const unresolvedVideos = videos.filter(isVideoMissing);
  if (unresolvedVideos.length === 0) return 0;

  let pickedFiles: File[];

  try {
    if ("showOpenFilePicker" in window) {
      const handles = await (window as any).showOpenFilePicker({
        multiple: true,
        types: [
          {
            description: "Video files",
            accept: { "video/*": [".mp4", ".avi", ".mov", ".mkv", ".webm"] },
          },
        ],
      });
      pickedFiles = await Promise.all(
        handles.map((h: any) => h.getFile() as Promise<File>)
      );
    } else {
      pickedFiles = await new Promise<File[]>((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.multiple = true;
        input.accept = "video/*";
        input.onchange = () => {
          const files = input.files ? Array.from(input.files) : [];
          resolve(files);
        };
        input.addEventListener("cancel", () => resolve([]));
        input.click();
      });
    }
  } catch {
    toast.warning("Video file selection cancelled");
    return 0;
  }

  if (pickedFiles.length === 0) {
    toast.warning("No video files selected");
    return 0;
  }

  let matchCount = 0;

  for (const video of unresolvedVideos) {
    const expectedName = getBasename(video.filename).toLowerCase();
    const matchedFile = pickedFiles.find(
      (f) => f.name.toLowerCase() === expectedName
    );

    if (matchedFile) {
      await assignVideoBackend(video, matchedFile);
      matchCount++;
    }
  }

  // Special case: 1 unresolved video + 1 picked file -> assign even if names don't match
  if (
    matchCount === 0 &&
    unresolvedVideos.length === 1 &&
    pickedFiles.length === 1
  ) {
    await assignVideoBackend(unresolvedVideos[0], pickedFiles[0]);
    matchCount = 1;
  }

  if (matchCount > 0) {
    toast.success(`Loaded ${matchCount} video${matchCount > 1 ? "s" : ""}`);
  }

  if (matchCount < unresolvedVideos.length) {
    const remaining = unresolvedVideos.length - matchCount;
    toast.warning(
      `${remaining} video${remaining > 1 ? "s" : ""} could not be matched`,
      {
        description:
          "Annotations will be visible but some video frames will be blank.",
      }
    );
  }

  return matchCount;
}

/**
 * Create an Mp4BoxVideoBackend from a user-picked File and assign it to a Video.
 */
export async function assignVideoBackend(video: Video, file: File): Promise<void> {
  try {
    const backend = new Mp4BoxVideoBackend(file);
    video.backend = backend;
    // Trigger initialization by requesting frame 0 (stays in cache for later use)
    await backend.getFrame(0);
    if (backend.shape) video.shape = backend.shape;
    if (backend.fps) video.fps = backend.fps;
  } catch (err) {
    console.error(`Failed to load video backend for ${file.name}:`, err);
    toast.error(`Failed to load video: ${file.name}`, {
      description: err instanceof Error ? err.message : String(err),
    });
  }
}
