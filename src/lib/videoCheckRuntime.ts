/**
 * Browser/Tauri half of the video frame check (the pure logic is in
 * `videoCheck.ts`): which reader a video uses, the quick check against the
 * viewer's open backend, and the private {@link FrameReader} the full check
 * reads through. Not covered by unit tests (needs WebCodecs + the DOM); verify
 * in the app.
 */
import {
  AviVideoBackend,
  GrayscaleVideoBackend,
  MediaBunnyVideoBackend,
  Mp4BoxVideoBackend,
  SeqVideoBackend,
  WorkerMp4BoxBackend,
  isWorkerDecodeAvailable,
  type VideoBackend,
} from "@talmolab/sleap-io.js";
import type { Video } from "@/types";
import { frameToCanvas } from "@/lib/frameCanvas";
import {
  browserVideoFile,
  createBackendForFile,
  createPlainBackendForPath,
  getBasename,
  isFetchableUrl,
  isImageSequenceVideo,
  videoIssue,
} from "@/lib/resolveVideos";
import {
  buildBlobByteSourceDescriptor,
  buildTauriByteSourceDescriptor,
  runWorkerDecodeUpgrade,
} from "@/lib/workerDecodeUpgrade";
import { shouldPrefetch } from "@/lib/videoPrefetch";
import { isTauri } from "@/platform/index";
import { createTauriTranscodeDeps } from "@/lib/transcode/transcodeDepsTauri";
import {
  nativeDecodeArgs,
  quickCheck,
  type FrameReader,
  type NativeDecodeResult,
  type QuickCheckResult,
  type ReaderKind,
} from "@/lib/videoCheck";

/** The backend underneath any grayscale wrapper. */
function unwrap(backend: VideoBackend): VideoBackend {
  return backend instanceof GrayscaleVideoBackend ? backend.inner : backend;
}

/** Which reader the viewer decodes `video` with (null when it isn't open). */
export function readerKindOf(video: Video): ReaderKind | null {
  if (video.hasEmbeddedImages || isImageSequenceVideo(video)) return "images";
  if (!video.backend) return null;
  const b = unwrap(video.backend);
  if (b instanceof Mp4BoxVideoBackend || b instanceof WorkerMp4BoxBackend) return "mp4box";
  if (b instanceof MediaBunnyVideoBackend) return "mediabunny";
  if (b instanceof AviVideoBackend) return "avi";
  if (b instanceof SeqVideoBackend) return "seq";
  return "other";
}

/** Quick check of an open video. Null when it isn't open yet. */
export async function quickCheckVideo(video: Video): Promise<QuickCheckResult | null> {
  const kind = readerKindOf(video);
  if (!kind) return null;
  let frameTimes: number[] | null = null;
  if (kind !== "images" && kind !== "seq" && video.backend) {
    try {
      frameTimes = (await unwrap(video.backend).getFrameTimes?.()) ?? null;
    } catch {
      frameTimes = null;
    }
  }
  return quickCheck({ kind, frameTimes });
}

/**
 * Why this video has nothing to check or re-encode, or null. Embedded and
 * image-sequence frames are separate images (nothing to seek); a URL would mean
 * streaming the whole video, and there is no local file to re-encode.
 */
function notAVideoFile(video: Video): string | null {
  if (video.hasEmbeddedImages || isImageSequenceVideo(video)) {
    return "Frames are stored as separate images, so there is nothing to check.";
  }
  if (isFetchableUrl(video.filename)) {
    return "Frame check isn't available for videos streamed from a URL.";
  }
  return null;
}

/** Why a full check can't run on this video, or null when it can. */
export function frameCheckUnavailable(video: Video): string | null {
  const notFile = notAVideoFile(video);
  if (notFile) return notFile;
  if (videoIssue(video) === "unsupported-codec") {
    return "This video can't be opened here, so its frames can't be checked.";
  }
  if (!video.backend) return "Open the video first.";
  if (!isTauri && !browserVideoFile(video)) {
    return "Reopen this video's file to check it.";
  }
  return null;
}

/**
 * Why this video can't be re-encoded here, or null when it can. Desktop
 * re-encodes with ffmpeg, which reads codecs the app can't open; the browser
 * re-encodes through the app's own reader, so it needs a video the app opened.
 */
export function reencodeUnavailable(video: Video): string | null {
  const notFile = notAVideoFile(video);
  if (notFile) return notFile;
  const issue = videoIssue(video);
  if (issue === "missing") return "The video file can't be found.";
  if (isTauri) return null;
  if (issue === "unsupported-codec") return "This browser can't read this video.";
  if (!browserVideoFile(video)) return "Reopen this video's file to re-encode it.";
  return null;
}

/** The file path (desktop) or name (browser) a video was opened from. */
function videoPath(video: Video): string {
  return Array.isArray(video.filename) ? video.filename[0] : video.filename;
}

/**
 * Move an MP4 reader's decoding into a Web Worker, as the viewer and Export
 * Labels Package do (`runWorkerDecodeUpgrade`): a check or re-encode reads
 * every frame, which on the UI thread freezes the window. The worker decoder
 * also recovers from a decode error, where the UI-thread one stays broken. Any
 * other reader, or a worker that can't start, is returned as it is.
 */
async function decodeOffMain(video: Video, backend: VideoBackend): Promise<VideoBackend> {
  let current = backend;
  const path = videoPath(video);
  const file = browserVideoFile(video);
  await runWorkerDecodeUpgrade(backend, path, getBasename(path), {
    isAvailable: isWorkerDecodeAvailable,
    buildDescriptor: async (p) =>
      isTauri
        ? buildTauriByteSourceDescriptor(p)
        : file
          ? buildBlobByteSourceDescriptor(file)
          : null,
    createWorkerBackend: (params) => WorkerMp4BoxBackend.create(params),
    isStillActive: () => true,
    currentBackend: () => current,
    swap: (b) => {
      current = b;
    },
    triggerReread: () => {},
  });
  return current;
}

/**
 * Frames decoded per batch when reads go in order, for a reader that only
 * batch-decodes on request (MediaBunny). Matches the MP4 reader's own lookahead,
 * and stays under its 120-frame cache so a batch isn't evicted before it's read.
 */
const READ_AHEAD_FRAMES = 60;

/** A reader of a video's file that shares nothing with the viewer. */
export interface PrivateReader {
  backend: VideoBackend;
  /** True for the UI-thread MP4 decoder, which stays broken after a decode error. */
  stuckAfterError: boolean;
  /**
   * Read frame `index`. When reads go in order (the player's {@link shouldPrefetch}
   * rule), a MediaBunny reader decodes the next {@link READ_AHEAD_FRAMES} in one
   * pass instead of seeking from the keyframe for every frame (~14× faster).
   */
  getFrame(index: number): Promise<unknown>;
  close(): void;
}

/**
 * Open a reader of `video`'s file with its own decoder and frame cache (the
 * viewer's cache would hand back frames it already decoded) and the same reader
 * type the viewer uses, decoding off the UI thread where it can.
 */
export async function openPrivateReader(video: Video): Promise<PrivateReader> {
  let opened: VideoBackend;
  if (isTauri) {
    opened = await createPlainBackendForPath(videoPath(video));
  } else {
    const file = browserVideoFile(video);
    if (!file) throw new Error("Reopen this video's file to check it.");
    opened = await createBackendForFile(file);
  }
  // Mp4Box parses the file in the background; shape is set once it's ready.
  await (opened as { ready?: Promise<void> }).ready;
  const backend = await decodeOffMain(video, opened);
  const inner = unwrap(backend);
  const frameCount = (backend.shape ?? video.shape)?.[0] ?? 0;

  let last: number | null = null;
  let batchedTo = -1;
  return {
    backend,
    stuckAfterError: inner instanceof Mp4BoxVideoBackend,
    async getFrame(index) {
      const inOrder = shouldPrefetch({ prev: last, next: index, isScrubbing: false });
      last = index;
      if (inOrder && inner instanceof MediaBunnyVideoBackend && index > batchedTo) {
        batchedTo = Math.min(index + READ_AHEAD_FRAMES, frameCount) - 1;
        await inner.prefetch(index, batchedTo);
      }
      // Pinned: every frame must come back, never superseded by a newer read.
      return backend.getFrame(index, { pinned: true });
    },
    close() {
      backend.close();
    },
  };
}

/** Hex SHA-1 of a canvas's pixels: equal only for identical images. */
async function fingerprintCanvas(canvas: OffscreenCanvas): Promise<string> {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("No 2D context");
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const digest = await crypto.subtle.digest("SHA-1", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A {@link FrameReader} over a fresh {@link PrivateReader} of `video`. */
export async function openFrameReader(video: Video): Promise<FrameReader> {
  const reader = await openPrivateReader(video);
  const shape = reader.backend.shape ?? video.shape;
  const frameCount = shape?.[0] ?? 0;
  if (!frameCount) {
    reader.close();
    throw new Error("Couldn't read how many frames this video has.");
  }
  return {
    frameCount,
    stuckAfterError: reader.stuckAfterError,
    async read(index, fingerprint) {
      const frame = await reader.getFrame(index);
      if (!frame) return { ok: false };
      if (!fingerprint) return { ok: true };
      const canvas = await frameToCanvas(frame, shape);
      if (!canvas) return { ok: false };
      return { ok: true, fingerprint: await fingerprintCanvas(canvas) };
    },
    close() {
      reader.close();
    },
  };
}

/**
 * Desktop: decode every frame of `video`'s file with the bundled ffmpeg, on all
 * cores, through the same sidecar runner the transcodes and Export Labels
 * Package use. ~20× faster than the app's reader on a 1024×1024 video. Whether
 * that settles the check is {@link nativeDecodeClears}'s call. An ffmpeg that
 * exits with an error counts as an error, so the check falls back to the app's
 * reader rather than failing.
 */
export async function decodeAllNative(
  video: Video,
  opts: { signal?: AbortSignal; onProgress?: (decoded: number) => void } = {}
): Promise<NativeDecodeResult> {
  const deps = createTauriTranscodeDeps();
  let decoded = 0;
  const errors: string[] = [];
  try {
    await deps.runTranscode(
      nativeDecodeArgs(videoPath(video)),
      (p) => {
        if (p.frame === undefined) return;
        decoded = p.frame;
        opts.onProgress?.(decoded);
      },
      opts.signal,
      (line) => errors.push(line)
    );
  } catch (err) {
    if (opts.signal?.aborted) throw new DOMException("Frame check canceled", "AbortError");
    errors.push(err instanceof Error ? err.message : String(err));
  }
  return { decoded, errors };
}

