/**
 * Render tests for the Instances-panel TrackColorSwatch (per-track color picker,
 * §2). The override logic is covered by tests/unit/trackColorOverrides.test.ts
 * and tests/unit/appStore.test.ts; these assert the panel wiring: the swatch is
 * an editable popover trigger only for a tracked, editable instance, and picking
 * a preset dispatches the store action for the active project.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from "../bun-test";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { TrackColorSwatch } from "@/components/panels/InstancesPanel";
import { useAppStore } from "@/stores/appStore";

// Radix Popover needs these in happy-dom.
beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  if (!(Element.prototype as unknown as { hasPointerCapture?: unknown }).hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
    (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
  }
});

describe("TrackColorSwatch", () => {
  beforeEach(() => useAppStore.setState(useAppStore.getInitialState()));
  afterEach(cleanup);

  it("renders a static swatch (no button) for a [no track] instance", () => {
    render(
      <TrackColorSwatch color={[10, 20, 30]} palette="standard" trackName={null} editable={false} />,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders a static swatch when tracked but read-only", () => {
    render(
      <TrackColorSwatch color={[10, 20, 30]} palette="standard" trackName="track_0" editable={false} />,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders an editable trigger for a tracked, editable instance", () => {
    render(
      <TrackColorSwatch color={[10, 20, 30]} palette="standard" trackName="track_0" editable />,
    );
    expect(
      screen.getByRole("button", { name: /set color for track track_0/i }),
    ).toBeTruthy();
  });

  it("dispatches setTrackColor for the active project when a preset is picked", () => {
    useAppStore.setState({ projectPath: "/p.slp", filename: "p.slp" });
    render(
      <TrackColorSwatch color={[0, 114, 189]} palette="standard" trackName="track_0" editable />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /set color for track track_0/i }),
    );
    const preset = screen.getAllByRole("button", { name: /^set track color #/i })[0];
    fireEvent.click(preset);
    const hex = useAppStore.getState().trackColorOverrides["/p.slp"]?.track_0;
    expect(hex).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("clears the override via Reset to auto", () => {
    useAppStore.setState({
      projectPath: "/p.slp",
      filename: "p.slp",
      trackColorOverrides: { "/p.slp": { track_0: "#123456" } },
    });
    render(
      <TrackColorSwatch color={[18, 52, 86]} palette="standard" trackName="track_0" editable />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /set color for track track_0/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: /reset to auto/i }));
    expect(useAppStore.getState().trackColorOverrides["/p.slp"]).toBeUndefined();
  });
});
