/**
 * View-menu parity with PyQt SLEAP: Open View Panel shortcut, zoom modes
 * (Fit View to Selection as a toggle, Actual Size), and view preference
 * defaults/persistence (the fine-grained display/style/trail controls moved
 * to the View panel — see `viewPanel.test.tsx`).
 */
import { describe, it, expect, beforeEach } from "../bun-test";
import { useAppStore, PERSISTED_KEYS } from "@/stores/appStore";
import { currentAppMenu } from "@/lib/menu/useAppMenu";
import type { MenuNode, TopMenu } from "@/lib/menu/types";

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
});

function view(): MenuNode[] {
  return (currentAppMenu().find((t) => t.id === "view") as TopMenu).items;
}

function findIn(nodes: MenuNode[], id: string): MenuNode | undefined {
  for (const n of nodes) {
    if ("id" in n && n.id === id) return n;
    if (n.kind === "submenu") {
      const hit = findIn(n.items, id);
      if (hit) return hit;
    }
  }
  return undefined;
}

function node(id: string) {
  const n = findIn(view(), id);
  if (!n) throw new Error(`no menu node ${id}`);
  return n;
}

async function click(id: string) {
  const n = node(id);
  if (n.kind !== "item" && n.kind !== "check") throw new Error(`${id} is not clickable`);
  await n.run();
}

describe("View menu wording and order", () => {
  it("puts Open View Panel first to jump straight to style, color, and trail settings", async () => {
    const labels = view().flatMap((n) => ("label" in n ? [n.label] : []));
    expect(labels[0]).toBe("Open View Panel");
    useAppStore.setState({ sidebarCollapsed: true, sidebarOpenPanels: [] });
    await click("view.openPanel");
    expect(useAppStore.getState().sidebarCollapsed).toBe(false);
    expect(useAppStore.getState().sidebarOpenPanels).toContain("view");
  });

  // PyQt users look for these exact labels, in this order.
  it("has PyQt's three zoom modes together, then a one-shot Zoom to Selection", () => {
    const labels = view().flatMap((n) => ("label" in n ? [n.label] : []));
    const i = labels.indexOf("Fit View to Instances");
    expect(labels.slice(i, i + 4)).toEqual([
      "Fit View to Instances",
      "Fit View to Selection",
      "Actual Size (1:1)",
      "Zoom to Selection",
    ]);
  });
});

describe("zoom modes", () => {
  // PyQt makes Fit to Instances, Fit to Selection and Actual Size exclusive.
  it("turning one on turns the other two off", async () => {
    await click("view.fit");
    expect(useAppStore.getState().fit).toBe(true);

    await click("view.fitSelection");
    expect(useAppStore.getState()).toMatchObject({ fit: false, followSelection: true, actualSize: false });

    await click("view.actualSize");
    expect(useAppStore.getState()).toMatchObject({ fit: false, followSelection: false, actualSize: true });

    await click("view.fit");
    expect(useAppStore.getState()).toMatchObject({ fit: true, followSelection: false, actualSize: false });
  });

  // Fit View to Selection is now a check item that stays on, not a one-shot.
  it("Fit View to Selection is a toggle that shows its state", async () => {
    expect(node("view.fitSelection")).toMatchObject({ kind: "check", checked: false });
    await click("view.fitSelection");
    expect(node("view.fitSelection")).toMatchObject({ checked: true });
    await click("view.fitSelection");
    expect(useAppStore.getState().followSelection).toBe(false);
  });

  // The old one-shot behavior must stay reachable from the menu.
  it("Zoom to Selection zooms once and needs a selected instance", async () => {
    expect(node("view.zoomToSelection")).toMatchObject({ kind: "item", enabled: false });
    useAppStore.setState({ instance: {} as never });
    await click("view.zoomToSelection");
    expect(useAppStore.getState().fitSelection).toBe(true);
    expect(useAppStore.getState().followSelection).toBe(false);
  });

  // Unchecking Actual Size goes back to the whole frame (PyQt clearZoom).
  it("turning Actual Size off resets the view; switching to another mode does not", async () => {
    await click("view.actualSize");
    const nonce = useAppStore.getState().resetViewNonce;
    await click("view.actualSize");
    expect(useAppStore.getState().resetViewNonce).toBe(nonce + 1);

    await click("view.actualSize");
    const nonce2 = useAppStore.getState().resetViewNonce;
    await click("view.fit");
    expect(useAppStore.getState().resetViewNonce).toBe(nonce2);
  });

  // Reset View (R) leaves 1:1, so the check mark must go away.
  it("Reset View un-checks Actual Size", () => {
    useAppStore.getState().setZoomMode("actualSize", true);
    useAppStore.getState().resetView();
    expect(useAppStore.getState().actualSize).toBe(false);
  });
});

describe("preferences", () => {
  // Defaults match PyQt's prefs.py so a new user sees the same view.
  it("defaults match PyQt", () => {
    expect(useAppStore.getState()).toMatchObject({
      showMeanNodeScore: false,
      boldLines: false,
      trailNode: "centroid",
      trailAlpha: 1,
      trailFade: true,
      trailWidth: 4,
    });
  });

  // These are saved like the other view preferences; the zoom modes are not (as in PyQt).
  it("saves the new view preferences but not the zoom modes", () => {
    for (const key of ["showMeanNodeScore", "boldLines", "trailNode", "trailAlpha", "trailFade", "trailWidth"] as const) {
      expect(PERSISTED_KEYS).toContain(key);
    }
    for (const key of ["fit", "followSelection", "actualSize", "fitSelection"] as const) {
      expect(PERSISTED_KEYS).not.toContain(key);
    }
  });
});
