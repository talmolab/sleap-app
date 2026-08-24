/**
 * Classify a video codec (by ffmpeg `codec_name`, + optional `pix_fmt`) into
 * "the platform can decode this directly" vs "must transcode first". Pure and
 * decoder-independent — the desktop router probes the codec (native ffprobe)
 * and consults this to decide whether to hand the file to the normal backend or
 * to {@link file://./transcodeVideo.ts} first.
 *
 * Mirrors what the browser can actually do: WebCodecs decodes H.264/HEVC/VP8/9/
 * AV1 (8-bit), and MJPEG decodes as per-frame JPEGs via `createImageBitmap`.
 * Everything else legacy (MPEG-1/2, MPEG-4 ASP = Xvid/DivX, MS-MPEG4, WMV1-3,
 * VC-1) — and 10-bit H.264/HEVC, which WebCodecs rejects — needs a transcode.
 */

/** Codecs WebCodecs decodes directly (8-bit). */
const WEBCODECS_CODECS = new Set([
  "h264",
  "hevc",
  "h265",
  "vp8",
  "vp9",
  "av1",
]);

/** All-intra image codecs decoded per-frame via `createImageBitmap` (no transcode). */
const IMAGE_CODECS = new Set(["mjpeg", "mjpg", "jpeg"]);

/** True if `pixFmt` is a >8-bit format WebCodecs can't decode (e.g. 10-bit HEVC). */
function isHighBitDepth(pixFmt: string | undefined): boolean {
  if (!pixFmt) return false;
  const f = pixFmt.toLowerCase();
  return (
    f.includes("10") || f.includes("12") || f.startsWith("p010") || f.includes("p10")
  );
}

/**
 * Whether a file with this codec must be transcoded to H.264 before it can be
 * decoded in the browser/WebView. `pixFmt` (optional) catches 10-bit H.264/HEVC,
 * which are the {@link WEBCODECS_CODECS} by name but not decodable in practice.
 */
export function codecNeedsTranscode(
  codecName: string,
  pixFmt?: string
): boolean {
  const codec = codecName.toLowerCase();
  if (IMAGE_CODECS.has(codec)) return false; // MJPEG → createImageBitmap
  if (WEBCODECS_CODECS.has(codec)) return isHighBitDepth(pixFmt); // 10-bit → transcode
  return true; // mpeg1/2, mpeg4-asp, msmpeg4, wmv1-3, vc1, uncompressed, …
}
