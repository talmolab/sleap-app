/**
 * Tests for the VizViewer pure helpers (viz PNG path + epoch probing).
 */
import { describe, it, expect } from "../bun-test";
import { vizPngPath, probeMaxEpoch } from "@/components/monitors/VizViewer";

describe("vizPngPath", () => {
  it("zero-pads the epoch to 4 digits under <runDir>/viz", () => {
    expect(vizPngPath("/run", "validation", 3)).toBe("/run/viz/validation.0003.png");
    expect(vizPngPath("/run", "train", 42)).toBe("/run/viz/train.0042.png");
  });
});

describe("probeMaxEpoch", () => {
  const existsIn = (paths: Set<string>) => async (p: string) => paths.has(p);
  const present = (epochs: number[], kind: "validation" | "train" = "validation") =>
    new Set(epochs.map((e) => vizPngPath("/r", kind, e)));

  it("returns the highest contiguous epoch present from the start", async () => {
    expect(await probeMaxEpoch("/r", "validation", existsIn(present([0, 1, 2, 3, 4])), 0)).toBe(4);
  });

  it("returns startEpoch-1 when none are present", async () => {
    expect(await probeMaxEpoch("/r", "validation", async () => false, 0)).toBe(-1);
  });

  it("extends from a later start epoch without rescanning from 0", async () => {
    expect(await probeMaxEpoch("/r", "validation", existsIn(present([0, 1, 2, 3, 4, 5, 6])), 5)).toBe(6);
  });

  it("stops at the first gap", async () => {
    // 0,1 present, 2 missing, 3 present → highest contiguous is 1
    expect(await probeMaxEpoch("/r", "validation", existsIn(present([0, 1, 3])), 0)).toBe(1);
  });
});
