/**
 * "Reset view" control on the receptive-field preview thumbnail.
 *
 * ModelStatsPreview lets the user zoom (wheel) and drag-pan the preview canvas.
 * These tests lock in the reset affordance: a compact "Reset view" button that
 * restores the default view (zoom = 1, pan = {x:0,y:0}). The button's local
 * state is per-instance, so the control acts only on its own preview.
 *
 * The 2D canvas draw effect no-ops here (happy-dom's `getContext("2d")` returns
 * null, so the component's `if (!ctx) return;` guard short-circuits), which lets
 * us render the real component without stubbing the canvas.
 */

import { describe, it, expect, afterEach } from "../bun-test";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ModelStatsPreview } from "@/components/dialogs/ModelStatsPreview";
import { defaultHyperparams } from "@/stores/trainingStore";

afterEach(() => cleanup());

function renderPreview(slot = "centroid") {
  return render(
    <ModelStatsPreview
      hp={{ ...defaultHyperparams }}
      maxStride={16}
      filters={16}
      filtersRate={1.5}
      outputStride={2}
      stemStride={null}
      backbone="unet"
      inputChannels={1}
      slot={slot}
    />
  );
}

describe("ModelStatsPreview reset view", () => {
  it("renders a 'Reset view' button", () => {
    renderPreview();
    expect(screen.getByRole("button", { name: "Reset view" })).toBeInTheDocument();
  });

  it("is disabled at the default view and re-enables after zooming", () => {
    renderPreview();
    const btn = screen.getByRole("button", { name: "Reset view" });
    // Default view (zoom 1, pan 0,0): nothing to reset.
    expect(btn).toBeDisabled();

    // A wheel-up zoom moves the view off default -> button becomes actionable.
    const canvas = document.querySelector("canvas")!;
    fireEvent.wheel(canvas, { deltaY: -100 });
    expect(btn).not.toBeDisabled();
  });

  it("clicking restores the default view (button disables again)", () => {
    renderPreview();
    const btn = screen.getByRole("button", { name: "Reset view" });
    const canvas = document.querySelector("canvas")!;

    // Zoom away from default so the reset has an effect.
    fireEvent.wheel(canvas, { deltaY: -100 });
    expect(btn).not.toBeDisabled();

    // Reset -> back to default -> button reflects the default state.
    fireEvent.click(btn);
    expect(btn).toBeDisabled();
  });
});

describe("ModelStatsPreview remote frame", () => {
  it("asks remoteFrame for the first user-labeled frame when its video can't be decoded here", async () => {
    const video = { filename: "/data/v.mp4", backend: null };
    const labels = {
      videos: [{ filename: "/other.mp4", backend: null }, video],
      skeletons: [],
      labeledFrames: [
        { video, frameIdx: 3, instances: [{ score: 0.9, points: [] }], userInstances: [] },
        { video, frameIdx: 11, instances: [{ points: [] }], userInstances: [] },
      ],
    };
    const calls: Array<[number, number]> = [];
    render(
      <ModelStatsPreview
        hp={{ ...defaultHyperparams }}
        maxStride={16}
        filters={16}
        filtersRate={1.5}
        outputStride={2}
        stemStride={null}
        backbone="unet"
        slot="centroid"
        labels={labels as never}
        remoteFrame={async (videoIndex, frameIdx) => {
          calls.push([videoIndex, frameIdx]);
          throw new Error("Video not found on the worker");
        }}
      />
    );
    await new Promise((r) => setTimeout(r, 0));
    // Frame 3 has only a predicted instance; frame 11 is the first user-labeled one.
    expect(calls).toEqual([[1, 11]]);
  });
});
