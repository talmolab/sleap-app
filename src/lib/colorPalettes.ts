/**
 * Color palette definitions matching SLEAP's ColorManager.
 *
 * Palettes are arrays of [R, G, B] tuples.
 */

import type { Labels } from "@/types";

export type RGB = [number, number, number];

export const PALETTES: Record<string, RGB[]> = {
  standard: [
    [0, 114, 189],
    [217, 83, 25],
    [237, 177, 32],
    [126, 47, 142],
    [119, 172, 48],
    [77, 190, 238],
    [162, 20, 47],
    [0, 128, 128],
    [255, 109, 182],
    [128, 128, 0],
  ],
  "five+": [
    [228, 26, 28],
    [55, 126, 184],
    [77, 175, 74],
    [152, 78, 163],
    [255, 127, 0],
    [166, 86, 40],
    [247, 129, 191],
    [153, 153, 153],
  ],
  alphabet: [
    [240, 163, 255],
    [0, 117, 220],
    [153, 63, 0],
    [76, 0, 92],
    [0, 92, 49],
    [43, 206, 72],
    [255, 204, 153],
    [128, 128, 128],
    [148, 255, 181],
    [143, 124, 0],
    [157, 204, 0],
    [194, 0, 136],
    [0, 51, 128],
    [255, 164, 5],
    [255, 168, 187],
    [66, 102, 0],
    [255, 0, 16],
    [94, 241, 242],
    [0, 153, 143],
    [224, 255, 102],
    [116, 10, 255],
    [153, 0, 0],
    [255, 255, 128],
    [255, 80, 5],
    [0, 255, 0],
    [255, 0, 0],
  ],
};

/** Get a color for an item at the given index from the named palette. */
export function getPaletteColor(
  palette: string,
  index: number
): RGB {
  const colors = PALETTES[palette] ?? PALETTES.standard;
  return colors[index % colors.length];
}

/** Convert RGB to CSS color string. */
export function rgbToCSS(color: RGB, alpha: number = 1): string {
  if (alpha === 1) {
    return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
  }
  return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`;
}

/**
 * Whether any instance in the project has been assigned a track.
 *
 * `labels.tracks` alone isn't a reliable proxy — tracks can outlive every
 * instance that referenced them (see the `DeleteUnusedTracks` command), so
 * this scans actual instance assignments instead.
 */
export function hasAssignedTracks(labels: Labels | null | undefined): boolean {
  if (!labels) return false;
  return labels.labeledFrames.some((lf) =>
    lf.instances.some((inst) => inst.track != null)
  );
}

/**
 * Resolve the "auto" color target to a concrete one: color by track once any
 * instance has been assigned a track, otherwise color by node.
 */
export function resolveColorTarget(
  colorTarget: string,
  projectHasTracks: boolean
): Exclude<string, "auto"> {
  if (colorTarget !== "auto") return colorTarget;
  return projectHasTracks ? "track" : "node";
}

/** Get the color for an instance based on the current color target mode. */
export function getInstanceColor(
  palette: string,
  colorTarget: string,
  instanceIndex: number,
  track: unknown,
  tracks: unknown[],
  isPredicted: boolean,
  colorPredicted: boolean,
  projectHasTracks: boolean = false,
): RGB {
  if (isPredicted && !colorPredicted) return [128, 128, 128];
  switch (resolveColorTarget(colorTarget, projectHasTracks)) {
    case "track":
      if (track) {
        const idx = tracks.indexOf(track);
        return getPaletteColor(palette, idx >= 0 ? idx : instanceIndex);
      }
      return getPaletteColor(palette, instanceIndex);
    case "node":
    case "edge":
      return [180, 180, 180]; // Neutral for per-node/edge coloring
    case "instance":
    default:
      return getPaletteColor(palette, instanceIndex);
  }
}

/** Convert RGB to hex string. */
export function rgbToHex(color: RGB): string {
  return `#${color.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}
