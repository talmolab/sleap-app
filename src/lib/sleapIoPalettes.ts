/**
 * sleap-io's rendering palettes (sleap_io/rendering/colors.py `PALETTES`,
 * sleap-io 0.9.3), which PyQt SLEAP's Render Clip uses. Exported clips use
 * these, so a clip's colors match PyQt's exactly. Some names match sleap-app's
 * own palettes but not their colors (sleap-io's `standard` has 7 colors,
 * sleap-app's 10), so they live under their own keys ({@link sleapIoPaletteKey}).
 *
 * Like sleap-io, a palette repeats from the start when more colors are needed
 * (`_extend_palette`). PyQt also offers colorcet's glasbey palettes; those
 * aren't here.
 */
import type { RGB } from "@/lib/colorPalettes";

export const SLEAP_IO_PALETTES: Record<string, RGB[]> = {
  standard: [
    [0, 114, 189], [217, 83, 25], [237, 177, 32], [126, 47, 142], [119, 172, 48], [77, 190, 238], [162, 20, 47],
  ],
  distinct: [
    [255, 100, 100], [100, 100, 255], [100, 255, 100], [255, 255, 100], [255, 100, 255],
    [100, 255, 255], [255, 180, 100], [180, 100, 255], [255, 150, 150], [150, 255, 200],
  ],
  rainbow: [
    [255, 0, 0], [255, 127, 0], [255, 255, 0], [127, 255, 0], [0, 255, 0], [0, 255, 127],
    [0, 255, 255], [0, 127, 255], [0, 0, 255], [127, 0, 255], [255, 0, 255], [255, 0, 127],
  ],
  warm: [[255, 87, 51], [255, 140, 0], [255, 195, 0], [255, 215, 0], [255, 69, 0], [220, 20, 60]],
  cool: [[0, 150, 255], [0, 191, 255], [30, 144, 255], [65, 105, 225], [138, 43, 226], [75, 0, 130]],
  pastel: [[255, 179, 186], [255, 223, 186], [255, 255, 186], [186, 255, 201], [186, 225, 255], [218, 186, 255]],
  seaborn: [
    [76, 114, 176], [221, 132, 82], [85, 168, 104], [196, 78, 82], [129, 114, 179],
    [147, 120, 96], [218, 139, 195], [140, 140, 140], [204, 185, 116], [100, 181, 205],
  ],
  tableau10: [
    [31, 119, 180], [255, 127, 14], [44, 160, 44], [214, 39, 40], [148, 103, 189],
    [140, 86, 75], [227, 119, 194], [127, 127, 127], [188, 189, 34], [23, 190, 207],
  ],
  viridis: [
    [68, 1, 84], [72, 40, 120], [62, 73, 137], [49, 104, 142], [38, 130, 142],
    [31, 158, 137], [53, 183, 121], [109, 205, 89], [180, 222, 44], [253, 231, 37],
  ],
};

/** PyQt's Render Clip palette list, in its order (minus glasbey). */
export const SLEAP_IO_PALETTE_NAMES = Object.keys(SLEAP_IO_PALETTES);

/** PyQt's Render Clip default palette. */
export const SLEAP_IO_DEFAULT_PALETTE = "tableau10";

const PREFIX = "sleap-io/";

/** The palette key (as `getPaletteColor` takes) for a sleap-io palette name. */
export function sleapIoPaletteKey(name: string): string {
  return PREFIX + name;
}

/** The sleap-io palette name in a key, or null if the key isn't one. */
export function sleapIoPaletteName(key: string): string | null {
  return key.startsWith(PREFIX) && key.slice(PREFIX.length) in SLEAP_IO_PALETTES ? key.slice(PREFIX.length) : null;
}
