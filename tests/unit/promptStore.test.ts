/**
 * Unit tests for the promise-based in-app text-input prompt (the styled
 * replacement for window.prompt, which is broken in the Tauri WebView). Drives
 * the real store — no mocks.
 */
import { describe, it, expect } from "../bun-test";
import { promptDialog, usePromptStore } from "@/stores/promptStore";

describe("promptDialog", () => {
  it("shows the in-app prompt and resolves the entered text when confirmed", async () => {
    usePromptStore.setState({ request: null });

    const pending = promptDialog({
      message: "Select to frame number:",
      defaultValue: "10",
    });

    const req = usePromptStore.getState().request;
    expect(req).not.toBeNull();
    expect(req?.message).toContain("Select to frame number:");
    expect(req?.defaultValue).toBe("10");

    usePromptStore.getState().respond("42");
    expect(await pending).toBe("42");
  });

  it("resolves null when the user cancels", async () => {
    usePromptStore.setState({ request: null });

    const pending = promptDialog({ message: "Select to frame number:" });
    expect(usePromptStore.getState().request).not.toBeNull();

    usePromptStore.getState().respond(null);
    expect(await pending).toBeNull();
    // Modal dismissed.
    expect(usePromptStore.getState().request).toBeNull();
  });

  it("supersedes a pending prompt (resolves the prior one null)", async () => {
    usePromptStore.setState({ request: null });

    const first = promptDialog({ message: "First:" });
    const second = promptDialog({ message: "Second:" });

    expect(await first).toBeNull();
    usePromptStore.getState().respond("done");
    expect(await second).toBe("done");
  });
});
