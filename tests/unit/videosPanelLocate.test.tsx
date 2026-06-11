/**
 * Tests for the Videos panel's missing-video Locate affordances (ImageVideo
 * Slice 2).
 *
 * A missing video's row renders one of three controls depending on whether it's
 * an image sequence and whether we're on desktop. These tests cover the two
 * branches reachable in the bun/jsdom test env, where `isTauri` is false (no
 * `__TAURI__` global), i.e. the browser experience:
 *
 *   - missing IMAGE SEQUENCE  -> inline "open in desktop app" hint, NO button
 *     (folder resolution is desktop-only this slice).
 *   - missing REGULAR video   -> the existing "Locate" video-file button.
 *
 * The desktop "Locate folder…" button + the actual folder-pick → backend
 * rebuild → frame render path needs a real Tauri dialog and a real image decode
 * (neither runs under the bun test runner), so it's exercised in manual E2E.
 *
 * No platform/decode mocks are needed: rendering a missing row touches neither
 * getPlatform() nor any decoder.
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from "../bun-test";
import { render, screen } from "@testing-library/react";
import { useAppStore } from "@/stores/appStore";
import { Labels, Skeleton, Video } from "@talmolab/sleap-io.js";

// Mock sonner (the panel toasts via @/lib/notify, which wraps sonner) so the
// import graph never reaches the real toaster.
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

// Radix-based UI in the panel expects ResizeObserver in the DOM shim.
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

/**
 * Load a one-video project whose single (backend-less => missing) video has the
 * given filename, and return it. `openBackend:false` leaves `backend === null`,
 * so `isVideoMissing` is true; the filename's extension decides whether it's an
 * image sequence.
 */
function loadProjectWithVideo(filename: string, shape: number[]) {
  const skeleton = new Skeleton({ nodes: ["a"], name: "test" });
  const video = new Video({
    filename,
    backendMetadata: { shape },
    openBackend: false,
  });
  const labels = new Labels({ videos: [video], skeletons: [skeleton] });
  labels.reindex();
  useAppStore.getState().setLabels(labels, "test.slp");
  return video;
}

describe("VideosPanel — missing image-sequence (browser)", () => {
  beforeEach(() => resetStore());

  it("shows an 'open in desktop app' hint and no Locate button", async () => {
    loadProjectWithVideo("frame.png", [3, 384, 384, 3]);

    const { VideosPanel } = await import("@/components/panels/VideosPanel");
    render(<VideosPanel />);

    // The inline hint is present...
    expect(screen.getByText(/image sequence/i)).toBeInTheDocument();
    // ...and neither Locate control is offered (desktop-only).
    expect(
      screen.queryByRole("button", { name: /Locate folder/i })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Locate$/i })
    ).not.toBeInTheDocument();
    // "Locate All Missing" excludes image sequences, so it's hidden too.
    expect(
      screen.queryByRole("button", { name: /Locate All Missing/i })
    ).not.toBeInTheDocument();
  });
});

describe("VideosPanel — missing regular video", () => {
  beforeEach(() => resetStore());

  it("shows the 'Locate' video-file button and no image-sequence hint", async () => {
    loadProjectWithVideo("clip.mp4", [200, 480, 640, 3]);

    const { VideosPanel } = await import("@/components/panels/VideosPanel");
    render(<VideosPanel />);

    expect(
      screen.getByRole("button", { name: /^Locate$/i })
    ).toBeInTheDocument();
    expect(screen.queryByText(/image sequence/i)).not.toBeInTheDocument();
    // A regular missing video IS handled by "Locate All Missing".
    expect(
      screen.getByRole("button", { name: /Locate All Missing/i })
    ).toBeInTheDocument();
  });
});
