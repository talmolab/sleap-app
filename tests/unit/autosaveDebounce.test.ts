/**
 * The autosave draft write re-serializes the WHOLE project (no incremental
 * save), so on a large project it's a multi-second main-thread block. Firing it
 * 1.5s after every edit-pause froze active editing (the freeze that "lands on the
 * next click"). The debounce is scaled to the project's serialize cost so a huge
 * project only autosaves when genuinely idle, while small ones stay snappy.
 */

import { describe, it, expect } from "../bun-test";
import {
  computeAutosaveDebounceMs,
  AUTOSAVE_MIN_DEBOUNCE_MS,
  AUTOSAVE_MAX_DEBOUNCE_MS,
} from "@/lib/autosaveDebounce";

describe("computeAutosaveDebounceMs", () => {
  it("keeps the snappy floor for a small project with no prior write", () => {
    expect(computeAutosaveDebounceMs(100, 0)).toBe(AUTOSAVE_MIN_DEBOUNCE_MS);
  });

  it("backs off for a large project even BEFORE the first write (frame-count estimate)", () => {
    // The user's 'lagging even from the first drag': the first edit has no
    // measured write yet, so the estimate must come from project size.
    const d = computeAutosaveDebounceMs(42250, 0);
    expect(d).toBeGreaterThan(15000); // ~19s, not 1.5s
    expect(d).toBeLessThanOrEqual(AUTOSAVE_MAX_DEBOUNCE_MS);
  });

  it("backs off from a slow measured write even for a small frame count", () => {
    expect(computeAutosaveDebounceMs(100, 2000)).toBe(20000);
  });

  it("never exceeds the cap", () => {
    expect(computeAutosaveDebounceMs(42250, 10000)).toBe(AUTOSAVE_MAX_DEBOUNCE_MS);
  });

  it("never drops below the floor", () => {
    expect(computeAutosaveDebounceMs(0, 0)).toBe(AUTOSAVE_MIN_DEBOUNCE_MS);
  });
});
