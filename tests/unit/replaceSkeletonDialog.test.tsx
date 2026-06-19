/**
 * Render + pure-helper tests for {@link ReplaceSkeletonDialog} (#163, Task 3).
 *
 * The dialog ports PyQt's `ReplaceSkeletonTableDialog` (sleap/gui/dialogs/merge.py:428):
 * given a {@link SkeletonDiff}, it lets the user LINK each new node to an
 * about-to-be-deleted old node and returns the `{newName: oldName}` link map.
 *
 * The replace/link LOGIC lives in small exported pure helpers
 * (`newSkeletonNodes`, `unusedDeleteNodes`, `computeLinkMap`) so it is unit-tested
 * directly, WITHOUT driving the Radix `<Select>` popover — which is unreliable
 * under happy-dom (it depends on pointer-capture / portal layout APIs happy-dom
 * does not mount deterministically; see the SuggestionsPanel / Add-Edge tests for
 * the same documented limitation). The component render test therefore asserts on
 * structure (a row per new node, kept-row labels, the add/delete message) and on
 * the Cancel / Replace callbacks via spies — it does NOT open a Select.
 */

import { describe, it, expect, beforeAll, afterEach } from "../bun-test";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import type { SkeletonDiff } from "@/lib/skeletonIO";
import {
  ReplaceSkeletonDialog,
  newSkeletonNodes,
  unusedDeleteNodes,
  computeLinkMap,
} from "@/components/panels/ReplaceSkeletonDialog";
import type { ReplaceSkeletonDialogProps } from "@/components/panels/ReplaceSkeletonDialog";

// Radix Dialog/Select read ResizeObserver + pointer-capture APIs at mount.
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

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Pure helpers — the link/rename logic, tested without the Radix popover.
// ---------------------------------------------------------------------------

describe("newSkeletonNodes (row ordering)", () => {
  it("is renameNodes (kept) first, then addNodes — preserving each source order", () => {
    const diff: SkeletonDiff = {
      renameNodes: ["head", "thorax"],
      deleteNodes: ["tail"],
      addNodes: ["abdomen", "wingL"],
    };
    expect(newSkeletonNodes(diff)).toEqual([
      "head",
      "thorax",
      "abdomen",
      "wingL",
    ]);
  });

  it("is just addNodes when nothing is kept", () => {
    const diff: SkeletonDiff = {
      renameNodes: [],
      deleteNodes: ["a", "b"],
      addNodes: ["x", "y"],
    };
    expect(newSkeletonNodes(diff)).toEqual(["x", "y"]);
  });
});

describe("unusedDeleteNodes (mutual exclusion)", () => {
  const diff: SkeletonDiff = {
    renameNodes: ["head"],
    deleteNodes: ["tail", "tailBase", "tailTip"],
    addNodes: ["a", "b"],
  };

  it("offers all deleteNodes when nothing is selected", () => {
    expect(unusedDeleteNodes(diff, new Map())).toEqual([
      "tail",
      "tailBase",
      "tailTip",
    ]);
  });

  it("removes deleteNodes already chosen in other rows", () => {
    const selections = new Map<string, string>([["a", "tailBase"]]);
    expect(unusedDeleteNodes(diff, selections)).toEqual(["tail", "tailTip"]);
  });

  it("ignores empty ('') selections", () => {
    const selections = new Map<string, string>([
      ["a", ""],
      ["b", "tail"],
    ]);
    expect(unusedDeleteNodes(diff, selections)).toEqual(["tailBase", "tailTip"]);
  });
});

describe("computeLinkMap (port of get_table_data)", () => {
  it("keeps {new: old} only where old !== '' && new !== old", () => {
    const diff: SkeletonDiff = {
      renameNodes: ["head"], // kept, auto-links to itself -> excluded (new===old)
      deleteNodes: ["tail"],
      addNodes: ["rump"],
    };
    // Add-row "rump" linked to deleted "tail"; rename row "head" stays kept.
    const selections = new Map<string, string>([
      ["head", "head"], // new === old -> excluded
      ["rump", "tail"], // kept
    ]);
    const map = computeLinkMap(diff, selections);
    expect([...map.entries()]).toEqual([["rump", "tail"]]);
  });

  it("excludes empty selections", () => {
    const diff: SkeletonDiff = {
      renameNodes: [],
      deleteNodes: ["tail"],
      addNodes: ["a", "b"],
    };
    const selections = new Map<string, string>([
      ["a", ""],
      ["b", "tail"],
    ]);
    expect([...computeLinkMap(diff, selections).entries()]).toEqual([
      ["b", "tail"],
    ]);
  });

  it("throws the bipartite-conflict error when a chosen mapping's new name is an existing skeleton node", () => {
    // skeleton_nodes = renameNodes ∪ deleteNodes = {head, tail}. If a row whose
    // NEW name is "head" (an existing kept node) is linked to "tail", PyQt raises
    // "rename existing node manually first".
    const diff: SkeletonDiff = {
      renameNodes: ["head"],
      deleteNodes: ["tail"],
      addNodes: ["rump"],
    };
    const selections = new Map<string, string>([["head", "tail"]]);
    expect(() => computeLinkMap(diff, selections)).toThrow(
      /rename existing skeleton node/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Component render — structure + Cancel/Replace callbacks (no Select driving).
// ---------------------------------------------------------------------------

describe("ReplaceSkeletonDialog (render)", () => {
  const diff: SkeletonDiff = {
    renameNodes: ["head", "thorax"],
    deleteNodes: ["tail"],
    addNodes: ["abdomen"],
  };

  function setup(overrides?: {
    onConfirm?: ReplaceSkeletonDialogProps["onConfirm"];
    onOpenChange?: ReplaceSkeletonDialogProps["onOpenChange"];
  }) {
    const onConfirm = overrides?.onConfirm ?? (() => {});
    const onOpenChange = overrides?.onOpenChange ?? (() => {});
    render(
      <ReplaceSkeletonDialog
        open
        onOpenChange={onOpenChange}
        diff={diff}
        newSkeletonName="fly32"
        onConfirm={onConfirm}
      />,
    );
    return { onConfirm, onOpenChange };
  }

  function dialog(): HTMLElement {
    return screen
      .getByText(/replace nodes/i)
      .closest('[role="dialog"]') as HTMLElement;
  }

  it("renders one row per new node (renameNodes then addNodes)", () => {
    setup();
    // The table is the only <table> in the dialog; its body rows are the new
    // nodes (the node names also appear in the summary message, so scope to the
    // table's "New" column to count rows unambiguously).
    const table = within(dialog())
      .getByText("New")
      .closest("table") as HTMLElement;
    // First cell of each body row = the new node name, in row order.
    const bodyRows = within(table).getAllByRole("row").slice(1); // drop header
    const newNames = bodyRows.map(
      (r) => within(r).getAllByRole("cell")[0].textContent,
    );
    expect(newNames).toEqual(["head", "thorax", "abdomen"]);
  });

  it("shows kept (rename) rows as a static '— (kept)' label, not a Select", () => {
    setup();
    // Two kept nodes (head, thorax) -> two kept labels.
    const keptLabels = within(dialog()).getAllByText(/\(kept\)/i);
    expect(keptLabels.length).toBe(2);
    // The single added node ("abdomen") gets a Select (combobox); the kept rows
    // do NOT — so exactly one combobox is rendered.
    expect(within(dialog()).getAllByRole("combobox").length).toBe(1);
  });

  it("never leaks the internal UNLINKED sentinel into the rendered text", () => {
    setup();
    // The "__none__" sentinel is an internal Radix value placeholder; it must
    // never surface to the user. The unlinked add-row trigger shows "(unlinked)".
    expect(dialog().textContent ?? "").not.toContain("__none__");
    expect(within(dialog()).getByText(/\(unlinked\)/i)).toBeInTheDocument();
  });

  it("summarizes deleted and added nodes in the message", () => {
    setup();
    const text = dialog().textContent ?? "";
    expect(text).toMatch(/deleted/i);
    expect(text).toMatch(/tail/); // the delete node
    expect(text).toMatch(/added/i);
    expect(text).toMatch(/abdomen/); // the add node
  });

  it("Cancel calls onOpenChange(false) and NOT onConfirm", () => {
    // Capture callback args in a mutable record (avoids TS narrowing a plain
    // `let` to its initializer type across the closure).
    const calls = {
      confirm: 0,
      openChange: [] as boolean[],
    };
    setup({
      onConfirm: () => {
        calls.confirm += 1;
      },
      onOpenChange: (o) => {
        calls.openChange.push(o);
      },
    });
    fireEvent.click(within(dialog()).getByRole("button", { name: /cancel/i }));
    expect(calls.openChange).toEqual([false]);
    expect(calls.confirm).toBe(0);
  });

  it("Replace validates and calls onConfirm with the link map, then closes", () => {
    // With no selections changed, the only links would come from add rows. The
    // default add-row selection is '' (unlinked), so the link map is empty —
    // Replace still fires onConfirm({}) and closes (no conflict).
    const calls = {
      maps: [] as Map<string, string>[],
      openChange: [] as boolean[],
    };
    setup({
      onConfirm: (m) => {
        calls.maps.push(m);
      },
      onOpenChange: (o) => {
        calls.openChange.push(o);
      },
    });
    fireEvent.click(within(dialog()).getByRole("button", { name: /replace/i }));
    expect(calls.maps.length).toBe(1);
    expect([...calls.maps[0].entries()]).toEqual([]); // nothing linked
    expect(calls.openChange).toEqual([false]); // dialog closed
  });

  it("renders no combobox (only kept labels) when there are no added nodes", () => {
    render(
      <ReplaceSkeletonDialog
        open
        onOpenChange={() => {}}
        diff={{ renameNodes: ["head"], deleteNodes: [], addNodes: [] }}
        onConfirm={() => {}}
      />,
    );
    const d = screen
      .getByText(/replace nodes/i)
      .closest('[role="dialog"]') as HTMLElement;
    expect(within(d).queryAllByRole("combobox").length).toBe(0);
    expect(within(d).getByText(/no nodes will be deleted/i)).toBeInTheDocument();
    expect(within(d).getByText(/no nodes will be added/i)).toBeInTheDocument();
  });
});
