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
  // Fast path for the common no-tracks project: every track-assignment path
  // adds the track to `labels.tracks` first (and loading a .slp populates it
  // with every referenced track), so an empty track list means no instance can
  // carry a track. Short-circuit here instead of walking every frame×instance —
  // this scan otherwise reran on every edit (`editSeq`) in two always-mounted
  // components (VideoPlayer + the default-visible InstancesPanel). The reverse
  // isn't true — a non-empty `labels.tracks` may hold only orphaned tracks (see
  // DeleteUnusedTracks) — so we still scan assignments when tracks exist.
  if (labels.tracks.length === 0) return false;
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

/**
 * Evenly-spaced gray for an untracked instance in "track" mode, spread across
 * [50, 220] by its rank among the OTHER untracked instances in the SAME
 * frame (tracked instances don't count toward the denominator, and don't
 * consume any of the range). A lone untracked instance gets the midpoint.
 */
export function getUntrackedGray(rank: number, totalUntracked: number): RGB {
  const value =
    totalUntracked <= 1
      ? 135
      : Math.round(50 + (rank * (220 - 50)) / (totalUntracked - 1));
  return [value, value, value];
}

/**
 * Get the color for an instance based on the current color target mode.
 *
 * `frameInstanceTracks` is the `.track` of every instance in the SAME frame
 * as this one, aligned by index with `instanceIndex` -- used only to compute
 * an untracked instance's rank among its untracked frame-mates for the
 * "track" mode gray fallback below.
 */
export function getInstanceColor(
  palette: string,
  colorTarget: string,
  instanceIndex: number,
  track: unknown,
  tracks: unknown[],
  isPredicted: boolean,
  colorPredicted: boolean,
  projectHasTracks: boolean = false,
  frameInstanceTracks: unknown[] = [],
): RGB {
  if (isPredicted && !colorPredicted) return [128, 128, 128];
  switch (resolveColorTarget(colorTarget, projectHasTracks)) {
    case "track":
      if (track) {
        const idx = tracks.indexOf(track);
        return getPaletteColor(palette, idx >= 0 ? idx : instanceIndex);
      }
      // Untracked instance: evenly-spaced gray by rank among untracked
      // frame-mates -- was previously getPaletteColor(palette, instanceIndex),
      // which visually read as "colored by instance" since it reused the same
      // colored palette, just keyed by position instead of by track.
      {
        const untrackedIndices: number[] = [];
        frameInstanceTracks.forEach((t, i) => {
          if (t == null) untrackedIndices.push(i);
        });
        const rank = untrackedIndices.indexOf(instanceIndex);
        return getUntrackedGray(
          rank >= 0 ? rank : 0,
          untrackedIndices.length || 1
        );
      }
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
