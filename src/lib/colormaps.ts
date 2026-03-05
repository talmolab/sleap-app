/**
 * Colormap lookup tables for intensity-to-RGB mapping.
 *
 * Each colormap is a 256-entry array of [R, G, B] tuples.
 * Standard scientific colormaps are generated from key control points.
 */

type RGB = [number, number, number];

/** Interpolate between control points to generate a 256-entry LUT. */
function generateLUT(
  controlPoints: { t: number; color: RGB }[]
): RGB[] {
  const lut: RGB[] = new Array(256);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    // Find surrounding control points
    let lo = controlPoints[0];
    let hi = controlPoints[controlPoints.length - 1];
    for (let j = 0; j < controlPoints.length - 1; j++) {
      if (t >= controlPoints[j].t && t <= controlPoints[j + 1].t) {
        lo = controlPoints[j];
        hi = controlPoints[j + 1];
        break;
      }
    }
    const range = hi.t - lo.t || 1;
    const f = (t - lo.t) / range;
    lut[i] = [
      Math.round(lo.color[0] + (hi.color[0] - lo.color[0]) * f),
      Math.round(lo.color[1] + (hi.color[1] - lo.color[1]) * f),
      Math.round(lo.color[2] + (hi.color[2] - lo.color[2]) * f),
    ];
  }
  return lut;
}

const viridisLUT = generateLUT([
  { t: 0.0, color: [68, 1, 84] },
  { t: 0.13, color: [72, 36, 117] },
  { t: 0.25, color: [56, 88, 140] },
  { t: 0.38, color: [39, 130, 142] },
  { t: 0.5, color: [31, 158, 137] },
  { t: 0.63, color: [53, 183, 121] },
  { t: 0.75, color: [110, 206, 88] },
  { t: 0.88, color: [181, 222, 43] },
  { t: 1.0, color: [253, 231, 37] },
]);

const magmaLUT = generateLUT([
  { t: 0.0, color: [0, 0, 4] },
  { t: 0.13, color: [28, 16, 68] },
  { t: 0.25, color: [79, 18, 123] },
  { t: 0.38, color: [129, 37, 129] },
  { t: 0.5, color: [181, 54, 122] },
  { t: 0.63, color: [229, 89, 100] },
  { t: 0.75, color: [251, 135, 97] },
  { t: 0.88, color: [254, 194, 140] },
  { t: 1.0, color: [252, 253, 191] },
]);

const infernoLUT = generateLUT([
  { t: 0.0, color: [0, 0, 4] },
  { t: 0.13, color: [31, 12, 72] },
  { t: 0.25, color: [85, 15, 109] },
  { t: 0.38, color: [136, 34, 106] },
  { t: 0.5, color: [186, 54, 85] },
  { t: 0.63, color: [227, 89, 51] },
  { t: 0.75, color: [249, 140, 10] },
  { t: 0.88, color: [249, 201, 50] },
  { t: 1.0, color: [252, 255, 164] },
]);

const plasmaLUT = generateLUT([
  { t: 0.0, color: [13, 8, 135] },
  { t: 0.13, color: [75, 3, 161] },
  { t: 0.25, color: [125, 3, 168] },
  { t: 0.38, color: [168, 34, 150] },
  { t: 0.5, color: [203, 70, 121] },
  { t: 0.63, color: [229, 107, 93] },
  { t: 0.75, color: [248, 148, 65] },
  { t: 0.88, color: [253, 195, 40] },
  { t: 1.0, color: [240, 249, 33] },
]);

const turboLUT = generateLUT([
  { t: 0.0, color: [48, 18, 59] },
  { t: 0.1, color: [67, 62, 133] },
  { t: 0.2, color: [46, 111, 199] },
  { t: 0.3, color: [24, 165, 223] },
  { t: 0.4, color: [35, 209, 180] },
  { t: 0.5, color: [102, 237, 137] },
  { t: 0.6, color: [183, 246, 99] },
  { t: 0.7, color: [234, 219, 67] },
  { t: 0.8, color: [252, 167, 54] },
  { t: 0.9, color: [239, 102, 40] },
  { t: 1.0, color: [122, 4, 3] },
]);

export const COLORMAPS: Record<string, RGB[] | null> = {
  grayscale: null,
  viridis: viridisLUT,
  magma: magmaLUT,
  inferno: infernoLUT,
  plasma: plasmaLUT,
  turbo: turboLUT,
};

/** Apply a colormap LUT to a grayscale intensity value. */
export function applyColormap(
  lut: RGB[],
  intensity: number
): RGB {
  const idx = Math.max(0, Math.min(255, Math.round(intensity)));
  return lut[idx];
}
