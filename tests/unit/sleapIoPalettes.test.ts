/** Clips use sleap-io's palettes, so their colors match PyQt's Render Clip. */

import { describe, it, expect } from "../bun-test";
import { getPaletteColor, PALETTES } from "@/lib/colorPalettes";
import {
  SLEAP_IO_PALETTES,
  SLEAP_IO_PALETTE_NAMES,
  sleapIoPaletteKey,
  sleapIoPaletteName,
} from "@/lib/sleapIoPalettes";
import { initialClipOverlayStyle } from "@/lib/videoExport";

const VIEW = {
  distinctlyColor: "track" as const,
  palette: "standard",
  showLabels: false,
  nodeLabelSize: 12,
  markerSize: 4,
  boldLines: false,
  showEdges: true,
  trailLength: 0,
  trailNode: "centroid",
  trailWidth: 2,
  trailAlpha: 1,
  trailFade: true,
};

describe("sleap-io palettes", () => {
  it("lists PyQt's Render Clip palettes in its order (glasbey aside)", () => {
    expect(SLEAP_IO_PALETTE_NAMES).toEqual([
      "standard", "distinct", "rainbow", "warm", "cool", "pastel", "seaborn", "tableau10", "viridis",
    ]);
  });

  it("has sleap-io's 7-color standard, unlike sleap-app's 10-color one", () => {
    expect(SLEAP_IO_PALETTES.standard).toHaveLength(7);
    expect(PALETTES.standard.length).toBeGreaterThan(7);
  });

  it("repeats from the start when more colors are needed, as sleap-io does", () => {
    const key = sleapIoPaletteKey("standard");
    expect(getPaletteColor(key, 7)).toEqual(SLEAP_IO_PALETTES.standard[0]);
    expect(getPaletteColor(key, 9)).toEqual(SLEAP_IO_PALETTES.standard[2]);
    // sleap-app's own "standard" is unchanged.
    expect(getPaletteColor("standard", 7)).toEqual(PALETTES.standard[7]);
  });

  it("matches sleap-io's tableau10 colors", () => {
    expect(getPaletteColor(sleapIoPaletteKey("tableau10"), 0)).toEqual([31, 119, 180]);
    expect(getPaletteColor(sleapIoPaletteKey("tableau10"), 1)).toEqual([255, 127, 14]);
  });

  it("round-trips keys and rejects unknown ones", () => {
    expect(sleapIoPaletteName(sleapIoPaletteKey("viridis"))).toBe("viridis");
    expect(sleapIoPaletteName("viridis")).toBeNull();
    expect(sleapIoPaletteName("sleap-io/nope")).toBeNull();
  });

  it("starts a clip on sleap-io's palette of the View's name, else tableau10", () => {
    expect(initialClipOverlayStyle(VIEW).palette).toBe("sleap-io/standard");
    expect(initialClipOverlayStyle({ ...VIEW, palette: "alphabet" }).palette).toBe("sleap-io/tableau10");
  });
});
