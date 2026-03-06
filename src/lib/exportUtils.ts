/**
 * Export utilities for SLEAP Label Web.
 *
 * Provides CSV export and file download helpers.
 */

import { PredictedInstance, type Labels } from "@talmolab/sleap-io.js";

/**
 * Generate a CSV string from Labels data.
 *
 * Columns: video_filename, frame_idx, track_name, instance_type,
 *          node_name, x, y, score, visible
 */
export function generateCSV(labels: Labels): string {
  const rows: string[] = [
    "video_filename,frame_idx,track_name,instance_type,node_name,x,y,score,visible",
  ];

  for (const lf of labels.labeledFrames) {
    const videoFilename =
      typeof lf.video.filename === "string"
        ? lf.video.filename
        : lf.video.filename[0] ?? "";

    for (const inst of lf.instances) {
      const isPredicted = inst instanceof PredictedInstance;
      const instanceType = isPredicted ? "predicted" : "user";
      const trackName = inst.track?.name ?? "";
      const instanceScore = isPredicted ? inst.score : "";

      for (const point of inst.points) {
        const x = isNaN(point.xy[0]) ? "" : String(point.xy[0]);
        const y = isNaN(point.xy[1]) ? "" : String(point.xy[1]);
        const nodeName = point.name ?? "";
        const pointScore =
          point.score != null ? String(point.score) : "";
        const visible = point.visible ? "true" : "false";

        rows.push(
          [
            csvEscape(videoFilename),
            lf.frameIdx,
            csvEscape(trackName),
            instanceType,
            csvEscape(nodeName),
            x,
            y,
            pointScore || instanceScore,
            visible,
          ].join(",")
        );
      }
    }
  }

  return rows.join("\n");
}

/** Escape a string value for CSV (quote if it contains comma, quote, or newline). */
function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

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
