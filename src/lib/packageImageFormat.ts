/**
 * The image format of frames embedded in a labels package (`.pkg.slp`):
 * PNG (lossless, the default) or JPEG (lossy, several times smaller for
 * natural video), with a JPEG quality. Chosen in the package export dialogs
 * (Export Labels Package, Extract Clip Labels Package) and remembered per
 * user (`packageImageFormat` / `packageJpegQuality` in the app store).
 *
 * The writers take it as sleap-io.js's `imageFormat` / `imageQuality` (see
 * `withImageFormat` in `slpFormatCompat.ts`): PNG passes no option at all,
 * so a PNG export writes exactly what it wrote before the choice existed.
 */

/** A frame image format the export dialogs offer. */
export type PackageImageFormat = "png" | "jpg";

/** Format and JPEG quality of the frames a package export embeds. */
export interface PackageImageOptions {
  format: PackageImageFormat;
  /** JPEG quality (1-100); unused for PNG. */
  quality: number;
}

/** JPEG quality when none was chosen: as sleap-io (Python and JS) and OpenCV. */
export const DEFAULT_JPEG_QUALITY = 95;
/** Lowest JPEG quality offered (libjpeg treats 0 as 1). */
export const MIN_JPEG_QUALITY = 1;
/** Highest JPEG quality. */
export const MAX_JPEG_QUALITY = 100;

/** PNG, today's format: what every export writes unless JPEG is chosen. */
export const DEFAULT_PACKAGE_IMAGE: PackageImageOptions = Object.freeze({
  format: "png",
  quality: DEFAULT_JPEG_QUALITY,
}) as PackageImageOptions;

/** True for a choice that stores frames as JPEG. */
export function isJpegChoice(image: PackageImageOptions | null | undefined): boolean {
  return image?.format === "jpg";
}

/** A JPEG quality clamped to 1-100 and made whole; the default for junk. */
export function clampJpegQuality(quality: unknown): number {
  const q = typeof quality === "number" ? quality : Number(quality);
  if (!Number.isFinite(q)) return DEFAULT_JPEG_QUALITY;
  return Math.min(MAX_JPEG_QUALITY, Math.max(MIN_JPEG_QUALITY, Math.round(q)));
}

/**
 * A stored or hand-edited choice made safe: an unknown format reads as PNG,
 * and the quality is clamped (see {@link clampJpegQuality}).
 */
export function normalizePackageImage(
  format: unknown,
  quality: unknown,
): PackageImageOptions {
  return {
    format: format === "jpg" ? "jpg" : "png",
    quality: clampJpegQuality(quality),
  };
}
