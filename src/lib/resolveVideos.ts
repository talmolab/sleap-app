/**
 * Resolve external video files that couldn't be loaded from the SLP.
 * When loadSlp() encounters external MP4 references, the video.backend
 * may be null because the bare filename can't be fetched in the browser.
 * This module provides helpers to locate those files via the Videos panel,
 * and auto-resolution via the filesystem in Tauri mode.
 */

import {
  Mp4BoxVideoBackend,
  MediaBunnyVideoBackend,
  SeqVideoBackend,
  Video,
  createVideoBackend,
  type VideoBackend,
  type VideoBackendError,
  type RangeSource,
} from "@talmolab/sleap-io.js";
import { toast } from "@/lib/notify";
import type { Labels } from "../types";
import { getPlatform } from "../platform/index";
import { tailGraftCandidates } from "./pathCandidates";
import { applyPrefixSwap } from "./videoPrefixSwaps";
import { fileSize, readRange } from "./nativeRange";
import { useAppStore } from "@/stores/appStore";

/** Extract just the basename from a path or filename. */
export function getBasename(filename: string | string[]): string {
  const f = Array.isArray(filename) ? filename[0] ?? "" : filename;
  const parts = f.split(/[\\/]/);
  return parts[parts.length - 1] ?? f;
}

/** Path separator implied by a path string (Windows backslash vs POSIX slash). */
function pathSep(p: string): string {
  return p.includes("\\") ? "\\" : "/";
}

/**
 * Up to `count` frame indices spread across a sequence of length `n`: the first,
 * the last, and an even spread between. Probing several frames — not just frame
 * 0 — means a sequence whose frame 0 is specifically missing (deleted/renamed)
 * but whose other frames are present is still recognized as resolvable and its
 * subfolder depth is still detectable.
 */
function sampleIndices(n: number, count = 8): number[] {
  if (n <= 0) return [];
  if (n <= count) return Array.from({ length: n }, (_, i) => i);
  const step = (n - 1) / (count - 1);
  const out = new Set<number>();
  for (let i = 0; i < count; i++) out.add(Math.round(i * step));
  return [...out];
}

/**
 * Re-resolve an image-sequence's stored frame paths against a user-picked folder.
 * Returns one `located` path per input frame, IN ORDER (positions preserved so
 * they stay aligned with label frame indices), plus the `missing` original frame
 * paths not found under the folder.
 *
 * The folder need NOT be the exact leaf directory: we detect the subfolder
 * depth by voting across a sample of frames (probing `<folder>/<basename>`,
 * `<folder>/<subdir>/<basename>`, …) and apply the winning depth to every frame.
 * So the user can pick ANY ancestor — the project folder, a parent — instead of
 * opening the leaf image directory, which on a network mount with 10k+ files can
 * freeze the native file dialog. Frames that DON'T match the voted depth (a
 * mixed-depth sequence, e.g. a COCO dataset with images at varying subfolder
 * depths) fall back to per-frame resolution, so no frame is lost to the
 * majority's layout. Pure + decoder-independent (unit-tested here; the decode is
 * covered by E2E).
 */
export async function resolveImageFramesInFolder(
  frames: string[],
  folder: string,
  exists: (path: string) => Promise<boolean>
): Promise<{ located: string[]; missing: string[] }> {
  const sep = pathSep(folder);
  const dir = folder.replace(/[\\/]+$/, "");

  // Detect the subfolder depth by VOTING across a sample of frames, not frame 0
  // alone. For each sampled frame, `tailGraftCandidates` yields `<dir>/<last-k
  // segments>` for k = 1, 2, …; take the closest (smallest k) that exists and
  // vote for it. The most-voted depth wins (tie → shallower). This survives a
  // missing frame 0 (other frames still vote) and a stray same-named copy in an
  // ancestor (one frame votes shallow, the rest vote the true subfolder depth,
  // and the majority wins). Falls back to 1 when nothing resolves.
  const votes = new Map<number, number>();
  for (const idx of sampleIndices(frames.length)) {
    const cands = tailGraftCandidates(frames[idx], dir, { includeFullPath: true });
    for (let i = 0; i < cands.length; i++) {
      if (await exists(cands[i])) {
        votes.set(i + 1, (votes.get(i + 1) ?? 0) + 1);
        break;
      }
    }
  }
  const depth =
    votes.size > 0
      ? [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0]
      : 1;

  const tailOf = (f: string): string => {
    const segs = f.split(/[\\/]/).filter(Boolean);
    return segs.slice(Math.max(0, segs.length - depth)).join(sep);
  };

  const located = frames.map((f) => dir + sep + tailOf(f));
  const missing: string[] = [];
  for (let i = 0; i < frames.length; i++) {
    if (await exists(located[i])) continue;
    // The voted depth is wrong for THIS frame — a mixed-depth sequence (e.g. a
    // COCO dataset with images at varying subfolder depths, some in the root and
    // some under subdirs). Resolve it at its OWN depth: keep its stored path
    // as-is (an already-correct absolute path), else graft progressively longer
    // tails under `dir`, closest-first. Only mismatched frames pay these extra
    // probes; a uniform sequence resolves entirely at the voted depth as before.
    const perFrame = [
      frames[i],
      ...tailGraftCandidates(frames[i], dir, { includeFullPath: true }),
    ];
    let resolved: string | null = null;
    for (const cand of perFrame) {
      if (await exists(cand)) {
        resolved = cand;
        break;
      }
    }
    if (resolved) located[i] = resolved;
    else missing.push(frames[i]);
  }
  return { located, missing };
}

/**
 * Rewrite an image-sequence video to its located absolute frame paths (stashing
 * the original in `backendMetadata.sourceFilename`, positions preserved) and
 * rebuild its `ImageVideoBackend` via the injected image reader. The `.slp`
 * shape is passed through so construction does NOT decode frame 0 (a missing
 * frame just renders blank later). Throws if the backend can't be built. Shared
 * by the manual "Locate folder" flow and load-time auto-locate.
 */
async function applyImageSequenceLocation(
  video: Video,
  located: string[]
): Promise<void> {
  const origFilename = Array.isArray(video.filename)
    ? video.filename[0] ?? ""
    : video.filename;
  const meta = video.backendMetadata as Record<string, unknown>;
  if (meta.sourceFilename === undefined) meta.sourceFilename = origFilename;

  video.filename = located;
  video.backend = await createVideoBackend(video.filename, {
    shape: video.shape ?? undefined,
  });
}

/**
 * Locate a missing image-sequence (ImageVideo) by pointing it at a user-picked
 * folder. Re-resolves each stored frame under `folder` (positions preserved),
 * rewrites `video.filename`, and rebuilds the backend. Tauri-only — the browser
 * injects no image reader. Returns true if at least one frame resolved AND the
 * backend built.
 */
export async function resolveImageSequenceVideo(
  video: Video,
  folder: string,
  exists: (path: string) => Promise<boolean>
): Promise<boolean> {
  const frames = Array.isArray(video.filename)
    ? video.filename
    : [video.filename];

  const { located, missing } = await resolveImageFramesInFolder(
    frames,
    folder,
    exists
  );

  if (missing.length === frames.length) {
    toast.error("No matching images found in that folder", {
      description: `None of the ${frames.length} image file name(s) were found in ${folder}.`,
    });
    return false;
  }

  try {
    await applyImageSequenceLocation(video, located);
  } catch (err) {
    console.error(`[video] ImageVideo locate failed for "${folder}":`, err);
    toast.error("Could not open the image sequence", {
      description: err instanceof Error ? err.message : String(err),
    });
    return false;
  }

  if (missing.length > 0) {
    toast.warning(
      `${missing.length} of ${frames.length} image${frames.length > 1 ? "s" : ""} not found`,
      { description: "Those frames will be blank." }
    );
  } else {
    toast.success(
      `Located ${frames.length} image${frames.length > 1 ? "s" : ""}`
    );
  }
  return true;
}

/**
 * Auto-locate a missing image-sequence at load time by grafting its (often
 * relative) frame paths onto the project directory AND its ancestors — the
 * image-sequence analogue of the single-file candidate walk in
 * {@link getVideoPathCandidates}. A cheap FIRST-frame probe picks the directory
 * before the full per-frame existence pass, so directories that don't hold the
 * media cost one probe, not one per frame. Silent (no toasts). Tauri-only.
 * Returns true if the backend built. On failure the video is left for the
 * manual "Locate folder" flow.
 */
async function autoLocateImageSequence(
  video: Video,
  projectPath: string,
  exists: (path: string) => Promise<boolean>
): Promise<boolean> {
  const frames = Array.isArray(video.filename)
    ? video.filename
    : [video.filename];
  if (frames.length === 0 || !frames[0]) return false;

  const sep = projectPath.includes("\\") ? "\\" : "/";
  let dir = projectPath.substring(0, projectPath.lastIndexOf(sep));

  for (let i = 0; i <= MAX_ANCESTOR_WALK && dir; i++) {
    const probe = await resolveImageFramesInFolder([frames[0]], dir, exists);
    if (probe.missing.length === 0) {
      const { located } = await resolveImageFramesInFolder(frames, dir, exists);
      try {
        await applyImageSequenceLocation(video, located);
        return true;
      } catch (err) {
        console.error(`[video] ImageVideo auto-locate failed under "${dir}":`, err);
        return false;
      }
    }
    const cut = dir.lastIndexOf(sep);
    if (cut <= 0) break;
    dir = dir.substring(0, cut);
  }
  return false;
}

/** Check if a filename looks like a fetchable URL. */
export function isFetchableUrl(filename: string | string[]): boolean {
  const f = Array.isArray(filename) ? filename[0] ?? "" : filename;
  return /^(https?:|blob:|data:)/i.test(f);
}

/** Check if a video is missing its backend (unresolved external file). */
export function isVideoMissing(video: Video): boolean {
  if (video.hasEmbeddedImages) return false;
  // Lazily resolved: file located, decoder deferred until first view. Present.
  if (typeof getLazyPath(video) === "string") return false;
  return video.backend === null && !isFetchableUrl(video.filename);
}

/** The resolved-but-not-yet-opened path for a lazily deferred video, if any. */
function getLazyPath(video: Video): string | undefined {
  const meta = video.backendMetadata as Record<string, unknown> | undefined;
  const p = meta?.lazyPath;
  return typeof p === "string" ? p : undefined;
}

/**
 * Open a lazily-deferred video's backend on first use. When
 * {@link resolveExternalVideos} runs with `lazy`, it records the resolved path
 * in `backendMetadata.lazyPath` without opening the file; this opens the decoder
 * on demand (the LUC3D pattern). No-op if already open or not deferred. Clears
 * `lazyPath` after the attempt (success or failure), so a video that fails to
 * decode falls through to the normal missing/unsupported flow.
 *
 * Opens via {@link assignVideoBackendFromPath} — a byte-range (RangeSource)
 * open, NOT a whole-file read — so deferring a multi-GB external video and then
 * viewing it doesn't pull the entire file into the WebView renderer (which OOMs
 * and crashes it). This mirrors the manual-locate path; only the timing differs.
 * (Before this, the first-view open read the whole file via `readFile`, which
 * re-introduced for the lazy path the exact OOM the range reader (#200) fixed
 * for the eager/locate paths — the lazy feature (#195) landed minutes later and
 * opened the old whole-file way.)
 */
export async function ensureVideoBackend(video: Video): Promise<boolean> {
  const lazyPath = getLazyPath(video);
  if (video.backend || !lazyPath) return video.backend !== null;
  try {
    return await assignVideoBackendFromPath(video, lazyPath, { silent: true });
  } finally {
    delete (video.backendMetadata as Record<string, unknown>).lazyPath;
  }
}

/**
 * Why a video has no usable backend, for actionable messaging:
 * - "unsupported-codec": the file was found and read, but its codec can't be
 *   decoded here (e.g. 10-bit HEVC, which WebCodecs rejects in the browser and
 *   the Linux WebView). The fix is to transcode, not to relocate.
 * - "missing": the file couldn't be located.
 * Returns null when the video is fine (has a backend), is an image sequence
 * awaiting a folder, or is a fetchable URL.
 */
export type VideoIssue = "missing" | "unsupported-codec" | null;
export function videoIssue(video: Video): VideoIssue {
  if (!isVideoMissing(video)) return null;
  const kind = video.backendError?.kind;
  if (kind === "decode" || kind === "unsupported-format") {
    return "unsupported-codec";
  }
  return "missing";
}

/**
 * Classify a thrown backend-open error into a structured {@link VideoBackendError}
 * so the UI can show WHY a video failed rather than a blanket "not found".
 * sleap-io.js throws `UnsupportedVideoFormatError` for whole-container formats it
 * can't read (AVI / MPEG-PS) and "Codec <x> not supported" / decode errors for
 * unplayable codecs. We only call this after a file was located and read, so an
 * open failure here is a codec/decode problem (not a missing file) — hence the
 * default codec kind. Pure + decoder-independent (unit-tested).
 */
export function classifyVideoError(err: unknown): VideoBackendError {
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "";
  if (name === "UnsupportedVideoFormatError") {
    return { kind: "unsupported-format", message };
  }
  return { kind: "decode", message };
}

/**
 * Whether a video is an image-sequence (ImageVideo): a list of image paths, or a
 * single image-extension filename, or one the loader flagged as such. These are
 * decoded by sleap-io.js's ImageVideoBackend via the injected image reader
 * during loadSlp — they must NOT be auto-resolved into a single-file (mp4box)
 * backend, which would hang on a JPEG.
 */
export function isImageSequenceVideo(video: Video): boolean {
  if (video.backendError?.kind === "image-sequence") return true;
  if (Array.isArray(video.filename)) return true;
  const first = Array.isArray(video.filename)
    ? video.filename[0] ?? ""
    : video.filename;
  return /\.(png|jpe?g|tiff?|bmp)$/i.test(first);
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
 * How far up the .slp's parent chain we graft a relative video path before
 * giving up (see candidate 2 below). Bounds the worst-case number of `exists`
 * probes per genuinely-missing video; 8 comfortably covers realistic project
 * nesting while staying cheap on slow mounts.
 */
const MAX_ANCESTOR_WALK = 8;

/**
 * Generate candidate absolute paths for a video file, given the project path.
 * Returns paths to try in priority order:
 * 1. The raw filename if it's already absolute.
 * 2. The relative path grafted onto the project directory AND each of its
 *    ancestors, closest-first (see #188).
 * 3. The basename resolved against the project directory (for moved projects).
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
  const add = (p: string) => {
    if (p && !candidates.includes(p)) candidates.push(p);
  };

  // 1. If absolute, try as-is, then graft its trailing tails onto the project
  //    dir — a cross-machine absolute path (e.g. a Linux `/home/...` path on a
  //    Windows mount) whose file now lives in a subfolder beside the `.slp`.
  //    The full foreign path is never reproduced (tailGraftCandidates stops one
  //    segment short), so the old "never graft an absolute onto the .slp dir"
  //    contract is only relaxed for genuine trailing-subpath matches.
  if (isAbsolute) {
    add(raw);
    for (const c of tailGraftCandidates(raw, projectDir, {
      maxDepth: MAX_ANCESTOR_WALK,
    })) {
      add(c);
    }
  } else {
    // 2. Graft the relative path onto the .slp's directory AND each ancestor,
    //    closest-first. SLEAP stores video paths relative to the directory the
    //    project was saved from — often an ANCESTOR of where the .slp ended up
    //    (e.g. the .slp sits in tests/data/slp_hdf5/ but the video path is
    //    tests/data/json_format_v1/clip.mp4, relative to the repo root three
    //    levels up). Grafting only onto the .slp dir — the old behavior, now
    //    the i=0 iteration — produced a doubled, always-missing path; walking
    //    ancestors reaches the real file. Mirrors SLEAP-python's on-load
    //    resolution intent (#188).
    const relative = raw.replace(/[\\/]/g, sep);
    let dir = projectDir;
    for (let i = 0; i <= MAX_ANCESTOR_WALK; i++) {
      add(dir + sep + relative);
      const cut = dir.lastIndexOf(sep);
      if (cut <= 0) break; // reached the filesystem root
      dir = dir.substring(0, cut);
    }
  }

  // 3. Basename only, in the project dir (for moved/reorganized projects).
  add(projectDir + sep + baseName);

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
  /**
   * Defer opening each external video's backend. When true, resolution only
   * *locates* the file (an `exists()` check) and records the resolved path in
   * `backendMetadata.lazyPath`; the file is NOT read and no decoder is built.
   * The backend is opened on first view via {@link ensureVideoBackend}. This
   * turns load from O(N videos read+decoded) into O(1) — you view one at a time.
   * Dimensions/frame-count come from the `.slp` metadata (`video.shape`), so the
   * Videos panel is unaffected. Default false (open everything eagerly).
   */
  lazy?: boolean;
}

/**
 * After loadSlp() returns, detect videos with no backend (external MP4s that
 * couldn't be resolved) and attempt auto-resolution.
 *
 * In Tauri mode (when options are provided), tries to resolve each single-file
 * video's path relative to the project directory, reads the file via the FS
 * plugin, and creates a backend from the bytes. Falls back to showing a toast
 * for any videos that can't be auto-resolved.
 *
 * Image sequences (ImageVideo) are NOT handled here: the SLP reader resolves and
 * opens them itself via the injected FsResolver (issue #213 / sleap-io.js#216),
 * so a resolvable sequence already carries a working backend and an unresolvable
 * one already carries backend === null + backendError.kind === "image-sequence".
 * This function only skips them (never routes a frame list into the single-file
 * path) and leaves the missing ones for the Locate-folder flow.
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
      } catch (err) {
        console.log(
          `[video] Backend failed for "${Array.isArray(video.filename) ? video.filename[0] : video.filename}", clearing for re-resolution`
        );
        video.backend = null;
        video.backendError = classifyVideoError(err);
      }
    })
  );

  const unresolvedVideos = labels.videos.filter(isVideoMissing);
  if (unresolvedVideos.length === 0) return;

  let resolvedCount = 0;

  // Try auto-resolution if we have filesystem access and a project path
  if (options) {
    // Remembered prefix swaps (e.g. /root/vast → /Volumes/talmo) learned from a
    // past manual locate. Reapplying them here reaches SIBLING subtrees that the
    // tail-graft candidates below can't (they only graft onto the .slp's own
    // dir + ancestors). Each swapped path is still gated by exists() in the
    // candidate loop, so a stale/coincidental mapping never adopts a wrong file.
    const savedSwaps = useAppStore.getState().videoPrefixSwaps;
    for (const video of unresolvedVideos) {
      // Image sequences (ImageVideo) never go through the single-file (mp4box)
      // path below (it would hang on a JPEG). The SLP reader's FsResolver opens
      // resolvable ones during loadSlp, but it does NOT graft RELATIVE frame
      // paths onto the .slp directory — so a sequence whose frames sit beside
      // the .slp (e.g. `frames/001.png` → `<slp_dir>/frames/001.png`) arrives
      // here missing. Auto-locate those against the project dir + ancestors,
      // the same walk single-file videos get (#215); leave the rest for the
      // manual "Locate folder" flow.
      if (isImageSequenceVideo(video)) {
        if (await autoLocateImageSequence(video, options.projectPath, options.exists)) {
          resolvedCount++;
        }
        continue;
      }
      // Persisted-swap candidates first (they can reach sibling subtrees),
      // then the tail-graft candidates. Dedupe, preserving order.
      const stored = Array.isArray(video.filename)
        ? video.filename[0] ?? ""
        : video.filename;
      const swapCandidates = savedSwaps
        .map((s) => applyPrefixSwap(stored, s.oldPrefix, s.newPrefix))
        .filter((p): p is string => p !== null);
      const raw = [
        ...swapCandidates,
        ...getVideoPathCandidates(video, options.projectPath),
      ];
      const candidates = raw.filter((p, i) => p !== "" && raw.indexOf(p) === i);
      console.log(
        `[video] Resolving "${Array.isArray(video.filename) ? video.filename[0] : video.filename}", candidates:`,
        candidates
      );
      for (const candidatePath of candidates) {
        try {
          const found = await options.exists(candidatePath);
          if (found) {
            console.log(`[video] Found at: ${candidatePath}`);
            // Preserve the original SLP path before rewriting video.filename.
            const origFilename = Array.isArray(video.filename)
              ? video.filename[0] ?? ""
              : video.filename;
            const meta = video.backendMetadata as Record<string, unknown>;
            if (options.lazy) {
              // #195 fast-open: file located — record the path and defer the
              // read + decode to first view (ensureVideoBackend). No I/O here.
              if (origFilename !== candidatePath) meta.sourceFilename = origFilename;
              meta.lazyPath = candidatePath;
              video.filename = candidatePath;
              resolvedCount++;
              break;
            }
            // Eager path: byte-range open, no whole-file read (#200).
            const ok = await assignVideoBackendFromPath(video, candidatePath, {
              silent: true,
            });
            if (ok) {
              if (origFilename !== candidatePath) {
                meta.sourceFilename = origFilename;
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

  // Summarize remaining unusable videos, split by reason so the message is
  // actionable: files we genuinely couldn't locate vs. files that WERE found but
  // use a codec we can't decode (e.g. 10-bit HEVC). Lumping both as "not found"
  // sent users hunting for files that are actually present.
  const stillMissing = labels.videos.filter(isVideoMissing);
  const unsupported = stillMissing.filter(
    (v) => videoIssue(v) === "unsupported-codec"
  );
  const notFound = stillMissing.filter((v) => videoIssue(v) === "missing");
  if (notFound.length > 0) {
    const n = notFound.length;
    toast.info(
      `${n} video${n > 1 ? "s" : ""} not found. Use the Videos panel to locate them.`,
      {
        description:
          "Annotations will be visible but video frames will be blank.",
      }
    );
  }
  if (unsupported.length > 0) {
    const n = unsupported.length;
    toast.error(`${n} video${n > 1 ? "s" : ""} use an unsupported codec`, {
      description:
        "Can't be decoded here (e.g. 10-bit HEVC). Transcode to H.264: " +
        "ffmpeg -i in.mp4 -c:v libx264 -pix_fmt yuv420p out.mp4",
    });
  }

  if (resolvedCount > 0) {
    toast.success(
      `Auto-resolved ${resolvedCount} video${resolvedCount > 1 ? "s" : ""}`
    );
  }
}

/**
 * Given a video path as originally stored (`oldPath`) and the absolute path the
 * user just located it at (`newPath`), derive the leading-prefix substitution
 * that maps one to the other: the longest common trailing run of path segments
 * is the unchanged tail, and the differing heads are `oldPrefix` → `newPrefix`.
 *
 * Port of SLEAP-python's `find_changed_subpath` (`sleap/io/pathutils.py`): once
 * one moved video is located, the same head swap usually relocates its siblings.
 * `oldPrefix` is `""` when the stored path was fully relative (the whole path is
 * the common tail) — i.e. "prepend `newPrefix` to the relative siblings".
 *
 * Returns null when the basenames don't line up (user picked an unrelated file —
 * don't propagate) or the swap is a no-op. Separator-insensitive (compares on
 * `/`). Exported for unit testing.
 */
export function computePrefixSwap(
  oldPath: string,
  newPath: string
): { oldPrefix: string; newPrefix: string } | null {
  const oldParts = oldPath.replace(/\\/g, "/").split("/");
  const newParts = newPath.replace(/\\/g, "/").split("/");

  let common = 0;
  let oi = oldParts.length - 1;
  let ni = newParts.length - 1;
  while (oi >= 0 && ni >= 0 && oldParts[oi] === newParts[ni]) {
    common++;
    oi--;
    ni--;
  }

  // Basenames must match: otherwise the user located a differently-named file
  // (a rename), which shouldn't relocate siblings.
  if (common === 0) return null;

  const oldPrefix = oldParts.slice(0, oldParts.length - common).join("/");
  const newPrefix = newParts.slice(0, newParts.length - common).join("/");

  // No-op swap (paths already agree up to the shared tail).
  if (oldPrefix === newPrefix) return null;

  return { oldPrefix, newPrefix };
}

/** Minimal filesystem surface needed to relocate-and-verify a sibling video. */
interface FsProbe {
  exists: (path: string) => Promise<boolean>;
  readFile: (path: string) => Promise<Uint8Array>;
}

/**
 * After one missing video is located, relocate the OTHER missing videos by
 * applying the same `oldPrefix` → `newPrefix` head swap, adopting a result only
 * if the file actually exists AND its backend opens. Tauri-only (needs real
 * filesystem access). Returns the number of siblings resolved.
 *
 * Port of SLEAP-python's `filenames_prefix_change` — the existence check is the
 * safety net that keeps a coincidental basename match from adopting a wrong file.
 */
async function propagatePrefixSwap(
  labels: Labels,
  located: Video,
  oldPrefix: string,
  newPrefix: string,
  fs: FsProbe
): Promise<number> {
  let count = 0;
  for (const video of labels.videos) {
    if (video === located) continue;
    if (!isVideoMissing(video)) continue;
    // Image sequences are lists of frames, not a single-file head swap.
    if (isImageSequenceVideo(video)) continue;

    const stored = Array.isArray(video.filename)
      ? video.filename[0] ?? ""
      : video.filename;

    // Boundary-safe head swap (shared with the reapply-on-open path).
    const candidate = applyPrefixSwap(stored, oldPrefix, newPrefix);
    if (!candidate) continue;
    try {
      if (!(await fs.exists(candidate))) continue;
      const ok = await assignVideoBackendFromPath(video, candidate, {
        silent: true,
      });
      if (ok) {
        const orig = Array.isArray(video.filename)
          ? video.filename[0] ?? ""
          : video.filename;
        if (orig !== candidate) {
          (video.backendMetadata as Record<string, unknown>).sourceFilename =
            orig;
        }
        video.filename = candidate;
        count++;
      }
    } catch (err) {
      console.warn(`[video] prefix-swap relocate failed for "${candidate}":`, err);
    }
  }
  return count;
}

/**
 * Open a file picker for a single video and assign its backend.
 * Returns true if a video was successfully loaded.
 *
 * When `labels` is provided and we resolve a real path (Tauri), the same path
 * change is propagated to the other missing videos (#188) — locate one moved
 * video and its siblings under the same moved root come back too.
 */
export async function resolveVideoFile(
  video: Video,
  labels?: Labels
): Promise<boolean> {
  const platform = await getPlatform();
  console.log(`[video] Picking video file via ${platform.isTauri ? "Tauri" : "browser"} dialog`);

  const result = await platform.showOpenDialog({
    filters: [
      { name: "Video files", extensions: [...SUPPORTED_VIDEO_EXTS] },
    ],
  });

  if (!result) return false;

  if (typeof result === "string") {
    // Tauri: got a file path — open it lazily by byte range (no whole-file read,
    // so a multi-GB video doesn't freeze/crash the WebView).
    console.log(`[video] Loading video from path: ${result}`);
    const oldFilename = Array.isArray(video.filename)
      ? video.filename[0] ?? ""
      : video.filename;
    try {
      const name = getBasename(result);
      const ok = await assignVideoBackendFromPath(video, result);
      if (!ok) return false; // assignVideoBackendFromPath already surfaced the reason
      // Update the video's filename to the resolved absolute path
      video.filename = result;
      toast.success(`Loaded video: ${name}`);

      // Propagate the same move to the other missing videos (#188).
      if (labels) {
        const swap = computePrefixSwap(oldFilename, result);
        if (swap) {
          // Remember the swap globally so future opens of OTHER projects from
          // the same relocated root auto-resolve without re-locating. Safe: it's
          // only ever adopted when the remapped file exists (superset of PyQt).
          useAppStore.getState().addVideoPrefixSwap(swap);
          const n = await propagatePrefixSwap(
            labels,
            video,
            swap.oldPrefix,
            swap.newPrefix,
            platform
          );
          if (n > 0) {
            toast.success(
              `Located ${n} more video${n > 1 ? "s" : ""} by the same path change`
            );
          }
        }
      }
      return true;
    } catch (err) {
      console.error(`[video] Failed to read video file "${result}":`, err);
      return false;
    }
  } else if (result instanceof File) {
    // Browser: got a File object
    console.log(`[video] Loading video from File object: ${result.name} (${result.size} bytes)`);
    const ok = await assignVideoBackend(video, result);
    if (!ok) return false;
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
    { name: "Video files", extensions: [...SUPPORTED_VIDEO_EXTS] },
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
      if (match.path) {
        // Tauri: lazy byte-range open by path (no whole-file read).
        await assignVideoBackendFromPath(video, match.path);
        video.filename = match.path;
      } else {
        await assignVideoBackend(video, await match.getFile());
      }
      matchCount++;
    }
  }

  // Special case: 1 unresolved video + 1 picked file -> assign even if names don't match
  if (
    matchCount === 0 &&
    unresolvedVideos.length === 1 &&
    picked.length === 1
  ) {
    const only = picked[0];
    if (only.path) {
      await assignVideoBackendFromPath(unresolvedVideos[0], only.path);
      unresolvedVideos[0].filename = only.path;
    } else {
      await assignVideoBackend(unresolvedVideos[0], await only.getFile());
    }
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

/** Minimal structural shapes so the folder scan works with real
 *  File System Access handles AND plain mock objects in unit tests. */
interface FsEntryLike {
  kind: string;
}
interface FsDirLike extends FsEntryLike {
  entries(): AsyncIterableIterator<[string, FsEntryLike]>;
}

/** How deep to recurse / how many entries to visit when scanning a picked
 *  folder for missing videos — bounds the cost on a large / network mount. */
const MAX_VIDEO_SCAN_DEPTH = 8;
const MAX_VIDEO_SCAN_ENTRIES = 20000;

/**
 * Recursively scan a picked directory for files whose lowercased basename is in
 * `wantedKeys`, returning the first handle found per key. Bounded by depth and a
 * total-entry budget (network-mount safety) and early-exits once every wanted
 * key is found. Decoupled from the real File System Access API (structural
 * `FsDirLike`) so the walk is unit-testable with a mock tree.
 */
export async function collectHandlesByBasename(
  dir: FsDirLike,
  wantedKeys: Set<string>,
  opts?: { maxDepth?: number; maxEntries?: number }
): Promise<Map<string, FsEntryLike>> {
  const found = new Map<string, FsEntryLike>();
  const maxDepth = opts?.maxDepth ?? MAX_VIDEO_SCAN_DEPTH;
  const maxEntries = opts?.maxEntries ?? MAX_VIDEO_SCAN_ENTRIES;
  let visited = 0;

  const walk = async (d: FsDirLike, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    for await (const [name, handle] of d.entries()) {
      if (found.size >= wantedKeys.size) return; // every key matched — stop
      if (++visited > maxEntries) return; // budget exhausted (mount safety)
      if (handle.kind === "file") {
        const key = name.toLowerCase();
        if (wantedKeys.has(key) && !found.has(key)) found.set(key, handle);
      } else if (handle.kind === "directory") {
        await walk(handle as FsDirLike, depth + 1);
      }
    }
  };

  await walk(dir, 0);
  return found;
}

/**
 * Locate all missing (regular, single-file) videos from ONE user-picked folder:
 * recursively match each missing video by basename under the folder and open its
 * backend. The browser-convenience analogue of the desktop's auto-resolve — pick
 * the folder once instead of each file. Chromium only (needs
 * `showDirectoryPicker`); elsewhere / on Tauri it falls back to the multi-file
 * picker ({@link resolveAllVideoFiles}). Session-only: opens the decoder from the
 * picked File but does NOT rewrite `video.filename` (a browser File exposes no
 * absolute path to persist). An EXPLICIT action only — never auto-run on load
 * (embedded pkg.slp / ImageVideo projects have nothing to locate). Returns the
 * number of videos resolved.
 */
export async function resolveAllVideosFromFolder(
  videos: Video[]
): Promise<number> {
  const missing = videos.filter(
    (v) => isVideoMissing(v) && !isImageSequenceVideo(v)
  );
  if (missing.length === 0) {
    toast.info("No missing videos to locate.");
    return 0;
  }

  const platform = await getPlatform();
  if (
    platform.isTauri ||
    typeof window === "undefined" ||
    !("showDirectoryPicker" in window)
  ) {
    // No folder picker available — select the files directly instead.
    return resolveAllVideoFiles(videos);
  }

  let dirHandle: FsDirLike;
  try {
    dirHandle = await (
      window as unknown as {
        showDirectoryPicker: (o?: unknown) => Promise<FsDirLike>;
      }
    ).showDirectoryPicker({ id: "sleap-locate-videos", mode: "read" });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return 0;
    throw err;
  }

  // Each missing video's lowercased basename → the video(s) wanting that name.
  const wanted = new Map<string, Video[]>();
  for (const v of missing) {
    const key = getBasename(v.filename).toLowerCase();
    const list = wanted.get(key);
    if (list) list.push(v);
    else wanted.set(key, [v]);
  }

  const found = await collectHandlesByBasename(dirHandle, new Set(wanted.keys()));

  let count = 0;
  for (const [key, vids] of wanted) {
    const handle = found.get(key) as FileSystemFileHandle | undefined;
    if (!handle) continue;
    let file: File;
    try {
      file = await handle.getFile();
    } catch {
      continue;
    }
    for (const v of vids) {
      if (await assignVideoBackend(v, file, { silent: true })) count++;
    }
  }

  if (count > 0) {
    toast.success(
      `Located ${count} video${count > 1 ? "s" : ""} from the folder`
    );
  }
  const remaining = missing.length - count;
  if (remaining > 0) {
    toast.warning(
      `${remaining} video${remaining > 1 ? "s" : ""} not found in that folder`,
      { description: "Pick a folder that contains the missing video file(s)." }
    );
  }
  return count;
}

/**
 * Build the sleap-io.js backend for a user-picked file, dispatching by
 * extension: MP4 → Mp4Box, WebM/MKV/MOV/Ogg/MPEG-TS → MediaBunny, `.seq` → Seq.
 * Unknown / extension-less names fall back to Mp4Box (historical behavior for
 * SLP-referenced external videos with non-standard names).
 */
async function createBackendForFile(file: File): Promise<VideoBackend> {
  switch (backendKindForFilename(file.name)) {
    case "mediabunny":
      return MediaBunnyVideoBackend.fromBlob(file, file.name);
    case "seq":
      return SeqVideoBackend.create(file);
    case "mp4box":
    default:
      return new Mp4BoxVideoBackend(file);
  }
}

/**
 * A lazy on-disk byte source for a native video path (desktop/Tauri): reads
 * byte ranges via the native `read_range` command instead of materializing the
 * whole file. The video counterpart of the HDF5 range source the `.slp`
 * streaming reader uses.
 */
function makeVideoRangeSource(path: string): Promise<RangeSource> {
  return fileSize(path).then((size) => ({
    size,
    readRange: (offset: number, length: number) =>
      readRange(path, offset, length),
  }));
}

/**
 * Build a backend that reads a native video path lazily by byte range, so a
 * multi-GB external video is never read whole into memory (the desktop
 * freeze/crash). MP4 → Mp4Box, the MediaBunny formats → MediaBunny, both via a
 * {@link RangeSource}. `.seq` has no range backend and its files are small, so
 * it falls back to a full read.
 */
async function createBackendForPath(path: string): Promise<VideoBackend> {
  const name = getBasename(path);
  const kind = backendKindForFilename(name);
  if (kind === "mediabunny") {
    return MediaBunnyVideoBackend.fromRangeSource(
      await makeVideoRangeSource(path),
      name
    );
  }
  if (kind === "seq") {
    const platform = await getPlatform();
    return SeqVideoBackend.create(
      new File([await platform.readFile(path)], name)
    );
  }
  // mp4box + unknown/extension-less names (historical mp4box default).
  return new Mp4BoxVideoBackend(await makeVideoRangeSource(path), {
    filename: name,
  });
}

/**
 * Attach a freshly-built backend to a Video, probing frame 0 to validate decode
 * and capture shape/fps. Shared by the File and native-path entry points.
 *
 * The frame-0 probe also guards SeqVideoBackend, which sets `shape` from the
 * header at create(): without a decode check a `.seq` with an undecodable codec
 * (e.g. Bayer) would pass buildStandaloneVideo's `!video.shape` guard as a
 * black, error-free video. A failed probe nulls the backend and records WHY (so
 * the UI shows "unsupported codec" vs "not found") rather than leaving a
 * half-open backend that isVideoMissing would miscount as resolved.
 */
async function probeAndAssignBackend(
  video: Video,
  create: () => Promise<VideoBackend>,
  name: string,
  opts?: { silent?: boolean }
): Promise<boolean> {
  try {
    const backend = await create();
    video.backend = backend;
    const frame = await backend.getFrame(0);
    if (!frame) {
      throw new Error("could not decode the first video frame");
    }
    if (backend.shape) video.shape = backend.shape;
    if (backend.fps) video.fps = backend.fps;
    video.backendError = null;
    console.log(
      `[video] Backend ready: ${video.shape?.[1]}x${video.shape?.[2]} @ ${video.fps}fps, ${video.shape?.[0]} frames`
    );
    return true;
  } catch (err) {
    console.error(`Failed to load video backend for ${name}:`, err);
    video.backend = null;
    video.backendError = classifyVideoError(err);
    if (!opts?.silent) {
      toast.error(`Failed to load video: ${name}`, {
        description: err instanceof Error ? err.message : String(err),
      });
    }
    return false;
  }
}

/**
 * Build the backend for a user-picked File and assign it (probing shape/fps).
 * Dispatches by extension (see {@link createBackendForFile}). Browser Files are
 * disk-backed, so slicing reads lazily — no whole-file copy needed here.
 */
export async function assignVideoBackend(
  video: Video,
  file: File,
  opts?: { silent?: boolean }
): Promise<boolean> {
  return probeAndAssignBackend(
    video,
    () => createBackendForFile(file),
    file.name,
    opts
  );
}

/**
 * Desktop counterpart of {@link assignVideoBackend}: build the backend from a
 * native file PATH via a lazy {@link RangeSource}, so opening a large external
 * video reads only the container index + the viewed frames instead of the whole
 * file. Use this on every Tauri path where the alternative is `readFile(path)`.
 */
export async function assignVideoBackendFromPath(
  video: Video,
  path: string,
  opts?: { silent?: boolean }
): Promise<boolean> {
  return probeAndAssignBackend(
    video,
    () => createBackendForPath(path),
    getBasename(path),
    opts
  );
}

/**
 * Standalone-video file extensions we can decode, mapped to the sleap-io.js
 * backend that handles each. MP4 → Mp4Box; WebM/MKV/MOV/Ogg/MPEG-TS →
 * MediaBunny; Norpix `.seq` → SeqVideoBackend. `.avi` is intentionally absent
 * (no sleap-io.js backend decodes it).
 */
const BACKEND_BY_EXT = {
  mp4: "mp4box",
  webm: "mediabunny",
  mkv: "mediabunny",
  mov: "mediabunny",
  ogg: "mediabunny",
  ogv: "mediabunny",
  ts: "mediabunny",
  seq: "seq",
} as const satisfies Record<string, "mp4box" | "mediabunny" | "seq">;

type StandaloneBackendKind = (typeof BACKEND_BY_EXT)[keyof typeof BACKEND_BY_EXT];

/** Extensions accepted by the standalone-video add flow and the file pickers. */
export const SUPPORTED_VIDEO_EXTS: readonly string[] =
  Object.keys(BACKEND_BY_EXT);

/** Lowercased extension of a filename, or "" if none. */
function fileExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

/**
 * Which backend (if any) decodes a given filename, by extension. Returns null
 * for unsupported / extension-less names. Pure + decoder-independent — the unit
 * tests assert the full extension→backend table here; real decoding is covered
 * by manual E2E (WebCodecs/Mp4Box do not run under the bun test runner).
 */
export function backendKindForFilename(
  name: string
): StandaloneBackendKind | null {
  return (
    (BACKEND_BY_EXT as Record<string, StandaloneBackendKind>)[fileExt(name)] ??
    null
  );
}

/**
 * Build a new standalone Video from a user-picked file, dispatching by
 * extension via {@link assignVideoBackend} (which probes shape/fps). Supports
 * every {@link SUPPORTED_VIDEO_EXTS} format (MP4/WebM/MKV/MOV/Ogg/MPEG-TS/.seq);
 * unsupported formats (e.g. `.avi`) are rejected with a toast and return null.
 * Returns null on decode failure too (assignVideoBackend already surfaces the
 * error).
 */
export async function buildStandaloneVideo(file: File): Promise<Video | null> {
  if (!backendKindForFilename(file.name)) {
    const ext = fileExt(file.name);
    toast.error(`${ext ? `.${ext} files are` : "This file is"} not supported`, {
      description:
        "Supported video formats: MP4, WebM, MKV, MOV, Ogg, MPEG-TS, and Norpix .seq.",
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

/** A picked video file plus its absolute path (Tauri) or null (browser). */
export interface PickedVideoFile {
  file: File;
  /** Absolute path on Tauri (used as the canonical filename); null in browser. */
  absPath: string | null;
}

/**
 * Open a multi-select video file picker and return normalized File objects.
 * Browser yields File(s) directly; Tauri yields path(s), read into File via
 * platform.readFile. Accepts every format in {@link SUPPORTED_VIDEO_EXTS}
 * (MP4/WebM/MKV/MOV/Ogg/MPEG-TS/.seq).
 * Returns [] if the user cancels. Shared by the Videos panel
 * ({@link pickAndAddVideos}) and the New Project dialog (#138).
 */
export async function pickVideoFiles(): Promise<PickedVideoFile[]> {
  const platform = await getPlatform();
  const result = await platform.showOpenDialog({
    multiple: true,
    filters: [{ name: "Video files", extensions: [...SUPPORTED_VIDEO_EXTS] }],
  });
  if (!result) return []; // cancelled

  const picked = Array.isArray(result) ? result : [result];
  const files: PickedVideoFile[] = [];
  for (const item of picked) {
    if (typeof item === "string") {
      // Tauri: got a path — read bytes into a File (mirrors resolveVideoFile).
      try {
        const bytes = await platform.readFile(item);
        files.push({
          file: new File([bytes], getBasename(item), { type: "video/mp4" }),
          absPath: item,
        });
      } catch (err) {
        console.error(`[video] Failed to read "${item}":`, err);
        toast.error(`Failed to read ${getBasename(item)}`, {
          description: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      files.push({ file: item, absPath: null });
    }
  }
  return files;
}

/**
 * Build a standalone Video from a picked file and append it to labels (NO
 * reindex — callers batch a single labels.reindex() after adding all videos).
 * On Tauri, the absolute path becomes the canonical filename so the video
 * resolves on reload. Returns the Video, or null if unsupported/decode failed
 * (already toasted). Used by both the Videos panel and the New Project dialog.
 */
export async function addVideoFileToLabels(
  labels: Labels,
  picked: PickedVideoFile
): Promise<Video | null> {
  const video = await buildStandaloneVideo(picked.file);
  if (!video) return null;
  if (picked.absPath) video.filename = picked.absPath;
  labels.addVideo(video);
  return video;
}

/**
 * Open a file picker and add the chosen standalone video file(s) to the
 * project's labels. Returns the videos actually added (callers select the
 * first and refresh the UI). Unsupported/failed files are skipped (each
 * surfaces its own toast).
 *
 * NOTE: reindexes via labels.reindex() — the sleap-io.js .d.ts declares
 * Labels.update() but the shipped JS only implements reindex(), so update()
 * throws at runtime.
 */
export async function pickAndAddVideos(labels: Labels): Promise<Video[]> {
  const picked = await pickVideoFiles();
  const added: Video[] = [];
  for (const p of picked) {
    const video = await addVideoFileToLabels(labels, p);
    if (video) added.push(video);
  }
  if (added.length > 0) labels.reindex();
  return added;
}
