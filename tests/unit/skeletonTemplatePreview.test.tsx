/**
 * The Skeleton panel's template preview (legacy SLEAP parity): picking a
 * template in "Load template" shows what it looks like (its labeled example
 * image, name, description and nodes) and only a "Load" click applies it.
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from "../bun-test";
import { render, screen, fireEvent, within, cleanup } from "@testing-library/react";
import { useAppStore } from "@/stores/appStore";
import { Labels, Skeleton } from "@talmolab/sleap-io.js";
import { SKELETON_TEMPLATES } from "@/lib/skeletonTemplates";

vi.mock("@/lib/notify", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

// Radix Select and Dialog need these in the DOM shim.
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

function setupProject(nodeNames: string[]) {
  const skeleton = new Skeleton({ nodes: nodeNames, name: "current" });
  const labels = new Labels({ videos: [], skeletons: [skeleton] });
  useAppStore.getState().setLabels(labels, "test.slp");
  return skeleton;
}

async function renderPanel() {
  const { SkeletonPanel } = await import("@/components/panels/SkeletonPanel");
  render(<SkeletonPanel />);
}

/** Open the "Load template" select and pick the option with this label. */
function pickTemplate(label: string) {
  const trigger = screen
    .getAllByRole("combobox")
    .find((c) => c.textContent?.includes("Select skeleton template"))!;
  fireEvent.pointerDown(trigger, { button: 0 });
  fireEvent.keyDown(trigger, { key: "Enter" });
  const option = screen.getAllByRole("option").find((o) => o.textContent === label)!;
  fireEvent.keyDown(option, { key: "Enter" });
}

const preview = () => screen.queryByTestId("skeleton-template-preview");

describe("skeleton template preview", () => {
  beforeEach(() => {
    cleanup();
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("shows nothing until a template is picked", async () => {
    setupProject([]);
    await renderPanel();
    expect(preview()).toBeNull();
  });

  it("previews a reference template's example image, nodes and description without loading it", async () => {
    const skeleton = setupProject([]);
    await renderPanel();

    pickTemplate(SKELETON_TEMPLATES.flies13.name);

    const card = preview()!;
    expect(card).not.toBeNull();
    const img = within(card).getByRole("img");
    expect(img.getAttribute("src")).toContain("skeleton-templates/flies13.png");
    expect(card.textContent).toContain(SKELETON_TEMPLATES.flies13.description);
    expect(card.textContent).toContain("13 nodes, 12 edges:");
    expect(card.textContent).toContain(SKELETON_TEMPLATES.flies13.nodes[0]);
    // A pick alone never changes the skeleton.
    expect(skeleton.nodes).toHaveLength(0);
  });

  it("shows no image for a template that has none, just its details", async () => {
    setupProject([]);
    await renderPanel();

    pickTemplate(SKELETON_TEMPLATES.human.name);

    const card = preview()!;
    expect(within(card).queryByRole("img")).toBeNull();
    expect(card.textContent).toContain("17 nodes");
  });

  it("loads the previewed template when Load is clicked", async () => {
    const skeleton = setupProject([]);
    await renderPanel();

    pickTemplate(SKELETON_TEMPLATES.mice_of.name);
    fireEvent.click(within(preview()!).getByRole("button", { name: "Load" }));

    expect(skeleton.nodes.map((n) => n.name)).toEqual(SKELETON_TEMPLATES.mice_of.nodes);
  });

  it("still asks before replacing an existing skeleton", async () => {
    const skeleton = setupProject(["a", "b"]);
    await renderPanel();

    pickTemplate(SKELETON_TEMPLATES.bees.name);
    fireEvent.click(within(preview()!).getByRole("button", { name: "Load" }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(skeleton.nodes.map((n) => n.name)).toEqual(["a", "b"]);
  });
});
