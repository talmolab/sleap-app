/**
 * The incremental-autosave feature flag now defaults ON; only an explicit "0"
 * opts out. These lock that contract (the write path is also capability-gated
 * downstream, so an on-flag just means "use incremental where supported").
 */
import { describe, it, expect, afterEach } from "../bun-test";
import {
  isIncrementalAutosaveEnabled,
  INCREMENTAL_AUTOSAVE_FLAG_KEY,
} from "@/lib/autosaveFlags";

afterEach(() => {
  try {
    localStorage.removeItem(INCREMENTAL_AUTOSAVE_FLAG_KEY);
  } catch {
    /* ignore */
  }
});

describe("isIncrementalAutosaveEnabled", () => {
  it("defaults ON when the flag is unset", () => {
    localStorage.removeItem(INCREMENTAL_AUTOSAVE_FLAG_KEY);
    expect(isIncrementalAutosaveEnabled()).toBe(true);
  });

  it('stays ON for "1" (explicit opt-in)', () => {
    localStorage.setItem(INCREMENTAL_AUTOSAVE_FLAG_KEY, "1");
    expect(isIncrementalAutosaveEnabled()).toBe(true);
  });

  it('turns OFF only for an explicit "0"', () => {
    localStorage.setItem(INCREMENTAL_AUTOSAVE_FLAG_KEY, "0");
    expect(isIncrementalAutosaveEnabled()).toBe(false);
  });

  it("treats any other value as ON (not the opt-out sentinel)", () => {
    localStorage.setItem(INCREMENTAL_AUTOSAVE_FLAG_KEY, "off");
    expect(isIncrementalAutosaveEnabled()).toBe(true);
  });
});
