/**
 * Export utilities for SLEAP Label Web.
 *
 * Provides file download + project export helpers. (Analysis CSV export now uses
 * sleap-io.js's canonical `labelsToCsv` directly — see ExportCSVCommand.)
 */

import { type Labels } from "@talmolab/sleap-io.js";

/** Download a string as a file via Blob + hidden anchor click. */
export function downloadFile(
  content: string | Blob,
  filename: string,
  mimeType: string = "text/plain"
): void {
  const blob =
    content instanceof Blob
      ? content
      : new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Generate a JSON package of the project.
 *
 * Returns a JSON string containing the full labels data plus a manifest
 * of referenced video files.
 */
export function generatePackageJSON(labels: Labels): string {
  const labelsDict = labels.toDict();
  const videoManifest = labels.videos.map((v) => ({
    filename: v.filename,
    shape: v.shape,
    fps: v.fps,
    hasEmbeddedImages: v.hasEmbeddedImages,
  }));

  const pkg = {
    format: "sleap-label-web-package",
    version: "1.0.0",
    exportedAt: new Date().toISOString(),
    videoManifest,
    labels: labelsDict,
  };

  return JSON.stringify(pkg, null, 2);
}

/**
 * Suggest a save filename based on the current filename.
 *
 * If the filename already has a version number (e.g., "project.v002.json"),
 * increment it. Otherwise, append ".v002".
 */
export function suggestSaveFilename(
  currentFilename: string | null,
  extension: string = ".json"
): string {
  const baseName = (currentFilename ?? "labels")
    .replace(/\.slp$/, "")
    .replace(/\.json$/, "");

  // Match existing version pattern like .v002
  const versionMatch = baseName.match(/\.v(\d+)$/);
  if (versionMatch) {
    const nextVersion = parseInt(versionMatch[1], 10) + 1;
    const padded = String(nextVersion).padStart(3, "0");
    return baseName.replace(/\.v\d+$/, `.v${padded}`) + extension;
  }

  return baseName + ".v002" + extension;
}
