/**
 * The UI around Merge Instance and the moved canvas bindings:
 *   - Instances panel: the first row picked stays selected, the second becomes
 *     Merge Instance's donor (legacy SLEAP's InstancesTableView).
 *   - Right-click ▸ Merge Instance with ▸ lists the frame's other user instances.
 *   - Help ▸ Keyboard Shortcuts lists the new keys and the canvas gestures.
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from "../bun-test";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { useAppStore } from "@/stores/appStore";
import {
  Labels,
  Instance,
  PredictedInstance,
  LabeledFrame,
  Skeleton,
  Video,
  Track,
} from "@talmolab/sleap-io.js";

vi.mock("@/lib/platform", () => ({ isTauri: false, isMac: false, modKey: "Ctrl" }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
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

const N = NaN;

/** Frame 0: three user instances (tracks A, B, untracked) and a prediction. */
function load() {
  const sk = new Skeleton({ nodes: ["a", "b"], name: "s" });
  const video = new Video({
    filename: "test.mp4",
    backendMetadata: { shape: [10, 480, 640, 3] },
    openBackend: false,
  });
  const trackA = new Track("A");
  const trackB = new Track("B");
  const i0 = Instance.fromArray([[10, 10], [N, N]], sk);
  i0.track = trackA;
  const i1 = Instance.fromArray([[N, N], [20, 20]], sk);
  i1.track = trackB;
  const i2 = Instance.fromArray([[N, N], [30, 30]], sk);
  const pred = PredictedInstance.fromArray([[5, 5], [6, 6]], sk);
  const lf = new LabeledFrame({ video, frameIdx: 0, instances: [i0, i1, i2, pred] });
  const labels = new Labels({
    labeledFrames: [lf],
    videos: [video],
    skeletons: [sk],
    tracks: [trackA, trackB],
  });
  useAppStore.setState({ labels, video, frameIdx: 0, labeledFrame: lf });
  return { lf, i0, i1, i2, pred };
}

describe("Instances panel picks", () => {
  beforeEach(() => {
    cleanup();
    useAppStore.setState(useAppStore.getInitialState());
  });

  async function renderPanel() {
    const { InstancesPanel } = await import("@/components/panels/InstancesPanel");
    render(<InstancesPanel />);
    // Data rows only (skip the header row).
    return () => screen.getAllByRole("row").slice(1);
  }

  it("keeps the first pick selected and makes the second the merge donor", async () => {
    const { i0, i2 } = load();
    const rows = await renderPanel();
    fireEvent.click(rows()[0]);
    expect(useAppStore.getState().instance).toBe(i0);
    expect(useAppStore.getState().mergePartner).toBeNull();

    fireEvent.click(rows()[2], { ctrlKey: true });
    expect(useAppStore.getState().instance).toBe(i0);
    expect(useAppStore.getState().mergePartner).toBe(i2);
    // Both rows stay highlighted (the selection effect no longer collapses it).
    expect(rows()[0].className).toContain("bg-orange");
    expect(rows()[2].className).toContain("bg-orange");
  });

  it("merges the picked rows with Labels ▸ Merge Instance", async () => {
    const { lf, i0, i1, i2, pred } = load();
    const rows = await renderPanel();
    fireEvent.click(rows()[0]);
    fireEvent.click(rows()[2], { ctrlKey: true });

    const { commandContext, MergeInstance } = await import("@/commands");
    await act(async () => {
      await commandContext.execute(MergeInstance);
    });
    expect(lf.instances).toEqual([i0, i1, pred]);
    expect(i0.points[1].xy).toEqual([30, 30]);
    void i2;
  });

  it("drops the donor when the pick goes back to one row", async () => {
    load();
    const rows = await renderPanel();
    fireEvent.click(rows()[0]);
    fireEvent.click(rows()[1], { ctrlKey: true });
    expect(useAppStore.getState().mergePartner).not.toBeNull();
    fireEvent.click(rows()[1]);
    expect(useAppStore.getState().mergePartner).toBeNull();
  });
});

describe("Right-click ▸ Merge Instance with", () => {
  beforeEach(() => {
    cleanup();
    useAppStore.setState(useAppStore.getInitialState());
  });

  async function openMenu() {
    const { ContextMenu } = await import("@/components/video/ContextMenu");
    render(
      <ContextMenu
        x={10}
        y={10}
        sceneLocation={[0, 0]}
        instanceIdx={0}
        nodeIdx={null}
        onClose={() => {}}
      />,
    );
  }

  it("lists the other user instances, by track or index, and merges the one picked", async () => {
    const { lf, i0, i1, pred } = load();
    useAppStore.getState().setInstance(i0);
    await openMenu();

    fireEvent.click(screen.getByText("Merge Instance with"));
    expect(screen.getByText("Track: B")).toBeInTheDocument();
    expect(screen.getByText("Instance 2")).toBeInTheDocument();
    // Not the selected instance itself, and never a prediction.
    expect(screen.queryByText("Track: A")).toBeNull();
    expect(screen.queryByText("Instance 3")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByText("Track: B"));
    });
    expect(lf.instances).toEqual([i0, lf.instances[1], pred]);
    expect(lf.instances).not.toContain(i1);
    expect(i0.points[1].xy).toEqual([20, 20]);
  });

  it("isn't offered for a prediction", async () => {
    const { pred } = load();
    useAppStore.getState().setInstance(pred);
    await openMenu();
    expect(screen.queryByText("Merge Instance with")).toBeNull();
  });
});

describe("Help ▸ Keyboard Shortcuts", () => {
  beforeEach(() => cleanup());

  it("lists Merge Instance (Shift+M), Shift+A and the canvas gestures", async () => {
    const { ShortcutsDialog } = await import("@/components/dialogs/ShortcutsDialog");
    render(<ShortcutsDialog open={true} onOpenChange={() => {}} />);

    const row = (label: string) => screen.getByText(label).closest("tr")!;
    expect(row("merge instance").textContent).toContain("Shift+M");
    expect(row("select instance nodes").textContent).toContain("Shift+A");

    expect(screen.getByText("Canvas gestures")).toBeInTheDocument();
    expect(row("Mark the whole instance complete").textContent).toContain("Shift");
    expect(row("Add or remove it from the selection").textContent).toContain("Alt+Shift");
    expect(screen.getByText("Add its missing nodes")).toBeInTheDocument();
    expect(screen.getByText("Accept it, every node complete")).toBeInTheDocument();
  });
});
