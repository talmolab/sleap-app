/**
 * StatusBar: clicking the frame-number readout opens the Go to Frame dialog.
 *
 * Reuses the existing Ctrl+J / menu "Go to Frame" flow (GoToFrameDialog +
 * setFrameIdx, which already clamps) rather than a bespoke inline editor, so the
 * readout stays consistent with the shortcut and menu. This test asserts only
 * that the click flips the dialog-open store flag; the dialog's own
 * parse/clamp/navigate behaviour is covered by its own coverage.
 */
import { describe, it, expect, beforeEach, beforeAll } from "../bun-test";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { useAppStore } from "@/stores/appStore";
import { Labels, Skeleton, Video } from "@talmolab/sleap-io.js";

beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

function resetStore() {
  useAppStore.setState(useAppStore.getInitialState());
}

function loadProject() {
  const skeleton = new Skeleton({ nodes: ["a", "b"], name: "test" });
  const video = new Video({
    filename: "test.mp4",
    backendMetadata: { shape: [100, 480, 640, 3] },
    openBackend: false,
  });
  const labels = new Labels({ videos: [video], skeletons: [skeleton] });
  useAppStore.getState().setLabels(labels, "test.slp");
  useAppStore.getState().setVideo(video);
}

describe("StatusBar frame-number jump", () => {
  beforeEach(() => {
    cleanup();
    resetStore();
  });

  it("opens the Go to Frame dialog when the frame readout is clicked", async () => {
    loadProject();
    const { StatusBar } = await import("@/components/layout/StatusBar");
    render(<StatusBar />);
    expect(useAppStore.getState().goToFrameDialogOpen).toBe(false);
    fireEvent.click(screen.getByTitle(/go to frame/i));
    expect(useAppStore.getState().goToFrameDialogOpen).toBe(true);
  });
});
