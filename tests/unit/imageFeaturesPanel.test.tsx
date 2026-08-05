/**
 * Render tests for the Suggestions panel's image-features controls.
 *
 * Uses the panel's `initialMethod` test seam to mount directly into the
 * image_features method (avoids driving the Radix <Select> popover, unreliable
 * in happy-dom). Asserts the parameter form, output-count hint, seed + reroll,
 * the Advanced disclosure, and the ROI region button. The clustering flow
 * itself (decode + Worker) is covered by E2E, not here.
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from "../bun-test";
import {
  render,
  screen,
  fireEvent,
  cleanup,
} from "@testing-library/react";
import { useAppStore } from "@/stores/appStore";
import { Labels, Skeleton, Video } from "@talmolab/sleap-io.js";

vi.mock("@/lib/platform", () => ({ isTauri: false, isMac: false, modKey: "Ctrl" }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

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

function makeProject() {
  const skeleton = new Skeleton({ nodes: ["a", "b"], name: "test" });
  const video = new Video({
    filename: "test.mp4",
    backendMetadata: { shape: [100, 480, 640, 3] },
    openBackend: false,
  });
  const labels = new Labels({ videos: [video], skeletons: [skeleton] });
  return { labels, skeleton, video };
}

async function mountImageFeatures() {
  const { labels, video } = makeProject();
  useAppStore.getState().setLabels(labels, "test.slp");
  useAppStore.getState().setVideo(video);
  const { SuggestionsPanel } = await import(
    "@/components/panels/SuggestionsPanel"
  );
  return render(<SuggestionsPanel initialMethod="image_features" />);
}

describe("SuggestionsPanel image-features controls", () => {
  beforeEach(() => {
    cleanup();
    resetStore();
  });

  it("renders the parameter form with PyQt defaults", async () => {
    await mountImageFeatures();
    expect((screen.getByLabelText("Sample count") as HTMLInputElement).value).toBe("200");
    expect((screen.getByLabelText("Clusters") as HTMLInputElement).value).toBe("5");
    expect((screen.getByLabelText("Frames per cluster") as HTMLInputElement).value).toBe("5");
    expect(screen.getByLabelText("Seed")).toBeInTheDocument();
  });

  it("shows the output-count hint (clusters x frames-per-cluster)", async () => {
    await mountImageFeatures();
    // 5 clusters x 5 per cluster = 25.
    expect(screen.getByText(/≈\s*25\b/)).toBeInTheDocument();
  });

  it("recomputes the output-count hint when clusters change", async () => {
    await mountImageFeatures();
    fireEvent.change(screen.getByLabelText("Clusters"), { target: { value: "4" } });
    // 4 x 5 = 20.
    expect(screen.getByText(/≈\s*20\b/)).toBeInTheDocument();
  });

  it("has a reroll button that changes the seed value", async () => {
    await mountImageFeatures();
    const seed = screen.getByLabelText("Seed") as HTMLInputElement;
    const before = seed.value;
    fireEvent.click(screen.getByRole("button", { name: /reroll/i }));
    expect((screen.getByLabelText("Seed") as HTMLInputElement).value).not.toBe(before);
  });

  it("hides PCA components until Advanced is expanded", async () => {
    await mountImageFeatures();
    expect(screen.queryByLabelText("PCA components")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /advanced/i }));
    expect((screen.getByLabelText("PCA components") as HTMLInputElement).value).toBe("5");
  });

  it("offers a Set region button for the ROI crop tool", async () => {
    await mountImageFeatures();
    expect(screen.getByRole("button", { name: /set region/i })).toBeInTheDocument();
  });

  it("clears ROI draw-mode AND the drawn region when the panel unmounts", async () => {
    const { unmount } = await mountImageFeatures();
    const video = useAppStore.getState().video!;
    // Draw a region + enter draw-mode, then leave the panel entirely (close /
    // collapse / hide / single-panel switch all unmount the body).
    useAppStore.getState().setImageFeatureRoi(video, { x: 0, y: 0, width: 10, height: 10 });
    fireEvent.click(screen.getByRole("button", { name: /set region/i }));
    expect(useAppStore.getState().imageFeatureRoiDrawActive).toBe(true);
    expect(useAppStore.getState().imageFeatureRois.size).toBe(1);
    unmount();
    expect(useAppStore.getState().imageFeatureRoiDrawActive).toBe(false);
    expect(useAppStore.getState().imageFeatureRois.size).toBe(0);
  });

  it("clears a stale ROI when the panel is showing a non-Image-Features method", async () => {
    // Reproduces the "Allow Multiple Panels" / method-change leak: the panel is
    // still mounted (never unmounts) but the active method is no longer
    // image_features, so the ROI tool must be off and the region gone.
    const { labels, video } = makeProject();
    useAppStore.getState().setLabels(labels, "test.slp");
    useAppStore.getState().setVideo(video);
    useAppStore.getState().setImageFeatureRoiDrawActive(true);
    useAppStore.getState().setImageFeatureRoi(video, { x: 0, y: 0, width: 10, height: 10 });
    const { SuggestionsPanel } = await import("@/components/panels/SuggestionsPanel");
    render(<SuggestionsPanel initialMethod="stride" />);
    expect(useAppStore.getState().imageFeatureRoiDrawActive).toBe(false);
    expect(useAppStore.getState().imageFeatureRois.size).toBe(0);
  });

  it("resetImageFeatureRoi clears both draw-mode and all regions", async () => {
    const { video } = makeProject();
    useAppStore.getState().setImageFeatureRoiDrawActive(true);
    useAppStore.getState().setImageFeatureRoi(video, { x: 1, y: 2, width: 3, height: 4 });
    useAppStore.getState().resetImageFeatureRoi();
    expect(useAppStore.getState().imageFeatureRoiDrawActive).toBe(false);
    expect(useAppStore.getState().imageFeatureRois.size).toBe(0);
  });
});
