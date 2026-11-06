/**
 * Desktop: extract a video's frames as PNGs with the bundled ffmpeg sidecar,
 * for embedding into a labels package (Export Labels Package / Extract Clip
 * Labels Package). Same plumbing as the scrub proxy and legacy-codec
 * transcode (`transcodeDepsTauri.ts`): a native child process, progress from
 * `-progress`, killed on cancel.
 *
 * Why: in the WebView, PNG-encoding each 1024×1024 frame in JavaScript limits
 * embedding to ~12 frames/s; PyQt SLEAP (OpenCV in C) does ~120. ffmpeg
 * decodes and PNG-encodes natively on all cores: ~110 frames/s with the
 * settings below (2,560 color frames ≈ 23 s), the selected frames picked by
 * number.
 *
 * One ffmpeg run per video writes exactly the requested frames, in order, to
 * a temp folder under the app cache. The export reads each PNG once ffmpeg has
 * finished it (it's not the newest file, or ffmpeg has exited) and deletes it,
 * so extracting and writing overlap and the folder never holds many frames.
 * The folder is removed when the video is done, fails or is cancelled.
 */
import { CropVideoBackend, type ExternalFrameReader, type Video } from "@talmolab/sleap-io.js";
import { createTauriTranscodeDeps } from "./transcodeDepsTauri";
import type { TranscodeDeps } from "./transcodeVideo";

/**
 * PNG settings: Sub-filtered rows (as OpenCV), zlib level 4. ffmpeg can't use
 * zlib's run-length strategy (which keeps OpenCV's files small), so this
 * balances speed and size: ~110 frames/s and ~18% larger frames than PyQt's
 * on the fly test video (level 1: ~250 frames/s, +25%; level 6: ~45, +14%).
 */
export const EXTRACT_PNG_ARGS = ["-c:v", "png", "-pred", "sub", "-compression_level", "4"];

/** What the extractor needs from the platform (Tauri in production). */
export interface ExtractFramesDeps
  extends Pick<TranscodeDeps, "cacheDir" | "join" | "mkdir" | "exec" | "runTranscode"> {
  readFile: (path: string) => Promise<Uint8Array>;
  writeText: (path: string, text: string) => Promise<void>;
  removeFile: (path: string) => Promise<void>;
  removeDir: (path: string) => Promise<void>;
  /** A fresh, collision-free folder name. */
  newId: () => string;
}

/**
 * ffmpeg's `select` filter for the given frames (sorted): consecutive runs as
 * `between(n,a,b)`, single frames as `eq(n,f)`, then the output pixels.
 * `n` counts decoded frames in presentation order, the app's frame index.
 *
 * Grayscale keeps the red channel of the RGB frame, as Python sleap-io does
 * (`img[..., [0]]`): pixel-identical to OpenCV's. ffmpeg's own `gray` is the
 * luma plane, which differs by a level or two.
 */
export function buildFrameSelectFilter(
  frames: readonly number[],
  grayscale: boolean
): string {
  const terms: string[] = [];
  for (let i = 0; i < frames.length; ) {
    let j = i;
    while (j + 1 < frames.length && frames[j + 1] === frames[j] + 1) j++;
    terms.push(
      i === j ? `eq(n,${frames[i]})` : `between(n,${frames[i]},${frames[j]})`
    );
    i = j + 1;
  }
  const pixels = grayscale ? "format=rgb24,format=gbrp,extractplanes=r" : "format=rgb24";
  return `select='${terms.join("+")}',${pixels}`;
}

/**
 * ffmpeg arguments: decode `input`, keep the frames the filter (read from
 * `filterFile`, so long frame lists stay clear of command-line limits) selects,
 * frame-exact, and write them as numbered PNGs (`outPattern`, e.g.
 * `<dir>/%06d.png`), with progress on stdout. Stops after `frameCount`
 * frames instead of decoding the rest of the video.
 */
export function buildExtractFramesArgs(options: {
  input: string;
  filterFile: string;
  outPattern: string;
  frameCount: number;
}): string[] {
  return [
    "-y",
    "-i",
    options.input,
    "-map",
    "0:v:0",
    "-an",
    "-/vf",
    options.filterFile,
    "-fps_mode",
    "passthrough", // FRAME-EXACT, as the transcode
    "-frames:v",
    String(options.frameCount),
    ...EXTRACT_PNG_ARGS,
    "-progress",
    "pipe:1",
    "-nostats",
    "-stats_period",
    "0.1",
    options.outPattern,
  ];
}

/**
 * The local file a video is read from, or null (image sequence, URL, embedded,
 * or cropped: ffmpeg would extract the whole frame).
 */
export function extractableVideoPath(video: Video): string | null {
  if (video.hasEmbeddedImages || typeof video.filename !== "string") return null;
  if (video.backend instanceof CropVideoBackend) return null;
  const path = video.filename;
  if (!path || /^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return null;
  return path;
}

let ffmpegAvailable: Promise<boolean> | null = null;

/** Test-only: forget whether ffmpeg runs. */
export function __resetFfmpegCheck(): void {
  ffmpegAvailable = null;
}

/**
 * An {@link ExternalFrameReader} that extracts `frameNumbers` (sorted) of
 * `video` with ffmpeg, or null when ffmpeg can't do it (not a local video
 * file, or no runnable ffmpeg), so the caller decodes in the app instead.
 */
export async function createFfmpegFrameReader(
  video: Video,
  frameNumbers: readonly number[],
  deps: ExtractFramesDeps
): Promise<ExternalFrameReader | null> {
  const input = extractableVideoPath(video);
  if (!input || frameNumbers.length === 0) return null;
  ffmpegAvailable ??= deps
    .exec("ffmpeg", ["-hide_banner", "-version"])
    .then((r) => r.code === 0)
    .catch(() => false);
  if (!(await ffmpegAvailable)) return null;

  const dir = await deps.join(await deps.cacheDir(), "export-frames", deps.newId());
  await deps.mkdir(dir);
  const filterFile = await deps.join(dir, "select.txt");
  await deps.writeText(filterFile, buildFrameSelectFilter(frameNumbers, video.shape?.[3] === 1));

  // Frames ffmpeg has finished writing, and when it has exited.
  let written = 0;
  let exited = false;
  let failure: Error | null = null;
  let wake: () => void = () => {};
  const changed = () => new Promise<void>((resolve) => (wake = resolve));
  const controller = new AbortController();
  const run = deps
    .runTranscode(
      buildExtractFramesArgs({
        input,
        filterFile,
        outPattern: await deps.join(dir, "%06d.png"),
        frameCount: frameNumbers.length,
      }),
      (p) => {
        if (p.frame !== undefined && p.frame > written) {
          written = p.frame;
          wake();
        }
      },
      controller.signal
    )
    .catch((e: unknown) => {
      failure = e instanceof Error ? e : new Error(String(e));
    })
    .finally(() => {
      exited = true;
      wake();
    });

  let next = 0;
  return {
    async read(frameIdx) {
      const index = next++;
      if (frameNumbers[index] !== frameIdx) {
        throw new Error(`ffmpeg frames were requested out of order (frame ${frameIdx})`);
      }
      // The newest file may still be being written; the one before it is done.
      while (!exited && written <= index + 1) await changed();
      if (failure && written <= index) throw failure;
      const file = await deps.join(dir, `${String(index + 1).padStart(6, "0")}.png`);
      let bytes: Uint8Array;
      try {
        bytes = await deps.readFile(file);
      } catch {
        return null; // ffmpeg wrote fewer frames than asked (e.g. past the end)
      }
      await deps.removeFile(file).catch(() => {});
      return bytes as never;
    },
    async close() {
      controller.abort();
      await run;
      await deps.removeDir(dir).catch(() => {});
    },
  };
}

/** The production (Tauri) dependencies. Desktop only. */
export function createTauriExtractFramesDeps(): ExtractFramesDeps {
  const t = createTauriTranscodeDeps();
  return {
    cacheDir: t.cacheDir,
    join: t.join,
    mkdir: t.mkdir,
    exec: t.exec,
    runTranscode: t.runTranscode,
    async readFile(path) {
      const { readFile } = await import("@tauri-apps/plugin-fs");
      return readFile(path);
    },
    async writeText(path, text) {
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      await writeTextFile(path, text);
    },
    async removeFile(path) {
      const { remove } = await import("@tauri-apps/plugin-fs");
      await remove(path);
    },
    async removeDir(path) {
      const { remove } = await import("@tauri-apps/plugin-fs");
      await remove(path, { recursive: true });
    },
    newId: () =>
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  };
}
