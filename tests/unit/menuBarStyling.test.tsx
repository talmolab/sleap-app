/**
 * MenuBar web styling, alignment, menu ordering, and updated Help copy tests.
 */
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from "../bun-test";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { useAppStore } from "@/stores/appStore";

vi.mock("@/lib/platform", () => ({
  isTauri: false,
  isMac: false,
  modKey: "Ctrl",
  altKey: "Alt",
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

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

function openMenu(name: string) {
  fireEvent.pointerDown(screen.getByRole("menuitem", { name }), {
    button: 0,
    ctrlKey: false,
  });
}

describe("MenuBar web styling and structure", () => {
  it("omits Connect and Start Tutorial from the top-level menu bar", async () => {
    const { MenuBar } = await import("@/components/layout/MenuBar");
    render(<MenuBar />);

    expect(screen.queryByText("Connect")).not.toBeInTheDocument();
    expect(screen.queryByText("Start Tutorial")).not.toBeInTheDocument();
    expect(screen.getByText("Help")).toBeInTheDocument();
  });

  it("matches dropdown font size to menu titles (text-xs) and aligns dropdown flush (rounded-t-none, py-0 bar)", async () => {
    const { MenuBar } = await import("@/components/layout/MenuBar");
    const { container } = render(<MenuBar />);

    const bar = container.querySelector('[data-slot="menubar"]');
    expect(bar?.className).toContain("py-0");

    const helpTrigger = screen.getByRole("menuitem", { name: "Help" });
    expect(helpTrigger.className).toContain("text-xs");
    expect(helpTrigger.className).toContain("h-full");

    openMenu("Help");

    const content = document.querySelector('[data-slot="menubar-content"]');
    expect(content).toBeTruthy();
    expect(content?.className).toContain("rounded-t-none");

    // Documentation is first, followed by Start Tutorial, Labeling Tips..., Show Hints During Labeling.
    const items = Array.from(content!.querySelectorAll('[data-slot="menubar-item"], [data-slot="menubar-checkbox-item"]'));
    expect(items[0]?.textContent).toContain("Documentation");
    expect(items[1]?.textContent).toContain("Start Tutorial");
    expect(items[2]?.textContent).toContain("Labeling Tips...");
    expect(items[3]?.textContent).toContain("Show Hints During Labeling");

    // Every menu item and checkbox item uses text-xs (not text-sm).
    for (const el of items) {
      expect(el.className).toContain("text-xs");
      expect(el.className).not.toContain("text-sm");
    }
  });

  it("uses text-xs on radio items, labels, and submenu triggers too", async () => {
    const { MenuBar } = await import("@/components/layout/MenuBar");
    render(<MenuBar />);

    openMenu("Go");
    const radios = Array.from(document.querySelectorAll('[data-slot="menubar-radio-item"]'));
    expect(radios.length).toBeGreaterThan(0);
    for (const r of radios) {
      expect(r.className).toContain("text-xs");
      expect(r.className).not.toContain("text-sm");
    }

    openMenu("Labels");
    const labelEl = document.querySelector('[data-slot="menubar-label"]');
    expect(labelEl?.className).toContain("text-xs");
    expect(labelEl?.className).not.toContain("text-sm");
    const subTrigger = document.querySelector('[data-slot="menubar-sub-trigger"]');
    expect(subTrigger?.className).toContain("text-xs");
    expect(subTrigger?.className).not.toContain("text-sm");
  });

  it("opens the View panel from View -> Open View Panel", async () => {
    const { MenuBar } = await import("@/components/layout/MenuBar");
    useAppStore.setState({ sidebarCollapsed: true, sidebarOpenPanels: [] });
    render(<MenuBar />);

    openMenu("View");
    fireEvent.click(screen.getByRole("menuitem", { name: "Open View Panel" }));
    expect(useAppStore.getState().sidebarCollapsed).toBe(false);
    expect(useAppStore.getState().sidebarOpenPanels).toContain("view");
  });
});

describe("Help menu UI copy", () => {
  it("points users to Help -> Start Tutorial and Help -> Show Hints During Labeling", async () => {
    const { LabelingTipsDialog } = await import("@/components/dialogs/LabelingTipsDialog");
    const { TutorialCompletionCard } = await import("@/components/tutorial/TutorialCompletionCard");

    render(<LabelingTipsDialog open onOpenChange={() => {}} />);
    expect(screen.getByText("Help → Show Hints During Labeling")).toBeInTheDocument();
    expect(screen.getByText("Help → Start Tutorial")).toBeInTheDocument();
    cleanup();

    render(<TutorialCompletionCard />);
    expect(screen.getByText(/Help → Start Tutorial/)).toBeInTheDocument();
  });
});
