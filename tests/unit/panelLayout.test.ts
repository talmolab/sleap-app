/**
 * Tests for the pure sidebar layout logic (issue #135): default order,
 * persistence reconciliation, id-based reorder, and active auto-switch.
 */

import { describe, it, expect } from "../bun-test";
import {
  DEFAULT_PANEL_ORDER,
  DEFAULT_OPEN_PANELS,
  reconcilePanelOrder,
  reconcileHiddenPanels,
  reorderById,
  nextVisiblePanel,
  toggleId,
  reconcileOpenPanels,
  visibleOpenPanels,
  migrateOpenPanels,
} from "@/lib/panelLayout";

describe("the 'correct' panel id", () => {
  it("is valid again, so a legacy active id resolves instead of being dropped", () => {
    // History: "Correct predictions" started as a standalone panel, moved to an
    // Active-Learning tab (which retired the id, and this test asserted it
    // stayed retired), and now has BOTH — the tab for the loop user plus a
    // top-level entry for someone correcting a predictions.slp with no
    // workflow config. Since the id maps to a real component again, a returning
    // user's persisted `sidebarActivePanel: "correct"` should be honored.
    expect(DEFAULT_PANEL_ORDER as readonly string[]).toContain("correct");
    expect(migrateOpenPanels(null, "correct")).toEqual(["correct"]);
    expect(reconcileOpenPanels(["correct"])).toEqual(["correct"]);
    // A still-valid legacy id is honored as before.
    expect(migrateOpenPanels(null, "skeleton")).toEqual(["skeleton"]);
  });
});

describe("retired panel ids", () => {
  it("drops an id that no longer maps to a component", () => {
    // The general guarantee the 'correct' case used to cover: an unknown
    // persisted id must not reach the open stack, or the sidebar body renders
    // empty. Uses a name that has never been a panel.
    expect(DEFAULT_PANEL_ORDER as readonly string[]).not.toContain("nonexistent-panel");
    expect(migrateOpenPanels(null, "nonexistent-panel")).toEqual([...DEFAULT_OPEN_PANELS]);
    expect(reconcileOpenPanels(["nonexistent-panel"])).toEqual([]);
  });
});

describe("reconcilePanelOrder", () => {
  it("returns the full default order for empty/undefined input", () => {
    expect(reconcilePanelOrder()).toEqual([...DEFAULT_PANEL_ORDER]);
    expect(reconcilePanelOrder([])).toEqual([...DEFAULT_PANEL_ORDER]);
    expect(reconcilePanelOrder(null)).toEqual([...DEFAULT_PANEL_ORDER]);
  });

  it("preserves a valid stored order", () => {
    const stored = [...DEFAULT_PANEL_ORDER].reverse();
    expect(reconcilePanelOrder(stored)).toEqual(stored);
  });

  it("appends panels missing from a stale stored order (no silent drop)", () => {
    // A blob written before "debug" + "connect" existed.
    const stale = DEFAULT_PANEL_ORDER.filter(
      (id) => id !== "debug" && id !== "connect"
    );
    const result = reconcilePanelOrder(stale);
    expect(result).toContain("debug");
    expect(result).toContain("connect");
    expect(result.length).toBe(DEFAULT_PANEL_ORDER.length);
    // Missing panels are appended after the kept ones.
    expect(result.slice(0, stale.length)).toEqual(stale);
  });

  it("drops unknown ids from a stored order", () => {
    const result = reconcilePanelOrder(["videos", "ghost", "skeleton"]);
    expect(result).not.toContain("ghost");
    expect(result.slice(0, 2)).toEqual(["videos", "skeleton"]);
    expect(result.length).toBe(DEFAULT_PANEL_ORDER.length);
  });
});

describe("reconcileHiddenPanels", () => {
  it("defaults to empty", () => {
    expect(reconcileHiddenPanels()).toEqual([]);
    expect(reconcileHiddenPanels(null)).toEqual([]);
  });

  it("keeps only known ids and de-dupes", () => {
    expect(reconcileHiddenPanels(["debug", "ghost", "debug", "view"])).toEqual([
      "debug",
      "view",
    ]);
  });
});

describe("reorderById", () => {
  it("moves an id to the target id's position", () => {
    expect(reorderById(["a", "b", "c", "d"], "a", "c")).toEqual([
      "b",
      "c",
      "a",
      "d",
    ]);
  });

  it("works when moving backward", () => {
    expect(reorderById(["a", "b", "c", "d"], "d", "b")).toEqual([
      "a",
      "d",
      "b",
      "c",
    ]);
  });

  it("is a no-op for same id or missing ids, returning a copy", () => {
    const order = ["a", "b", "c"];
    expect(reorderById(order, "b", "b")).toEqual(order);
    expect(reorderById(order, "x", "b")).toEqual(order);
    expect(reorderById(order, "a", "x")).toEqual(order);
    expect(reorderById(order, "b", "b")).not.toBe(order); // copy, not the same ref
  });

  it("reorders correctly even when the rendered list is a hidden-filtered subset", () => {
    // Regression for the filtered-index bug: dropping must splice the FULL
    // order by id, not by the visible render index.
    const fullOrder = ["a", "b", "c", "d", "e"];
    // Visible (hidden = b, d): rendered as [a, c, e]. User drags "e" onto "a".
    expect(reorderById(fullOrder, "e", "a")).toEqual([
      "e",
      "a",
      "b",
      "c",
      "d",
    ]);
  });
});

describe("nextVisiblePanel", () => {
  const order = ["a", "b", "c", "d"];

  it("returns the first visible panel, treating `excluding` as hidden", () => {
    expect(nextVisiblePanel(order, [], "a")).toBe("b");
    expect(nextVisiblePanel(order, ["b"], "a")).toBe("c");
  });

  it("returns null when nothing else is visible (allow-empty)", () => {
    expect(nextVisiblePanel(order, ["b", "c", "d"], "a")).toBeNull();
  });
});

describe("toggleId", () => {
  it("appends an id not already present", () => {
    expect(toggleId(["a", "b"], "c")).toEqual(["a", "b", "c"]);
  });

  it("removes an id already present", () => {
    expect(toggleId(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });

  it("returns a copy (does not mutate the input)", () => {
    const list = ["a"];
    expect(toggleId(list, "b")).not.toBe(list);
    expect(list).toEqual(["a"]);
  });
});

describe("reconcileOpenPanels", () => {
  it("defaults to empty", () => {
    expect(reconcileOpenPanels()).toEqual([]);
    expect(reconcileOpenPanels(null)).toEqual([]);
  });

  it("keeps only known ids and de-dupes", () => {
    expect(
      reconcileOpenPanels(["videos", "ghost", "videos", "skeleton"]),
    ).toEqual(["videos", "skeleton"]);
  });
});

describe("visibleOpenPanels", () => {
  it("returns panelOrder ∩ open − hidden, in panelOrder order", () => {
    const order = ["videos", "skeleton", "instances", "view"];
    // open given out of order → result follows panelOrder.
    expect(visibleOpenPanels(order, ["view", "videos"], [])).toEqual([
      "videos",
      "view",
    ]);
  });

  it("excludes hidden panels even when they are open", () => {
    const order = ["videos", "skeleton", "instances"];
    expect(
      visibleOpenPanels(order, ["videos", "skeleton"], ["skeleton"]),
    ).toEqual(["videos"]);
  });
});

describe("migrateOpenPanels", () => {
  it("honors a stored open set — including an intentionally-empty one", () => {
    expect(migrateOpenPanels(["skeleton"], "videos")).toEqual(["skeleton"]);
    // Empty means the user closed every panel; it must NOT re-open one.
    expect(migrateOpenPanels([], "videos")).toEqual([]);
  });

  it("migrates a legacy single active panel when no open set was stored", () => {
    expect(migrateOpenPanels(null, "instances")).toEqual(["instances"]);
  });

  it("falls back to the default when neither is available/known", () => {
    expect(migrateOpenPanels(null, null)).toEqual([...DEFAULT_OPEN_PANELS]);
    expect(migrateOpenPanels(null, "ghost")).toEqual([...DEFAULT_OPEN_PANELS]);
  });
});
