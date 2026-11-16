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
  runReadsStaleProjectFile,
  confirmSaveBeforeRun,
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

// Local sleap-nn training/inference reads the labels FILE from disk, so a run
// started with unsaved edits silently used the last saved labels.
describe("runReadsStaleProjectFile", () => {
  const project = "/data/flies.slp";

  it("is true when the run reads the open project and it has unsaved edits", () => {
    expect(runReadsStaleProjectFile({ labelsPath: project, projectPath: project, hasChanges: true })).toBe(true);
  });

  it("is false with no unsaved edits", () => {
    expect(runReadsStaleProjectFile({ labelsPath: project, projectPath: project, hasChanges: false })).toBe(false);
  });

  it("is false for a never-saved project (it gets serialized fresh for the run)", () => {
    expect(runReadsStaleProjectFile({ labelsPath: null, projectPath: null, hasChanges: true })).toBe(false);
  });

  it("is false when the run reads a separately picked labels file", () => {
    expect(runReadsStaleProjectFile({ labelsPath: "/data/other.slp", projectPath: project, hasChanges: true })).toBe(false);
  });
});

describe("confirmSaveBeforeRun", () => {
  const project = "/data/flies.slp";

  it("proceeds without prompting when the project file is current", async () => {
    useAppStore.setState({ hasChanges: false, projectPath: project });
    useConfirmStore.setState({ request: null });
    expect(await confirmSaveBeforeRun(project, "training")).toBe(true);
    expect(useConfirmStore.getState().request).toBeNull();
  });

  it("offers Save and Continue when the run would read a stale file; Cancel stops the run", async () => {
    useAppStore.setState({ hasChanges: true, projectPath: project });
    useConfirmStore.setState({ request: null });

    const pending = confirmSaveBeforeRun(project, "inference");
    const req = useConfirmStore.getState().request;
    expect(req?.confirmLabel).toBe("Save and Continue");
    expect(req?.message).toContain("Inference reads the saved project file");

    useConfirmStore.getState().respond(false);
    expect(await pending).toBe(false);
    // Nothing was saved.
    expect(useAppStore.getState().hasChanges).toBe(true);
  });
});
