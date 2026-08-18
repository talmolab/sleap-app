/**
 * Regression test: the Instances panel must reflect a track assignment
 * immediately.
 *
 * Track-mutating commands (AddTrack, SetInstanceTrack, SetTrackName) change
 * `instance.track` IN PLACE and only bump the `editSeq` edit counter — they do
 * NOT swap the `labels`/`instance` reference the panel selects on. The panel
 * therefore has to subscribe to `editSeq` to re-render; without that it only
 * updates by luck via some other component's incidental re-render, and NOT at
 * all on a frame with no such repaint (the user-reported case: a frame marked
 * Negative, then Tracks ▸ New Track — the assignment stuck in the model but the
 * panel kept showing "[no track]" until you left and re-entered the panel).
 *
 * With only InstancesPanel mounted (no canvas), there is no incidental render,
 * so this fails without the editSeq subscription regardless of the flag.
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from "../bun-test";
import { render, screen, cleanup, act, within, waitFor } from "@testing-library/react";
import { useAppStore } from "@/stores/appStore";
import { commandContext } from "@/commands/CommandContext";
import { AddTrack } from "@/commands/trackCommands";
import { ToggleNegativeFrame } from "@/commands/editCommands";
import {
  Labels,
  Instance,
  LabeledFrame,
  Skeleton,
  Video,
} from "@talmolab/sleap-io.js";

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

function loadTwoInstanceFrame() {
  const skeleton = new Skeleton({ nodes: ["a", "b"], name: "test" });
  const video = new Video({
    filename: "test.mp4",
    backendMetadata: { shape: [100, 480, 640, 3] },
    openBackend: false,
  });
  const inst0 = Instance.fromArray([[10, 10], [20, 20]], skeleton);
  const inst1 = Instance.fromArray([[30, 30], [40, 40]], skeleton);
  const lf = new LabeledFrame({ video, frameIdx: 0 });
  lf.instances = [inst0, inst1];
  const labels = new Labels({ videos: [video], skeletons: [skeleton] });
  labels.append(lf);
  useAppStore.setState({ labels, video, frameIdx: 0 });
  return { labels, video, skeleton, inst0, inst1 };
}

describe("InstancesPanel reflects a track assignment immediately", () => {
  beforeEach(() => {
    cleanup();
    resetStore();
  });

  it("Tracks ▸ New Track updates the row without a remount", async () => {
    const { inst0 } = loadTwoInstanceFrame();
    // Pre-select the instance BEFORE rendering. This is what isolates the bug:
    // AddTrack then only mutates `instance.track` in place + bumps `editSeq`; it
    // does NOT change the `instance`/`labels` reference the panel selects on, so
    // the re-render can only come from the editSeq subscription (not from an
    // incidental instance-ref change).
    useAppStore.setState({ instance: inst0 });
    const { InstancesPanel } = await import("@/components/panels/InstancesPanel");
    render(<InstancesPanel />);

    expect(within(screen.getAllByRole("row")[1]).getByText("[no track]")).toBeInTheDocument();

    await act(async () => {
      await commandContext.execute(AddTrack);
    });

    // The panel re-renders: the selected instance's row now shows the new track.
    await waitFor(() =>
      expect(within(screen.getAllByRole("row")[1]).getByText("Track 1")).toBeInTheDocument(),
    );
    // The other row is untouched.
    expect(within(screen.getAllByRole("row")[2]).getByText("[no track]")).toBeInTheDocument();
  });

  it("still updates after the frame is marked Negative (the reported case)", async () => {
    const { inst0 } = loadTwoInstanceFrame();
    // Reach the exact reported state up front (frame negative, instance selected)
    // so AddTrack's in-place mutation is the sole re-render trigger.
    await act(async () => {
      await commandContext.execute(ToggleNegativeFrame); // frame → negative
    });
    expect(useAppStore.getState().labeledFrame?.isNegative).toBe(true);
    useAppStore.setState({ instance: inst0 });

    const { InstancesPanel } = await import("@/components/panels/InstancesPanel");
    render(<InstancesPanel />);
    expect(within(screen.getAllByRole("row")[1]).getByText("[no track]")).toBeInTheDocument();

    await act(async () => {
      await commandContext.execute(AddTrack);
    });

    await waitFor(() =>
      expect(within(screen.getAllByRole("row")[1]).getByText("Track 1")).toBeInTheDocument(),
    );
  });
});
