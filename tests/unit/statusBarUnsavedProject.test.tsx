/**
 * StatusBar project-state label tests:
 * - No project loaded (`labels === null && filename === null`) -> "No project loaded",
 *   no SLP format pill.
 * - Project in memory with no saved filename (`labels !== null && !filename`) ->
 *   "Unsaved project" (with " *" when `hasChanges`), full project stats, and the
 *   SLP format status pill.
 * - Saved project (`filename` set) -> filename (with " *" when `hasChanges`).
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll } from "../bun-test";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { useAppStore } from "@/stores/appStore";
import { Instance, Labels, LabeledFrame, Skeleton, Video } from "@talmolab/sleap-io.js";
import { resetFormat3UpgradeTracking } from "@/lib/slpFormatStatus";

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

function makeUnsavedProject() {
  const skeleton = new Skeleton({ nodes: ["head", "tail"], name: "animal" });
  const video = new Video({
    filename: "clip.mp4",
    backendMetadata: { shape: [100, 480, 640, 3] },
    openBackend: false,
  });
  const labels = new Labels({ videos: [video], skeletons: [skeleton] });
  useAppStore.getState().setLabels(labels, undefined);
  useAppStore.getState().setVideo(video);
  useAppStore.getState().setFrameIdx(0);
  return { skeleton, video, labels };
}

describe("StatusBar unsaved project state", () => {
  beforeEach(() => {
    cleanup();
    resetStore();
  });

  afterEach(cleanup);

  it("shows 'No project loaded' and hides the format pill when no project is loaded", async () => {
    const { StatusBar } = await import("@/components/layout/StatusBar");
    render(<StatusBar />);

    expect(screen.getByText("No project loaded")).toBeInTheDocument();
    expect(screen.queryByText(/Unsaved project/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("status-slp-format-pill")).not.toBeInTheDocument();
  });

  it("shows 'Unsaved project', project stats, and format pill for a new unsaved project", async () => {
    makeUnsavedProject();
    const { StatusBar } = await import("@/components/layout/StatusBar");
    render(<StatusBar />);

    expect(screen.getByText("Unsaved project")).toBeInTheDocument();
    expect(screen.queryByText("No project loaded")).not.toBeInTheDocument();
    expect(screen.getByText("Video 1 / 1")).toBeInTheDocument();
    expect(screen.getByText("Frame 0 / 99")).toBeInTheDocument();
    expect(screen.getByText("Labeled: 0")).toBeInTheDocument();
    expect(screen.getByTestId("status-slp-format-pill").textContent).toBe("SLP 2.x");
  });

  it("appends '*' when an unsaved project has changes and transitions to filename once saved", async () => {
    makeUnsavedProject();
    const { StatusBar } = await import("@/components/layout/StatusBar");
    render(<StatusBar />);

    act(() => {
      useAppStore.getState().markChanged();
    });
    expect(screen.getByText("Unsaved project *")).toBeInTheDocument();

    act(() => {
      useAppStore.getState().set("filename", "experiment.slp");
      useAppStore.getState().clearChanges();
    });
    expect(screen.getByText("experiment.slp")).toBeInTheDocument();
    expect(screen.queryByText(/Unsaved project/)).not.toBeInTheDocument();
  });

  it("falls back to 'Unsaved project' if filename is an empty string while labels exist", async () => {
    makeUnsavedProject();
    useAppStore.getState().set("filename", "");
    const { StatusBar } = await import("@/components/layout/StatusBar");
    render(<StatusBar />);

    expect(screen.getByText("Unsaved project")).toBeInTheDocument();
    expect(screen.queryByText("No project loaded")).not.toBeInTheDocument();
  });

  it("shows the SLP 3.0 format popover copy cleanly for an unsaved project with format 3.0 features", async () => {
    const { skeleton, video, labels } = makeUnsavedProject();
    resetFormat3UpgradeTracking(labels);
    const inst = Instance.empty({ skeleton });
    inst.points[0].xy = [10, 20];
    inst.points[0].visible = true;
    inst.points[0].complete = true;
    inst.points[1].xy = [NaN, NaN];
    inst.points[1].visible = false;
    inst.points[1].complete = false;
    (inst.points[1] as { labeled?: boolean }).labeled = false;
    labels.append(new LabeledFrame({ video, frameIdx: 0, instances: [inst] }));
    useAppStore.getState().markChanged();

    const { StatusBar } = await import("@/components/layout/StatusBar");
    render(<StatusBar />);

    const pill = screen.getByTestId("status-slp-format-pill");
    expect(pill.textContent).toBe("SLP 3.0 (pending save)");
    fireEvent.click(pill);
    const popover = await screen.findByTestId("status-slp-format-popover");
    expect(popover.textContent).toContain("Saving will use SLP format 3.0.");
    expect(popover.textContent).not.toContain("Opened from SLP 2.x");
  });
});
