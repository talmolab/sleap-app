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
