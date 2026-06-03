/**
 * Tests for the pure sidebar layout logic (issue #135): default order,
 * persistence reconciliation, id-based reorder, and active auto-switch.
 */

import { describe, it, expect } from "../bun-test";
import {
  DEFAULT_PANEL_ORDER,
  reconcilePanelOrder,
  reconcileHiddenPanels,
  reorderById,
  nextVisiblePanel,
} from "@/lib/panelLayout";

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
