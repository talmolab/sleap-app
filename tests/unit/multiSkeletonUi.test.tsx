/**
 * Render tests for the multi-skeleton UI: the Skeleton panel's picker (switch /
 * add / rename) and the gate that replaces single-skeleton panels (training,
 * inference, Label QC) with a clear message on a multi-skeleton project.
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from "../bun-test";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";

vi.mock("@/lib/notify", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { useAppStore } from "@/stores/appStore";
import { SkeletonPicker } from "@/components/panels/SkeletonPicker";
import { SingleSkeletonGate } from "@/components/panels/SingleSkeletonGate";
import { Labels } from "@talmolab/sleap-io.js";
import { makeMouseSkeleton, makeTwoSkeletonProject } from "./multiSkeletonFixture";

// Radix dialogs/selects need ResizeObserver + a few pointer/scroll shims.
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
  cleanup();
  useAppStore.setState(useAppStore.getInitialState());
});

describe("SkeletonPicker", () => {
  // Single-skeleton projects keep the old header: just the name, no dropdown.
  it("shows only the name when the project has one skeleton", () => {
    const labels = new Labels({ skeletons: [makeMouseSkeleton()] });
    useAppStore.getState().setLabels(labels, "one.slp");
    render(<SkeletonPicker />);
    expect(screen.getByText("mouse")).toBeTruthy();
    expect(screen.getByText("3 nodes, 2 edges")).toBeTruthy();
    expect(screen.queryByTestId("skeleton-picker")).toBeNull();
  });

  // With two skeletons the dropdown appears and names the active one.
  it("shows a picker with the active skeleton when there are several", () => {
    const { labels } = makeTwoSkeletonProject();
    useAppStore.getState().setLabels(labels, "two.slp");
    render(<SkeletonPicker />);
    expect(screen.getByTestId("skeleton-picker").textContent).toContain("mouse");
    act(() => useAppStore.getState().setActiveSkeleton(labels.skeletons[1]));
    expect(screen.getByTestId("skeleton-picker").textContent).toContain("pellet");
  });

  // "+" opens a name dialog prefilled with a free name; Add creates + activates.
  it("adds a skeleton through the dialog and makes it active", () => {
    const labels = new Labels({ skeletons: [makeMouseSkeleton()] });
    useAppStore.getState().setLabels(labels, "one.slp");
    render(<SkeletonPicker />);
    fireEvent.click(screen.getByLabelText("Add skeleton"));
    const input = screen.getByLabelText("Skeleton name") as HTMLInputElement;
    expect(input.value).toBe("skeleton 2");
    fireEvent.change(input, { target: { value: "pellet" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(labels.skeletons.map((s) => s.name)).toEqual(["mouse", "pellet"]);
    expect(useAppStore.getState().skeleton).toBe(labels.skeletons[1]);
    expect(screen.getByTestId("skeleton-picker")).toBeTruthy();
  });

  // Duplicate names are flagged and can't be submitted.
  it("blocks renaming to a name another skeleton uses", () => {
    const { labels } = makeTwoSkeletonProject();
    useAppStore.getState().setLabels(labels, "two.slp");
    render(<SkeletonPicker />);
    fireEvent.click(screen.getByLabelText("Rename skeleton"));
    fireEvent.change(screen.getByLabelText("Skeleton name"), {
      target: { value: "pellet" },
    });
    expect(screen.getByText("A skeleton with this name already exists.")).toBeTruthy();
    const rename = screen.getByRole("button", { name: "Rename" }) as HTMLButtonElement;
    expect(rename.disabled).toBe(true);
  });
});

describe("SingleSkeletonGate", () => {
  // Training etc. read skeletons[0]; on two skeletons the panel says why it's off.
  it("replaces the panel with a clear message on a multi-skeleton project", () => {
    const { labels } = makeTwoSkeletonProject();
    useAppStore.getState().setLabels(labels, "two.slp");
    useAppStore.getState().set("configDialogRequest", "training");
    render(
      <SingleSkeletonGate feature="Training" configRequest="training">
        <div>training panel body</div>
      </SingleSkeletonGate>,
    );
    expect(screen.getByText("Training with several skeletons isn't supported yet.")).toBeTruthy();
    expect(screen.queryByText("training panel body")).toBeNull();
    // The menu's pending "open config" request is dropped, not left to fire later.
    expect(useAppStore.getState().configDialogRequest).toBeNull();
  });

  // Single-skeleton projects see the panel exactly as before.
  it("renders the panel unchanged on a single-skeleton project", () => {
    const labels = new Labels({ skeletons: [makeMouseSkeleton()] });
    useAppStore.getState().setLabels(labels, "one.slp");
    render(
      <SingleSkeletonGate feature="Training">
        <div>training panel body</div>
      </SingleSkeletonGate>,
    );
    expect(screen.getByText("training panel body")).toBeTruthy();
    expect(screen.queryByTestId("multi-skeleton-gate")).toBeNull();
  });
});
