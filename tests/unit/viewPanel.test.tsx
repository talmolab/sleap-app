/**
 * ViewPanel tests: verifies all visual settings (including those moved out of
 * the streamlined View menu) are exposed and wired to appStore.
 */
import { describe, it, expect, beforeEach, beforeAll, afterEach } from "../bun-test";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Skeleton } from "@talmolab/sleap-io.js";
import { useAppStore } from "@/stores/appStore";
import { ViewPanel } from "@/components/panels/ViewPanel";

beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
});

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
});

afterEach(() => {
  cleanup();
});

describe("ViewPanel controls", () => {
  it("toggles overlay, style, and trail checkboxes moved from the View menu", () => {
    render(<ViewPanel />);

    const cases = [
      ["Show track scores", "showTrackScore"],
      ["Show mean node score", "showMeanNodeScore"],
      ["Bold lines", "boldLines"],
      ["Crosshair when zoomed", "showCrosshair"],
      ["Fade older trail segments", "trailFade"],
    ] as const;

    for (const [label, key] of cases) {
      const before = useAppStore.getState()[key];
      const checkbox = screen.getByLabelText(label) as HTMLInputElement;
      expect(checkbox.checked).toBe(before);
      fireEvent.click(checkbox);
      expect(useAppStore.getState()[key]).toBe(!before);
      expect(checkbox.checked).toBe(!before);
    }
  });

  it("exposes trail length up to 500, trail opacity, and trail width sliders", () => {
    useAppStore.setState({ trailLength: 250, trailAlpha: 0.5, trailWidth: 6 });
    render(<ViewPanel />);

    expect(screen.getByText("250")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getByText("6 px")).toBeInTheDocument();

    const sliders = screen.getAllByRole("slider");
    const trailLengthSlider = sliders.find((s) => s.getAttribute("aria-valuemax") === "500");
    expect(trailLengthSlider).toBeDefined();
    expect(trailLengthSlider?.getAttribute("aria-valuenow")).toBe("250");

    const trailAlphaSlider = sliders.find((s) => s.getAttribute("aria-valuemax") === "1");
    expect(trailAlphaSlider).toBeDefined();
    expect(trailAlphaSlider?.getAttribute("aria-valuenow")).toBe("0.5");

    const trailWidthSlider = sliders.find(
      (s) => s.getAttribute("aria-valuemin") === "1" && s.getAttribute("aria-valuemax") === "10" && s.getAttribute("aria-valuenow") === "6",
    );
    expect(trailWidthSlider).toBeDefined();
  });

  it("shows Off when trail length is 0", () => {
    useAppStore.setState({ trailLength: 0 });
    render(<ViewPanel />);
    expect(screen.getByText("Off")).toBeInTheDocument();
  });

  it("offers Centroid plus skeleton nodes in Trail node select, falling back to Centroid for unknown nodes", () => {
    useAppStore.setState({
      skeleton: new Skeleton({ nodes: ["head", "thorax", "tail"] }),
      trailNode: "abdomen",
    });
    render(<ViewPanel />);

    const trigger = screen.getByRole("combobox", { name: "Trail node" });
    // Unknown node from another project falls back to Centroid.
    expect(trigger).toHaveTextContent("Centroid");

    fireEvent.click(trigger);
    expect(screen.getByRole("option", { name: "Centroid" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "head" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "thorax" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "tail" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("option", { name: "thorax" }));
    expect(useAppStore.getState().trailNode).toBe("thorax");
    expect(trigger).toHaveTextContent("thorax");
  });
});
