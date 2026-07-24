/**
 * Unit tests for the pure parts of the unsaved-work discard guard: the
 * predicate that decides whether replacing the project would lose work, and the
 * confirm-dialog message. (The confirm/removeWorkingCopy glue reads the store +
 * window.confirm + OPFS and is exercised via the app, not here.)
 */
import { describe, it, expect } from "../bun-test";
import { hasUnsavedWork, discardPromptMessage } from "@/lib/unsavedGuard";

describe("hasUnsavedWork", () => {
  it("is false only when there are no in-memory edits and nothing pending export", () => {
    expect(
      hasUnsavedWork({ hasChanges: false, workingCopyPendingExport: false }),
    ).toBe(false);
  });

  it("is true when there are in-memory edits", () => {
    expect(
      hasUnsavedWork({ hasChanges: true, workingCopyPendingExport: false }),
    ).toBe(true);
  });

  it("is true when a working copy has edits saved locally but not yet exported", () => {
    expect(
      hasUnsavedWork({ hasChanges: false, workingCopyPendingExport: true }),
    ).toBe(true);
  });
});

describe("discardPromptMessage", () => {
  it("warns about in-memory unsaved changes when nothing is pending export", () => {
    const m = discardPromptMessage({
      workingCopyPendingExport: false,
      verb: "Opening a new project",
    });
    expect(m).toContain("unsaved changes");
    expect(m).toContain("Opening a new project");
  });

  it("warns that browser-saved edits are not yet on disk when a copy is pending export", () => {
    const m = discardPromptMessage({
      workingCopyPendingExport: true,
      verb: "Creating a new project",
    });
    expect(m).toContain("not yet written to disk");
    expect(m).toContain("Creating a new project");
  });
});
