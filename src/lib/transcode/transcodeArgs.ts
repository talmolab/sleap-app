/**
 * ffmpeg argument builder for the desktop legacy-codec transcode fallback.
 *
 * Codecs WebCodecs can't decode (Xvid/DivX = MPEG-4 ASP, WMV3/VC-1, MPEG-1/2,
 * 10-bit HEVC) are re-encoded to a plain H.264 MP4 once, cached, then opened
 * through the normal hardware (Mp4Box → WebCodecs) path. This module builds the
 * ffmpeg CLI — pure and decoder-independent so it can be unit-tested without a
 * binary; the actual spawn lives in {@link file://./transcodeVideo.ts}.
 *
 * The one CORRECTNESS-critical flag is `-fps_mode passthrough`: it preserves
 * every source frame 1:1 (no fps resampling, no drop/dup), so frame N in the MP4
 * is frame N in the original and SLEAP labels (which key off frame index) stay
 * aligned. Verified in the spike (10→10, 500→500 parity).
 */

export interface TranscodeArgsOptions {
  /** Absolute source path (legacy video). */
  input: string;
  /** Absolute destination path (a `.mp4`; usually a temp name — see transcodeVideo). */
  output: string;
  /**
   * Video encoder. Default `libopenh264` — the permissively-licensed H.264
   * encoder we bundle (CVAT makes the same choice); libx264 would pull in GPL.
   */
  encoder?: string;
  /**
   * Encoder quality/rate args. libopenh264 is bitrate-controlled (no CRF), so
   * the default targets a high, visually-safe bitrate for labeling. Override per
   * the bundled build / source resolution. (The spike used libx264 `-crf 18`;
   * swap `encoder: "libx264", quality: ["-crf", "18"]` to reproduce it.)
   */
  quality?: string[];
  /**
   * Keyframe interval (GOP size). A short GOP makes random seeking on the
   * transcoded MP4 cheap (fewer frames to decode after a keyframe). Default 30.
   */
  gopSize?: number;
  /**
   * Emit machine-readable progress on stdout (`-progress pipe:1 -nostats`) so
   * the caller can drive a progress bar. Default true.
   */
  progress?: boolean;
}

const DEFAULT_ENCODER = "libopenh264";
/** libopenh264 is bitrate-controlled; 6 Mbps is generous for typical behavior video. */
const DEFAULT_QUALITY = ["-b:v", "6M"];
const DEFAULT_GOP = 30;

/**
 * Build the frame-exact "legacy → H.264 MP4" ffmpeg argument list. Input options
 * precede `-i`; output options follow it; the output path is last. Audio is
 * dropped (`-an`) and only the first video stream is mapped — labeling needs
 * neither audio nor secondary streams.
 */
export function buildTranscodeArgs(options: TranscodeArgsOptions): string[] {
  const encoder = options.encoder ?? DEFAULT_ENCODER;
  const quality = options.quality ?? DEFAULT_QUALITY;
  const gopSize = options.gopSize ?? DEFAULT_GOP;
  const progress = options.progress ?? true;

  return [
    "-y", // overwrite the (temp) output if a stale one exists
    "-i",
    options.input,
    "-map",
    "0:v:0", // first video stream only
    "-an", // no audio
    "-c:v",
    encoder,
    "-pix_fmt",
    "yuv420p", // 8-bit 4:2:0 — the format WebCodecs can always decode
    "-fps_mode",
    "passthrough", // FRAME-EXACT: keep every source frame, no resampling
    "-g",
    String(gopSize),
    ...quality,
    ...(progress ? ["-progress", "pipe:1", "-nostats"] : []),
    options.output,
  ];
}
