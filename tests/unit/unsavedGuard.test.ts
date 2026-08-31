/**
 * Unit tests for the pure parts of the unsaved-work discard guard: the
 * predicate that decides whether replacing the project would lose work, and the
 * confirm-dialog message. (The confirm/removeWorkingCopy glue reads the store +
 * window.confirm + OPFS and is exercised via the app, not here.)
 */
import { describe, it, expect } from "../bun-test";
import {
  hasUnsavedWork,
  discardPromptMessage,
  confirmDiscardUnsavedWork,
} from "@/lib/unsavedGuard";
import { useAppStore } from "@/stores/appStore";
import { useConfirmStore } from "@/stores/confirmStore";

describe("hasUnsavedWork", () => {
  it("is false only when there are no in-memory edits and nothing pending export", () => {
    expect(hasUnsavedWork({ hasChanges: false, pendingExport: false })).toBe(
      false,
    );
  });

  it("is true when there are in-memory edits", () => {
    expect(hasUnsavedWork({ hasChanges: true, pendingExport: false })).toBe(
      true,
    );
  });

  it("is true when a labels draft is saved locally but not yet exported", () => {
    expect(hasUnsavedWork({ hasChanges: false, pendingExport: true })).toBe(
      true,
    );
  });
});

describe("discardPromptMessage", () => {
  it("warns about in-memory unsaved changes when nothing is pending export", () => {
    const m = discardPromptMessage({
      pendingExport: false,
      verb: "Opening a new project",
    });
    expect(m).toContain("unsaved changes");
    expect(m).toContain("Opening a new project");
  });

  it("warns that browser-saved edits are not yet on disk when pending export", () => {
    const m = discardPromptMessage({
      pendingExport: true,
      verb: "Creating a new project",
    });
    expect(m).toContain("not yet exported to disk");
    expect(m).toContain("Creating a new project");
  });
});

describe("confirmDiscardUnsavedWork (async, in-app dialog — not window.confirm)", () => {
  it("resolves true without prompting when there is no unsaved work", async () => {
    useAppStore.setState({
      hasChanges: false,
      pendingExport: false,
      labelsDraftPath: null,
    });
    useConfirmStore.setState({ request: null });

    const result = await confirmDiscardUnsavedWork("Opening a new project");

    expect(result).toBe(true);
    // No modal should have been shown.
    expect(useConfirmStore.getState().request).toBeNull();
  });

  it("shows the in-app confirm modal and resolves true when the user confirms", async () => {
    useAppStore.setState({
      hasChanges: true,
      pendingExport: false,
      labelsDraftPath: null,
    });
    useConfirmStore.setState({ request: null });

    const pending = confirmDiscardUnsavedWork("Opening a new project");

    // The styled in-app modal is up (proving we did NOT call window.confirm).
    const req = useConfirmStore.getState().request;
    expect(req).not.toBeNull();
    expect(req?.message).toContain("Opening a new project");

    // User clicks the confirm button.
    useConfirmStore.getState().respond(true);
    expect(await pending).toBe(true);
  });

  it("resolves false when the user cancels the in-app modal", async () => {
    useAppStore.setState({
      hasChanges: true,
      pendingExport: false,
      labelsDraftPath: null,
    });
    useConfirmStore.setState({ request: null });

    const pending = confirmDiscardUnsavedWork("Importing a file");
    expect(useConfirmStore.getState().request).not.toBeNull();

    useConfirmStore.getState().respond(false);
    expect(await pending).toBe(false);
  });
});
