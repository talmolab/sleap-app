/**
 * Pure parsers + encoder selection for the desktop transcode fallback. These
 * turn raw ffprobe/ffmpeg CLI output into typed data and choose a permissive
 * H.264 encoder — all decoder-independent so they unit-test without a binary.
 */

export interface ProbedVideo {
  /** ffmpeg `codec_name`, lowercased (e.g. "mpeg4", "wmv3", "h264"). */
  codec: string;
  /** ffmpeg `pix_fmt` if reported (e.g. "yuv420p", "yuv420p10le"). */
  pixFmt?: string;
}

/**
 * Parse `ffprobe -show_entries stream=codec_name,pix_fmt -of json` output for
 * the first video stream. Returns null if there's no decodable video stream.
 */
export function parseFfprobeCodec(json: string): ProbedVideo | null {
  let parsed: { streams?: Array<{ codec_name?: string; pix_fmt?: string }> };
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const stream = parsed.streams?.[0];
  if (!stream?.codec_name) return null;
  return {
    codec: stream.codec_name.toLowerCase(),
    pixFmt: stream.pix_fmt?.toLowerCase(),
  };
}

/**
 * Parse the encoder names from `ffmpeg -hide_banner -encoders`. Each capability
 * line looks like ` V....D libx264   libx264 H.264 …`; we take the 2nd token
 * (the encoder name) from lines whose flags column starts with `V` (video).
 */
export function parseEncoderList(stdout: string): string[] {
  const names: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*([VASFXBD.]{6})\s+(\S+)/);
    if (m && m[1].startsWith("V")) names.push(m[2]);
  }
  return names;
}

/**
 * Preference order for the H.264 encoder used to transcode legacy video.
 * Deliberately PERMISSIVE-only — `libx264` is GPL and excluded so a bundled
 * build stays LGPL/BSD:
 *   - `libopenh264` (Cisco, BSD) — the cross-platform ship choice.
 *   - `h264_videotoolbox` (Apple, hardware) — always present on macOS, permissive.
 */
export const H264_ENCODER_PREFERENCE = ["libopenh264", "h264_videotoolbox"];

/**
 * Pick the first available permissive H.264 encoder. Throws a clear, actionable
 * error if the bundled ffmpeg has none (points at rebuilding with libopenh264).
 */
export function pickH264Encoder(
  available: string[],
  preference: string[] = H264_ENCODER_PREFERENCE
): string {
  const set = new Set(available);
  const chosen = preference.find((enc) => set.has(enc));
  if (!chosen) {
    throw new Error(
      `Bundled ffmpeg has no permissive H.264 encoder ` +
        `(need one of: ${preference.join(", ")}). Rebuild the sidecar with ` +
        `--enable-libopenh264.`
    );
  }
  return chosen;
}
