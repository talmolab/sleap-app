/**
 * Unit tests for the browser save-target decision: overwrite the already-opened
 * file in place vs. prompt a Save-As dialog.
 */
import { describe, it, expect } from "../bun-test";
import { shouldOverwriteOpenedFile } from "@/lib/browserSaveTarget";

describe("shouldOverwriteOpenedFile", () => {
  it("overwrites in place for a plain Save when a handle is retained", () => {
    expect(
      shouldOverwriteOpenedFile({ forceDialog: false, hasHandle: true }),
    ).toBe(true);
  });

  it("always prompts for Save-As, even with a handle (user picks a new file)", () => {
    expect(
      shouldOverwriteOpenedFile({ forceDialog: true, hasHandle: true }),
    ).toBe(false);
  });

  it("prompts for a plain Save when no handle is retained (e.g. drag-drop open)", () => {
    expect(
      shouldOverwriteOpenedFile({ forceDialog: false, hasHandle: false }),
    ).toBe(false);
  });

  it("prompts for Save-As with no handle", () => {
    expect(
      shouldOverwriteOpenedFile({ forceDialog: true, hasHandle: false }),
    ).toBe(false);
  });
});
