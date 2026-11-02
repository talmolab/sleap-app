/**
 * Re-encode a video into a clean H.264 MP4 the app (and every other reader)
 * can seek exactly: constant frame rate, a keyframe every second, no B-frames,
 * frames in display order. The fix the frame check offers. Keyframe spacing and
 * the quality presets match sleap-io's `sio reencode` (see `videoCheck.ts`).
 *
 * - Desktop: the bundled ffmpeg sidecar, disk→disk, with the legacy transcode's
 *   frame-exact flags (`-fps_mode passthrough`) — native speed, nothing in the
 *   WebView heap, and none of WebKit's encoder color-range quirk.
 * - Browser: decode each frame with the app's own reader, in display (timestamp)
 *   order, and encode it with WebCodecs (mediabunny). Streams to a file picked
 *   with the File System Access API (Chromium); elsewhere the whole file is
 *   built in memory and downloaded.
 *
 * Lazy-loaded (mediabunny is large). Not covered by unit tests (needs ffmpeg or
 * WebCodecs); verify in the app.
 */
import {
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  StreamTarget,
  canEncodeVideo,
  type StreamTargetChunk,
} from "mediabunny";
import type { Video } from "@/types";
import { frameToCanvas } from "@/lib/frameCanvas";
import { clearFullRangeTag, isWebKitEncoder } from "@/lib/h264RangeTag";
import { buildTranscodeArgs } from "@/lib/transcode/transcodeArgs";
import { createTauriTranscodeDeps } from "@/lib/transcode/transcodeDepsTauri";
import { probeVideo, selectEncoder } from "@/lib/transcode/transcodeVideo";
import { videoBasename } from "@/lib/videoFilter";
import { openPrivateReader } from "@/lib/videoCheckRuntime";
import {
  REENCODE_KEYFRAME_SECONDS,
  displayOrder,
  keyframeGop,
  reencodeBitrate,
  reencodedPath,
  type ReencodeQuality,
} from "@/lib/videoCheck";

export interface ReencodeOptions {
  /** `sio reencode --quality` preset. Default "medium", as there. */
  quality?: ReencodeQuality;
  /** 0–100, or null while the total is unknown. */
  onProgress?: (percent: number | null) => void;
  signal?: AbortSignal;
}

/** Size to assume for the bitrate when a video's is unknown (it never opened here). */
const FALLBACK_SIZE = { width: 1920, height: 1080 };

function abortError(): DOMException {
  return new DOMException("Re-encode canceled", "AbortError");
}

/**
 * Desktop: re-encode `sourcePath` to `destPath` with the ffmpeg sidecar. Writes
 * a `.part` next to the destination and renames it into place, so a canceled
 * or failed run never leaves a half-written video under the final name.
 */
export async function reencodeWithFfmpeg(
  sourcePath: string,
  destPath: string,
  /** The video's frame rate and size, for the keyframe spacing and bitrate. */
  source: { fps?: number | null; width?: number; height?: number },
  opts: ReencodeOptions = {}
): Promise<void> {
  const deps = createTauriTranscodeDeps();
  const probed = await probeVideo(sourcePath, deps);
  const durationMs = probed?.durationMs;
  const tempPath = `${destPath}.part`;
  await deps.remove(tempPath);
  const args = buildTranscodeArgs({
    input: sourcePath,
    output: tempPath,
    encoder: await selectEncoder(deps),
    quality: [
      "-b:v",
      String(
        reencodeBitrate(
          opts.quality ?? "medium",
          source.width || FALLBACK_SIZE.width,
          source.height || FALLBACK_SIZE.height
        )
      ),
    ],
    gopSize: keyframeGop(source.fps),
    padToEven: true,
  });
  opts.onProgress?.(null);
  try {
    await deps.runTranscode(
      args,
      (p) => {
        if (durationMs && durationMs > 0 && p.outTimeMs !== undefined) {
          opts.onProgress?.(Math.min(100, (p.outTimeMs / durationMs) * 100));
        }
      },
      opts.signal
    );
    if (opts.signal?.aborted) throw abortError();
    await deps.rename(tempPath, destPath);
  } catch (err) {
    await deps.remove(tempPath);
    throw opts.signal?.aborted ? abortError() : err;
  }
}

/** Is a WebCodecs H.264 encoder available for a video this size? */
export async function canReencodeInBrowser(video: Video): Promise<boolean> {
  const [, h, w] = video.shape ?? [0, 0, 0];
  if (!w || !h) return false;
  try {
    return await canEncodeVideo("avc", {
      width: w + (w % 2),
      height: h + (h % 2),
      bitrate: QUALITY_HIGH,
    });
  } catch {
    return false;
  }
}

/** Minimal File System Access surface we use (not in every TS DOM lib). */
interface SaveHandle {
  createWritable(): Promise<WritableStream<StreamTargetChunk>>;
  getFile(): Promise<File>;
  remove?: () => Promise<void>;
}

/**
 * Browser: re-encode `video` frame by frame with WebCodecs. Asks where to save
 * (File System Access) when it can, else downloads the result. Resolves with
 * the new file, or null when the user cancels the save picker. `blankFrames`
 * counts frames that couldn't be decoded and were written black, keeping every
 * later frame at its number.
 */
export async function reencodeInBrowser(
  video: Video,
  opts: ReencodeOptions = {}
): Promise<{ file: File; blankFrames: number } | null> {
  const name = reencodedPath(videoBasename(video.filename));

  let handle: SaveHandle | null = null;
  const picker = (window as { showSaveFilePicker?: (o: unknown) => Promise<SaveHandle> })
    .showSaveFilePicker;
  if (picker) {
    try {
      handle = await picker({
        suggestedName: name,
        types: [{ description: "MP4 video", accept: { "video/mp4": [".mp4"] } }],
      });
    } catch {
      return null; // canceled
    }
  }

  const reader = await openPrivateReader(video);
  const { backend } = reader;
  try {
    const shape = backend.shape ?? video.shape;
    const [frameCount, h, w] = shape ?? [0, 0, 0];
    if (!frameCount || !w || !h) throw new Error("Couldn't read this video's size.");
    const fps = video.fps || backend.fps || 30;
    const order = displayOrder(frameCount, (await backend.getFrameTimes?.()) ?? null);

    // H.264 4:2:0 needs even dimensions: pad with a black row/column at the
    // right/bottom, so pixel coordinates (and labels) are unchanged.
    const canvas = new OffscreenCanvas(w + (w % 2), h + (h % 2));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not create a 2D canvas context.");

    const target = handle
      ? new StreamTarget(await handle.createWritable(), { chunked: true })
      : new BufferTarget();
    const source = new CanvasSource(canvas, {
      codec: "avc",
      bitrate: reencodeBitrate(opts.quality ?? "medium", canvas.width, canvas.height),
      keyFrameInterval: REENCODE_KEYFRAME_SECONDS,
    });
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target });
    output.addVideoTrack(source, { frameRate: fps });
    await output.start();

    let blankFrames = 0;
    try {
      for (let i = 0; i < frameCount; i++) {
        if (opts.signal?.aborted) throw abortError();
        const frame = await reader.getFrame(order[i]);
        const drawn = await frameToCanvas(frame, shape);
        ctx.fillStyle = "black";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (drawn) ctx.drawImage(drawn, 0, 0);
        else blankFrames++;
        await source.add(i / fps, 1 / fps);
        if (i % 10 === 0 || i === frameCount - 1) {
          opts.onProgress?.(((i + 1) / frameCount) * 100);
        }
      }
      await output.finalize();
    } catch (err) {
      await output.cancel().catch(() => {});
      await handle?.remove?.().catch(() => {});
      throw err;
    }

    if (handle) return { file: await handle.getFile(), blankFrames };

    let bytes = new Uint8Array((target as BufferTarget).buffer ?? new ArrayBuffer(0));
    // WebKit's encoder tags its limited-range output full range, so every
    // reader decodes it washed out; fix the tag (see h264RangeTag.ts).
    if (isWebKitEncoder(navigator.userAgent)) bytes = clearFullRangeTag(bytes) ?? bytes;
    const file = new File([bytes], name, { type: "video/mp4" });
    downloadFile(file);
    return { file, blankFrames };
  } finally {
    reader.close();
  }
}

function downloadFile(file: File): void {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
