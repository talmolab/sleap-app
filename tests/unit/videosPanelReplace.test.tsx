/**
 * Tests for the Replace Video flow in the Videos panel (#161).
 *
 * Two layers:
 *  1. Button state (no mocks): the "Replace Video" button exists and is
 *     disabled until a video is current.
 *  2. Confirm + commit branch: we mock the decode boundary
 *     (`../../lib/resolveVideos` — `pickVideoFiles` / `buildStandaloneVideo`)
 *     so no real WebCodecs/Mp4Box decode runs (none exists under the bun test
 *     runner). The mocked `buildStandaloneVideo` returns a FRESH backend-less
 *     Video with a SHORT shape, so a labeled frame beyond it triggers the
 *     confirm-trim dialog; clicking "Replace" re-points labels to the new video.
 *
 * The real picker/decode path is exercised manually in E2E. The re-point/trim
 * data core is covered by Task 1's unit tests (replaceVideo.test.ts).
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  beforeAll,
  vi,
} from "../bun-test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useAppStore } from "@/stores/appStore";
import { Labels, LabeledFrame, Skeleton, Video } from "@talmolab/sleap-io.js";

// Mock platform so resolveVideos' getPlatform()/showOpenDialog never runs.
vi.mock("@/lib/platform", () => ({
  isTauri: false,
  isMac: false,
  modKey: "Ctrl",
}));

// Mock sonner toast (the panel toasts via @/lib/notify, which wraps sonner).
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

// Radix dialogs need ResizeObserver in the DOM shim.
beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

/** Reset the store between tests. */
function resetStore() {
  useAppStore.setState(useAppStore.getInitialState());
}

/**
 * Build a project with one backend-less video (long shape) and a labeled
 * frame at `labeledFrameIdx`, then load it into the store.
 */
function setupProject(opts?: {
  videoFrames?: number;
  labeledFrameIdx?: number;
}) {
  const videoFrames = opts?.videoFrames ?? 200;
  const labeledFrameIdx = opts?.labeledFrameIdx ?? 100;

  const skeleton = new Skeleton({ nodes: ["a"], name: "test" });
  const video = new Video({
    filename: "old.mp4",
    backendMetadata: { shape: [videoFrames, 480, 640, 3] },
    openBackend: false,
  });
  const labels = new Labels({ videos: [video], skeletons: [skeleton] });
  const lf = new LabeledFrame({ video, frameIdx: labeledFrameIdx });
  labels.labeledFrames.push(lf);
  labels.reindex();

  useAppStore.getState().setLabels(labels, "test.slp");
  return { labels, skeleton, video };
}

describe("VideosPanel — Replace Video button state", () => {
  beforeEach(() => {
    resetStore();
  });

  it("renders a disabled Replace Video button when no video is current", async () => {
    const { labels } = setupProject();
    // Clear the current video selection (setLabels auto-selected videos[0]).
    useAppStore.setState({ video: null });
    void labels;

    const { VideosPanel } = await import(
      "@/components/panels/VideosPanel"
    );
    render(<VideosPanel />);

    const btn = screen.getByRole("button", { name: "Replace Video" });
    expect(btn).toBeInTheDocument();
    expect(btn).toBeDisabled();
  });

  it("enables Replace Video once a video is current", async () => {
    setupProject();
    // setLabels selects videos[0] as the current video.
    const { VideosPanel } = await import(
      "@/components/panels/VideosPanel"
    );
    render(<VideosPanel />);

    const btn = screen.getByRole("button", { name: "Replace Video" });
    expect(btn).not.toBeDisabled();
  });
});

describe("VideosPanel — confirm + commit replacement", () => {
  beforeEach(() => {
    resetStore();
  });

  it("opens the trim-confirm dialog and re-points labels on Replace", async () => {
    // Current video has a labeled frame at idx 100; the new (mocked) video is
    // only 60 frames long, so that frame is orphaned -> confirm dialog.
    const { video: oldVideo } = setupProject({
      videoFrames: 200,
      labeledFrameIdx: 100,
    });
    // Park the playhead beyond the new video's length to check clamping.
    useAppStore.setState({ frameIdx: 150 });

    // FRESH backend-less new video with a SHORT shape (60 frames).
    const newVideo = new Video({
      filename: "new.mp4",
      backendMetadata: { shape: [60, 480, 640, 3] },
      openBackend: false,
    });

    // Mock ONLY the decode boundary; keep the rest of resolveVideos real.
    // The panel imports `../../lib/resolveVideos`, which resolves to the same
    // absolute module as `@/lib/resolveVideos`; bun keys mock.module by the
    // resolved path, so mocking the alias intercepts the panel's import too.
    const actual = await import("@/lib/resolveVideos");
    vi.mock("@/lib/resolveVideos", () => ({
      ...actual,
      pickVideoFiles: vi.fn(async () => [
        { file: new File([], "new.mp4"), absPath: null },
      ]),
      buildStandaloneVideo: vi.fn(async () => newVideo),
    }));

    const { VideosPanel } = await import(
      "@/components/panels/VideosPanel"
    );
    render(<VideosPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Replace Video" }));

    // Confirm dialog appears, mentioning the frames to be removed.
    await waitFor(() => {
      expect(screen.getByText("Replace video?")).toBeInTheDocument();
    });
    expect(screen.getByText(/will be removed/)).toBeInTheDocument();
    expect(screen.getByText(/60 frames/)).toBeInTheDocument();

    // Confirm the trim.
    const dialogReplace = screen
      .getAllByRole("button", { name: "Replace" })
      .at(-1)!;
    fireEvent.click(dialogReplace);

    await waitFor(() => {
      const vids = useAppStore.getState().labels!.videos;
      expect(vids).toContain(newVideo);
      expect(vids).not.toContain(oldVideo);
    });

    const s = useAppStore.getState();
    // The current video is the new one; the playhead is clamped to its length.
    expect(s.video).toBe(newVideo);
    expect(s.frameIdx).toBeLessThanOrEqual(59);
    // The orphaned labeled frame (idx 100, beyond 60) was trimmed.
    expect(s.labels!.labeledFrames.length).toBe(0);
  });
});
