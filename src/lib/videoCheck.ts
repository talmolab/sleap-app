/**
 * Video frame check: can the app read every frame of a video, and does jumping
 * straight to frame N show the same image as playing up to it?
 *
 * Most "my labels are on the wrong frame" / "the video won't load past frame X"
 * reports are fixed by re-encoding the video, so this lets the user find out up
 * front instead. It checks the app's OWN reader (the decoder the viewer uses),
 * so a pass means "what you label on is what you see", nothing more.
 *
 * How a reader finds frame N decides what can go wrong:
 *   - mp4box (MP4): by sample number from the file's index — exact by
 *     construction; only corrupt or truncated data can fail.
 *   - MediaBunny (MOV/MKV/WebM/TS): by the timestamp of the Nth packet. Packets
 *     are in DECODE order, so a stream with B-frames shows frames out of order.
 *   - AVI/WMV: by time, `round(timestamp × fps)` — a variable frame rate leaves
 *     gaps and duplicates.
 *   - `<video>` element fallback: by playback time.
 *
 * Two tiers:
 *   - {@link quickCheck}: free, from what the reader already knows (frame
 *     times, count). Runs whenever a video opens.
 *   - {@link runFrameCheck}: reads every frame in order (anything that won't
 *     decode is reported), then jumps straight to a sample of frames with a
 *     FRESH reader and compares their pixels with the in-order read. A fresh
 *     reader matters: the viewer's frame cache would hand back the in-order
 *     frame and every comparison would trivially pass.
 *
 * A reader that stays broken after a decode error (the UI-thread MP4 decoder:
 * every later frame throws, even ones a fresh reader decodes fine) says so with
 * `stuckAfterError` and is reopened after each failed frame; otherwise a whole
 * video would read as unreadable from its first bad frame on. Others are not
 * reopened (the AVI reader loads the whole file each time it opens).
 *
 * Pure: the reader is injected, so this unit-tests without a decoder.
 */

/** Which of the app's readers decodes the video (see the module doc). */
export type ReaderKind =
  | "mp4box"
  | "mediabunny"
  | "avi"
  | "seq"
  | "media-element"
  | "images"
  | "other";

/** Readers that find frame N by time rather than by its position in the file. */
export function seeksByTime(kind: ReaderKind): boolean {
  return kind === "mediabunny" || kind === "avi" || kind === "media-element";
}

/** One thing the quick check noticed. `warn` puts a ⚠ on the video. */
export interface CheckFinding {
  code: "out-of-order" | "duplicate-times" | "variable-rate" | "time-seek";
  severity: "warn" | "info";
  message: string;
}

/**
 * - `ok`: nothing suggests a problem.
 * - `warn`: something likely shows wrong or missing frames; offer a full check.
 * - `unknown`: the reader seeks by time but can't report frame times, so only a
 *   full check can tell.
 * - `skip`: frames are stored as separate images (embedded package, image
 *   sequence); there is nothing to seek.
 */
export type QuickStatus = "ok" | "warn" | "unknown" | "skip";

export interface QuickCheckInput {
  kind: ReaderKind;
  /** Presentation time (seconds) of each frame, by frame number, if known. */
  frameTimes: number[] | null;
}

export interface QuickCheckResult {
  status: QuickStatus;
  findings: CheckFinding[];
}

/**
 * Share of frame-to-frame gaps allowed to stray from the typical gap before the
 * frame rate counts as variable. A dropped frame here and there is normal for
 * camera recordings; we only flag a pattern.
 */
const VARIABLE_RATE_FRACTION = 0.01;

/** Judge a video from what its reader already knows. Never decodes. */
export function quickCheck(input: QuickCheckInput): QuickCheckResult {
  const { kind, frameTimes } = input;
  if (kind === "images") return { status: "skip", findings: [] };
  // .seq frames are fixed-size records read by offset: nothing to seek wrongly.
  if (kind === "seq") return { status: "ok", findings: [] };

  const findings: CheckFinding[] = [];
  const times = frameTimes && frameTimes.length >= 2 ? frameTimes : null;
  if (!times) {
    if (seeksByTime(kind)) {
      findings.push({
        code: "time-seek",
        severity: "info",
        message:
          "This format is read by time. Check frames to confirm every frame shows correctly.",
      });
      return { status: "unknown", findings };
    }
    return { status: "ok", findings };
  }

  let backwards = 0;
  let repeated = 0;
  for (let i = 1; i < times.length; i++) {
    const d = times[i] - times[i - 1];
    if (d < 0) backwards++;
    else if (d === 0) repeated++;
  }
  // Frame spacing is judged in display order: out-of-order times would look
  // like a wildly varying rate.
  const sorted = [...times].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i] - sorted[i - 1];
    if (d > 0) gaps.push(d);
  }

  if (backwards > 0) {
    findings.push({
      code: "out-of-order",
      severity: "warn",
      message:
        `${plural(backwards, "frame")} ${backwards === 1 ? "has" : "have"} an earlier timestamp than the frame before, ` +
        `so frames play out of order (usually B-frames).`,
    });
  }
  if (repeated > 0) {
    findings.push({
      code: "duplicate-times",
      severity: "warn",
      message: `${plural(repeated, "frame")} share${repeated === 1 ? "s" : ""} a timestamp with the frame before, so ${repeated === 1 ? "it" : "they"} can't be told apart by time.`,
    });
  }

  const typical = median(gaps);
  if (typical > 0) {
    const irregular = gaps.filter((g) => Math.abs(g - typical) > typical / 2).length;
    if (irregular / gaps.length > VARIABLE_RATE_FRACTION) {
      // Only a reader that turns frame numbers into times (i / fps) gets this
      // wrong; one that indexes the real timestamps is unaffected.
      const timeMapped = kind === "avi" || kind === "media-element";
      findings.push({
        code: "variable-rate",
        severity: timeMapped ? "warn" : "info",
        message: timeMapped
          ? `The frame rate varies (${plural(irregular, "gap")} between frames differ from the usual spacing), so jumping by time can land on the wrong frame.`
          : `The frame rate varies (${plural(irregular, "gap")} between frames differ from the usual spacing). The app's reader for this format handles that, so this alone is harmless.`,
      });
    }
  }

  const status = findings.some((f) => f.severity === "warn") ? "warn" : "ok";
  return { status, findings };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
}

// ── Full check ───────────────────────────────────────────────────────────────

/** A private reader over one video, opened just for the check. */
export interface FrameReader {
  frameCount: number;
  /** Reopen it after a failed frame: it stays broken after a decode error. */
  stuckAfterError?: boolean;
  /**
   * Decode frame `index`. `ok: false` when it can't be decoded. With
   * `fingerprint`, also return a digest of its pixels (only the sampled frames
   * need one; reading pixels back is the slow part).
   */
  read(index: number, fingerprint: boolean): Promise<{ ok: boolean; fingerprint?: string }>;
  close(): void;
}

export interface FrameCheckProgress {
  /** `read`: the in-order pass. `seek`: jumping straight to sampled frames. */
  phase: "read" | "seek";
  done: number;
  total: number;
}

export interface FrameCheckOptions {
  /** Open a fresh reader: once per phase, and after a failed frame if it gets stuck. */
  openReader: () => Promise<FrameReader>;
  /** Frames to jump to in the seek phase. Default {@link DEFAULT_SEEK_SAMPLES}. */
  sampleCount?: number;
  /** Injected for tests; defaults to `Math.random`. */
  random?: () => number;
  signal?: AbortSignal;
  onProgress?: (p: FrameCheckProgress) => void;
}

export interface FrameCheckResult {
  frameCount: number;
  /** Frames that failed to decode in the in-order pass. */
  unreadable: number[];
  /** How many frames the seek phase jumped to and compared. */
  seekTested: number;
  /** Frames that showed a different image when jumped to. */
  seekMismatches: number[];
  /** Frames that decoded in order but not when jumped to. */
  seekUnreadable: number[];
}

export const DEFAULT_SEEK_SAMPLES = 20;

/** Progress is reported at most this often (in frames) during the in-order pass. */
const PROGRESS_EVERY = 25;

/**
 * Pick `count` distinct frames to jump to, spread over the whole video: one at
 * random from each of `count` equal stretches, plus the last frame (where
 * truncated files break). Returned in a shuffled order so consecutive reads
 * are real jumps, not a forward walk the reader could serve from its decode-ahead.
 */
export function pickSeekSamples(
  frameCount: number,
  count: number,
  random: () => number = Math.random
): number[] {
  if (frameCount <= 0 || count <= 0) return [];
  const picked = new Set<number>();
  if (count >= frameCount) {
    for (let i = 0; i < frameCount; i++) picked.add(i);
  } else {
    picked.add(frameCount - 1);
    const stretch = frameCount / count;
    for (let s = 0; s < count && picked.size < count; s++) {
      const start = Math.floor(s * stretch);
      const end = Math.max(start + 1, Math.floor((s + 1) * stretch));
      picked.add(start + Math.floor(random() * (end - start)));
    }
  }
  const out = [...picked];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Frame check canceled", "AbortError");
}

/** Read every frame in order, then jump to a sample of them with a fresh reader. */
export async function runFrameCheck(opts: FrameCheckOptions): Promise<FrameCheckResult> {
  const { signal, onProgress } = opts;
  const random = opts.random ?? Math.random;

  // Phase 1: in order.
  let reader = await opts.openReader();
  const frameCount = reader.frameCount;
  const samples = pickSeekSamples(frameCount, opts.sampleCount ?? DEFAULT_SEEK_SAMPLES, random);
  const sampleSet = new Set(samples);
  const expected = new Map<number, string>();
  const unreadable: number[] = [];
  try {
    for (let i = 0; i < frameCount; i++) {
      throwIfAborted(signal);
      const wantPrint = sampleSet.has(i);
      const res = await safeRead(reader, i, wantPrint);
      if (!res.ok) {
        unreadable.push(i);
        if (reader.stuckAfterError) reader = await reopen(reader, opts.openReader);
      } else if (wantPrint && res.fingerprint !== undefined) {
        expected.set(i, res.fingerprint);
      }
      if (i % PROGRESS_EVERY === 0 || i === frameCount - 1) {
        onProgress?.({ phase: "read", done: i + 1, total: frameCount });
      }
    }
  } finally {
    reader.close();
  }

  // Phase 2: jump straight to each sampled frame that decoded in order.
  const targets = samples.filter((i) => expected.has(i));
  const seekMismatches: number[] = [];
  const seekUnreadable: number[] = [];
  if (targets.length > 0) {
    reader = await opts.openReader();
    try {
      for (let k = 0; k < targets.length; k++) {
        throwIfAborted(signal);
        const i = targets[k];
        const res = await safeRead(reader, i, true);
        if (!res.ok) {
          seekUnreadable.push(i);
          if (reader.stuckAfterError) reader = await reopen(reader, opts.openReader);
        } else if (res.fingerprint !== expected.get(i)) {
          seekMismatches.push(i);
        }
        onProgress?.({ phase: "seek", done: k + 1, total: targets.length });
      }
    } finally {
      reader.close();
    }
  }

  return {
    frameCount,
    unreadable,
    seekTested: targets.length,
    seekMismatches: seekMismatches.sort((a, b) => a - b),
    seekUnreadable: seekUnreadable.sort((a, b) => a - b),
  };
}

/** Swap a stuck reader that just failed a frame for a fresh one (see module doc). */
async function reopen(
  reader: FrameReader,
  openReader: () => Promise<FrameReader>
): Promise<FrameReader> {
  reader.close();
  return openReader();
}

/** A read that throws counts as an unreadable frame, not a failed check. */
async function safeRead(
  reader: FrameReader,
  index: number,
  fingerprint: boolean
): Promise<{ ok: boolean; fingerprint?: string }> {
  try {
    return await reader.read(index, fingerprint);
  } catch {
    return { ok: false };
  }
}

/** True when the full check found nothing wrong. */
export function frameCheckPassed(r: FrameCheckResult): boolean {
  return (
    r.unreadable.length === 0 &&
    r.seekMismatches.length === 0 &&
    r.seekUnreadable.length === 0
  );
}

/** Compress sorted frame numbers into ranges: `[0,1,2,5,9,10]` → `"0–2, 5, 9–10"`. */
export function formatFrameRanges(frames: number[], maxRanges = 6): string {
  const ranges: string[] = [];
  let i = 0;
  while (i < frames.length) {
    let j = i;
    while (j + 1 < frames.length && frames[j + 1] === frames[j] + 1) j++;
    ranges.push(i === j ? `${frames[i]}` : `${frames[i]}–${frames[j]}`);
    i = j + 1;
  }
  if (ranges.length <= maxRanges) return ranges.join(", ");
  return `${ranges.slice(0, maxRanges).join(", ")}, and ${ranges.length - maxRanges} more`;
}

// ── Re-encode ────────────────────────────────────────────────────────────────

// Defaults match sleap-io's `sio reencode`, so a video re-encoded in the app
// matches one re-encoded on the command line.

/** Seconds between keyframes (`sio reencode --keyframe-interval`, default 1). */
export const REENCODE_KEYFRAME_SECONDS = 1;

/** Frame rate to assume when a video's is unknown (it never opened here). */
const FALLBACK_FPS = 30;

/** Keyframe interval in frames: one every {@link REENCODE_KEYFRAME_SECONDS}. */
export function keyframeGop(fps: number | null | undefined): number {
  return Math.max(1, Math.round((fps || FALLBACK_FPS) * REENCODE_KEYFRAME_SECONDS));
}

/** `sio reencode --quality` presets (its lossless preset has no bitrate equivalent). */
export type ReencodeQuality = "high" | "medium" | "low";

/** `sio reencode`'s CRF for each preset, for the copyable libx264 command. */
const SIO_CRF: Record<ReencodeQuality, number> = { high: 18, medium: 25, low: 32 };

/**
 * mediabunny's quality factor per preset (its QUALITY_HIGH / MEDIUM / LOW). The
 * app's encoders (libopenh264, WebCodecs) are bitrate-controlled, not CRF.
 */
const QUALITY_FACTOR: Record<ReencodeQuality, number> = { high: 2, medium: 1, low: 0.6 };

/**
 * H.264 bitrate (bits/s) for a preset at a frame size: mediabunny's own rule
 * (3 Mbps at 1080p, scaled by pixel count), so the desktop ffmpeg encode and
 * the browser's WebCodecs encode pick the same bitrate for the same preset.
 */
export function reencodeBitrate(quality: ReencodeQuality, width: number, height: number): number {
  const scale = Math.pow((width * height) / (1920 * 1080), 0.95);
  return Math.ceil((3_000_000 * scale * QUALITY_FACTOR[quality]) / 1000) * 1000;
}

/** The `sio reencode`-equivalent ffmpeg command, for a browser that can't re-encode. */
export function reencodeCommand(
  input: string,
  output: string,
  fps: number | null | undefined,
  quality: ReencodeQuality
): string {
  return (
    `ffmpeg -i "${input}" -c:v libx264 -crf ${SIO_CRF[quality]} -preset superfast ` +
    `-g ${keyframeGop(fps)} -bf 0 -pix_fmt yuv420p -fps_mode passthrough "${output}"`
  );
}

/** `/data/mouse.avi` → `/data/mouse.reencoded.mp4` (same folder, either separator). */
export function reencodedPath(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dot = path.lastIndexOf(".");
  const stem = dot > slash + 1 ? path.slice(0, dot) : path;
  return `${stem}.reencoded.mp4`;
}

export type SwapDecision =
  | { ok: true; note: string | null }
  | { ok: false; reason: string };

/**
 * Whether the re-encoded video can replace the original in the project.
 * Labels are keyed by frame number, so a different frame count with labels on
 * the video would put them on the wrong images: refuse (the scrub proxy's
 * frame-exact rule). With no labels there is nothing to misplace. `oldCount`
 * is null when the original never opened here, so there is nothing to compare.
 */
export function decideReencodeSwap(args: {
  oldCount: number | null;
  newCount: number;
  labeledCount: number;
}): SwapDecision {
  const { oldCount, newCount, labeledCount } = args;
  if (oldCount === null) {
    return {
      ok: true,
      note:
        labeledCount > 0
          ? `The original couldn't be opened here, so its frame count couldn't be compared. Check that labels sit on the right images.`
          : null,
    };
  }
  if (newCount === oldCount) return { ok: true, note: null };
  if (labeledCount === 0) {
    return {
      ok: true,
      note: `The re-encoded video has ${plural(newCount, "frame")}; the app read ${plural(oldCount, "frame")} from the original.`,
    };
  }
  return {
    ok: false,
    reason:
      `The re-encoded video has ${plural(newCount, "frame")} but the original has ${plural(oldCount, "frame")}, ` +
      `so the ${plural(labeledCount, "labeled frame")} on this video could land on the wrong images. ` +
      `The project still uses the original.`,
  };
}

/**
 * The order to read a reader's frames in so they come out in display order:
 * by timestamp. Identity when the times are already in order (or unknown). A
 * reader that indexes packets in decode order (MediaBunny on a B-frame video)
 * needs this, or a re-encode would bake its wrong order into the new file.
 */
export function displayOrder(frameCount: number, frameTimes: number[] | null): number[] {
  const order = Array.from({ length: frameCount }, (_, i) => i);
  if (!frameTimes || frameTimes.length !== frameCount) return order;
  return order.sort((a, b) => frameTimes[a] - frameTimes[b] || a - b);
}

/**
 * When re-encoding a video that already has labels and showed problems, the
 * labels were placed on frames the viewer showed wrongly; after re-encoding
 * they line up with the frames in their true order. Say so before swapping.
 */
export function labelShiftWarning(labeledCount: number, problemsFound: boolean): string | null {
  if (labeledCount === 0 || !problemsFound) return null;
  return (
    `This video has ${plural(labeledCount, "labeled frame")}. Some frames showed wrongly before, ` +
    `so labels made on them may sit on a different image after re-encoding. Review them afterwards.`
  );
}

// ── Desktop fast first pass ──────────────────────────────────────────────────

/** What a native ffmpeg decode of every frame found. */
export interface NativeDecodeResult {
  /** Frames ffmpeg decoded. */
  decoded: number;
  /** ffmpeg's error lines (decode errors, damaged or missing data). */
  errors: string[];
}

/**
 * ffmpeg args to decode every frame of the first video stream and discard it,
 * reporting progress on stdout and only errors on stderr. Every frame is kept
 * (`-fps_mode passthrough`), so the count is the frames that decode.
 */
export function nativeDecodeArgs(path: string): string[] {
  return [
    "-v",
    "error",
    "-i",
    path,
    "-map",
    "0:v:0",
    "-fps_mode",
    "passthrough",
    "-progress",
    "pipe:1",
    "-nostats",
    "-f",
    "null",
    "-",
  ];
}

/**
 * Whether ffmpeg decoding every frame settles the check on its own: no errors,
 * and exactly the frames the app's reader sees. Only for the MP4 reader, which
 * finds frame N by its position in the file, so jumping can't land on a wrong
 * frame. Anything else (errors, a different count, a reader that seeks by time)
 * goes on to the app-reader check for exact frame numbers: ffmpeg patches over
 * damaged frames the app's decoder can't show.
 */
export function nativeDecodeClears(
  kind: ReaderKind | null,
  appFrameCount: number,
  result: NativeDecodeResult
): boolean {
  return kind === "mp4box" && result.errors.length === 0 && result.decoded === appFrameCount;
}

/** The check result for a video the native pass cleared: every frame read, no jumps needed. */
export function clearedResult(frameCount: number): FrameCheckResult {
  return { frameCount, unreadable: [], seekTested: 0, seekMismatches: [], seekUnreadable: [] };
}

