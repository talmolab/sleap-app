import { describe, it, expect } from "../bun-test";
import type { Instance } from "@/types";
import {
  instanceVisible,
  instanceShowsNonVisible,
  computeQcVisibility,
  type QcMode,
  type VisibilitySlice,
} from "@/lib/instanceVisibility";

// Instances are keyed by object identity; plain objects stand in fine here.
const a = { id: "a" } as unknown as Instance;
const b = { id: "b" } as unknown as Instance;
const c = { id: "c" } as unknown as Instance;

function slice(over: Partial<VisibilitySlice> = {}): VisibilitySlice {
  return {
    showInstances: true,
    hiddenInstances: new Set(),
    viewOnlyInstance: null,
    showNonVisibleOverride: new Map(),
    ...over,
  };
}

describe("instanceVisible", () => {
  it("global Show-Instances off hides everything", () => {
    expect(instanceVisible(slice({ showInstances: false }), a)).toBe(false);
  });
  it("view-only shows only that instance", () => {
    const s = slice({ viewOnlyInstance: b });
    expect(instanceVisible(s, a)).toBe(false);
    expect(instanceVisible(s, b)).toBe(true);
  });
  it("hidden set hides listed instances", () => {
    const s = slice({ hiddenInstances: new Set([a]) });
    expect(instanceVisible(s, a)).toBe(false);
    expect(instanceVisible(s, b)).toBe(true);
  });
});

describe("instanceShowsNonVisible", () => {
  it("absent override falls back to the global default", () => {
    expect(instanceShowsNonVisible(slice(), a, true)).toBe(true);
    expect(instanceShowsNonVisible(slice(), a, false)).toBe(false);
  });
  it("per-instance override beats the global default", () => {
    const s = slice({ showNonVisibleOverride: new Map([[a, false]]) });
    expect(instanceShowsNonVisible(s, a, true)).toBe(false);
    expect(instanceShowsNonVisible(s, b, true)).toBe(true);
  });
});

describe("computeQcVisibility", () => {
  const all = [a, b, c];
  it("manual returns the empty sentinel", () => {
    expect(computeQcVisibility("manual", a, all, true).size).toBe(0);
  });
  it("selected_only: only selected drawn; its occluded gated by global", () => {
    const m = computeQcVisibility("selected_only", b, all, true);
    expect(m.get(a)).toEqual([false, false]);
    expect(m.get(b)).toEqual([true, true]);
    const off = computeQcVisibility("selected_only", b, all, false);
    expect(off.get(b)).toEqual([true, false]); // master gate off
  });
  it("all_visible_only: everyone visible, no occluded", () => {
    const m = computeQcVisibility("all_visible_only", b, all, true);
    for (const i of all) expect(m.get(i)).toEqual([true, false]);
  });
  it("all_plus_selected_invisible: all visible + selected's occluded", () => {
    const m = computeQcVisibility("all_plus_selected_invisible", b, all, true);
    expect(m.get(a)).toEqual([true, false]);
    expect(m.get(b)).toEqual([true, true]);
  });
  it("no valid selection falls back to the first instance (never blank)", () => {
    const m = computeQcVisibility("selected_only", null, all, true);
    expect(m.get(a)).toEqual([true, true]); // first instance becomes the target
    expect(m.get(b)).toEqual([false, false]);
  });
  it("stale selection (not in instances) falls back to the first instance", () => {
    const stale = { id: "z" } as unknown as Instance;
    const m = computeQcVisibility("selected_only", stale, all, true);
    expect(m.get(a)).toEqual([true, true]);
    expect(m.get(b)).toEqual([false, false]);
    expect(m.get(c)).toEqual([false, false]);
  });
  it("empty instances array yields an empty map without throwing", () => {
    const m = computeQcVisibility("selected_only", b, [], true);
    expect(m.size).toBe(0);
  });
  it("all_plus_selected_invisible with global gate off draws no occluded", () => {
    const m = computeQcVisibility("all_plus_selected_invisible", b, all, false);
    expect(m.get(a)).toEqual([true, false]);
    expect(m.get(b)).toEqual([true, false]); // master gate off
    expect(m.get(c)).toEqual([true, false]);
  });
  it("unknown mode falls back to all-visible for every instance", () => {
    const m = computeQcVisibility("bogus" as QcMode, b, all, true);
    for (const i of all) expect(m.get(i)).toEqual([true, false]);
  });
});
