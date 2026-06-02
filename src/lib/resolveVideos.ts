/**
 * Resolve external video files that couldn't be loaded from the SLP.
 * When loadSlp() encounters external MP4 references, the video.backend
 * may be null because the bare filename can't be fetched in the browser.
 * This module provides helpers to locate those files via the Videos panel,
 * and auto-resolution via the filesystem in Tauri mode.
 */

import { Mp4BoxVideoBackend, Video } from "@talmolab/sleap-io.js";
import { toast } from "@/lib/notify";
import type { Labels } from "../types";
import { getPlatform } from "../platform/index";

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
  if (video.hasEmbeddedImages) return false;
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
  const platform = await getPlatform();
  console.log(`[video] Picking video file via ${platform.isTauri ? "Tauri" : "browser"} dialog`);

  const result = await platform.showOpenDialog({
    filters: [
      { name: "Video files", extensions: ["mp4", "avi", "mov", "mkv", "webm"] },
    ],
  });

  if (!result) return false;

  if (typeof result === "string") {
    // Tauri: got a file path — read bytes and create a File object
    console.log(`[video] Loading video from path: ${result}`);
    try {
      const bytes = await platform.readFile(result);
      const name = getBasename(result);
      console.log(`[video] Read ${bytes.byteLength} bytes for "${name}"`);
      const file = new File([bytes], name, { type: "video/mp4" });
      await assignVideoBackend(video, file);
      // Update the video's filename to the resolved absolute path
      video.filename = result;
      toast.success(`Loaded video: ${name}`);
      return true;
    } catch (err) {
      console.error(`[video] Failed to read video file "${result}":`, err);
      return false;
    }
  } else if (result instanceof File) {
    // Browser: got a File object
    console.log(`[video] Loading video from File object: ${result.name} (${result.size} bytes)`);
    await assignVideoBackend(video, result);
    toast.success(`Loaded video: ${result.name}`);
    return true;
  }

  return false;
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

  const platform = await getPlatform();
  console.log(`[video] Batch-resolving ${unresolvedVideos.length} video(s) via ${platform.isTauri ? "Tauri" : "browser"} dialog`);
  const videoFilters = [
    { name: "Video files", extensions: ["mp4", "avi", "mov", "mkv", "webm"] },
  ];

  const result = await platform.showOpenDialog({
    filters: videoFilters,
    multiple: true,
  });

  if (!result) {
    toast.warning("No video files selected");
    return 0;
  }

  // Normalize to arrays of {name, path?, getFile} for unified matching
  interface PickedVideo {
    name: string;
    path?: string;
    getFile: () => Promise<File>;
  }
  let picked: PickedVideo[];

  if (Array.isArray(result) && result.length > 0 && typeof result[0] === "string") {
    // Tauri: got string[] of file paths
    picked = (result as string[]).map((path) => ({
      name: getBasename(path),
      path,
      getFile: async () => {
        const bytes = await platform.readFile(path);
        return new File([bytes], getBasename(path), { type: "video/mp4" });
      },
    }));
  } else if (Array.isArray(result)) {
    // Browser: got File[]
    picked = (result as File[]).map((f) => ({
      name: f.name,
      getFile: async () => f,
    }));
  } else if (typeof result === "string") {
    // Tauri: single path (shouldn't happen with multiple:true but handle it)
    picked = [{
      name: getBasename(result),
      path: result,
      getFile: async () => {
        const bytes = await platform.readFile(result);
        return new File([bytes], getBasename(result), { type: "video/mp4" });
      },
    }];
  } else if (result instanceof File) {
    picked = [{ name: result.name, getFile: async () => result }];
  } else {
    return 0;
  }

  if (picked.length === 0) {
    toast.warning("No video files selected");
    return 0;
  }

  let matchCount = 0;

  for (const video of unresolvedVideos) {
    const expectedName = getBasename(video.filename).toLowerCase();
    const match = picked.find(
      (p) => p.name.toLowerCase() === expectedName
    );

    if (match) {
      const file = await match.getFile();
      await assignVideoBackend(video, file);
      // Update filename to resolved path for Tauri
      if (match.path) video.filename = match.path;
      matchCount++;
    }
  }

  // Special case: 1 unresolved video + 1 picked file -> assign even if names don't match
  if (
    matchCount === 0 &&
    unresolvedVideos.length === 1 &&
    picked.length === 1
  ) {
    const file = await picked[0].getFile();
    await assignVideoBackend(unresolvedVideos[0], file);
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
    console.log(`[video] Creating Mp4BoxVideoBackend for "${file.name}" (${file.size} bytes)`);
    const backend = new Mp4BoxVideoBackend(file);
    video.backend = backend;
    // Trigger initialization by requesting frame 0 (stays in cache for later use)
    await backend.getFrame(0);
    if (backend.shape) video.shape = backend.shape;
    if (backend.fps) video.fps = backend.fps;
    console.log(`[video] Backend ready: ${video.shape?.[1]}x${video.shape?.[2]} @ ${video.fps}fps, ${video.shape?.[0]} frames`);
  } catch (err) {
    console.error(`Failed to load video backend for ${file.name}:`, err);
    toast.error(`Failed to load video: ${file.name}`, {
      description: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Standalone-video file extensions we can currently decode. MP4 only for now;
 * this is the dispatch point for future MediaBunny (WebM/MOV/MKV) and Seq
 * (.seq) backends — add the extension here and branch in buildStandaloneVideo.
 */
export const SUPPORTED_VIDEO_EXTS = ["mp4"] as const;

/** Lowercased extension of a filename, or "" if none. */
function fileExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

/**
 * Build a new standalone Video from a user-picked file, dispatching by
 * extension. MP4 → Mp4Box backend (via {@link assignVideoBackend}, which probes
 * shape/fps). Unsupported formats are rejected with a toast and return null
 * (the drop-in point for MediaBunny/Seq later). Returns null on decode failure
 * too (assignVideoBackend already surfaces the error).
 */
export async function buildStandaloneVideo(file: File): Promise<Video | null> {
  const ext = fileExt(file.name);
  if (!(SUPPORTED_VIDEO_EXTS as readonly string[]).includes(ext)) {
    toast.error(`${ext ? `.${ext} files are` : "This file is"} not supported yet`, {
      description: "Only MP4 is supported for now — WebM, MOV, and .seq are coming.",
    });
    return null;
  }
  const video = new Video({ filename: file.name, openBackend: false });
  await assignVideoBackend(video, file);
  // assignVideoBackend sets shape only on a successful probe (and toasts on
  // failure); a missing shape means the backend never initialized.
  if (!video.shape) return null;
  return video;
}

/**
 * Open a file picker and add the chosen standalone video file(s) to the
 * project's labels. Handles both browser (File) and Tauri (path → readFile)
 * results, dispatches each file through {@link buildStandaloneVideo}, and
 * reindexes via labels.reindex(). Returns the videos actually added (callers
 * select the first and refresh the UI). Unsupported/failed files are skipped
 * (each surfaces its own toast).
 */
export async function pickAndAddVideos(labels: Labels): Promise<Video[]> {
  const platform = await getPlatform();
  const result = await platform.showOpenDialog({
    multiple: true,
    filters: [{ name: "Video files", extensions: [...SUPPORTED_VIDEO_EXTS] }],
  });
  if (!result) return []; // cancelled

  const picked = Array.isArray(result) ? result : [result];
  const added: Video[] = [];

  for (const item of picked) {
    let file: File;
    let absPath: string | null = null;
    if (typeof item === "string") {
      // Tauri: got a path — read bytes into a File (mirrors resolveVideoFile).
      try {
        const bytes = await platform.readFile(item);
        file = new File([bytes], getBasename(item), { type: "video/mp4" });
        absPath = item;
      } catch (err) {
        console.error(`[video] Failed to read "${item}":`, err);
        toast.error(`Failed to read ${getBasename(item)}`, {
          description: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
    } else {
      file = item;
    }

    const video = await buildStandaloneVideo(file);
    if (!video) continue; // unsupported format or decode failure (already toasted)
    // On Tauri, keep the absolute path as the canonical filename so the video
    // resolves on reload; in the browser the basename is all we have.
    if (absPath) video.filename = absPath;
    labels.addVideo(video);
    added.push(video);
  }

  // Rebuild lookups after the structural change. NOTE: use reindex(), NOT
  // update() — the sleap-io.js .d.ts declares Labels.update() but the shipped
  // JS only implements reindex(), so update() throws at runtime.
  if (added.length > 0) labels.reindex();
  return added;
}
