/**
 * Render test for the Skeleton panel's auto-filled / chaining "Add Edge" dialog
 * (GitHub issue #158, Task 2 wiring).
 *
 * The pure source->destination selection logic is exhaustively covered by the
 * Task 1 unit suite (tests/unit/skeletonEdgeEditing.test.ts). This render test
 * is deliberately thin: it verifies that SkeletonPanel actually *wires* those
 * helpers into the dialog — the dialog opens pre-filled, the Destination option
 * set is filtered (no self-loop, no already-connected target), the Add button
 * reflects validity, and clicking Add mutates the store, keeps the dialog open,
 * and advances the source for rapid chaining.
 *
 * happy-dom / Radix notes (verified empirically, not guessed):
 *  - Radix `Tabs` does NOT activate on a plain `fireEvent.click`; it needs a
 *    pointer-down sequence. We use `pointerDown` + `mouseDown` on the Edges tab,
 *    which flips it to `data-state="active"` and mounts its TabsContent.
 *  - Radix `Select` only mounts its `SelectItem` options (role="option") when
 *    the listbox is OPENED (pointerDown + Enter on the trigger), and while a
 *    Select is open Radix marks the surrounding Dialog `aria-hidden="true"`,
 *    which makes Testing Library's accessible (`getByRole`) queries skip the
 *    dialog's buttons. So we never open a Select and then run other dialog role
 *    queries in the same test: the destination-filter assertion opens ONLY the
 *    Destination Select and inspects its options in isolation; every other
 *    assertion reads the pre-filled value straight off the Select trigger's
 *    text content (the rendered `SelectValue`) and drives the Add button
 *    directly. No timing hacks / fake timers are used.
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from "../bun-test";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { useAppStore } from "@/stores/appStore";
import { Labels, Skeleton, Video } from "@talmolab/sleap-io.js";

// Mirror the other component tests: deterministic platform + toast.
vi.mock("@/lib/platform", () => ({
  isTauri: false,
  isMac: false,
  modKey: "Ctrl",
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

// Radix Select/Tabs need a ResizeObserver in happy-dom.
beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

/** Reset the store between tests. */
function resetStore() {
  useAppStore.setState(useAppStore.getInitialState());
}

/**
 * Minimal project setup: a 3-node skeleton ("a","b","c"), a backend-less video,
 * and a Labels loaded into the store. Optionally seed an a->b edge so we can
 * assert the destination filter excludes already-connected targets.
 */
function setupProject(opts?: { seedEdge?: boolean }) {
  const skeleton = new Skeleton({ nodes: ["a", "b", "c"], name: "test" });
  if (opts?.seedEdge) {
    skeleton.addEdge(skeleton.nodes[0], skeleton.nodes[1]); // a -> b
  }

  const video = new Video({
    filename: "test.mp4",
    backendMetadata: { shape: [100, 480, 640, 3] },
    openBackend: false,
  });

  const labels = new Labels({ videos: [video], skeletons: [skeleton] });
  useAppStore.getState().setLabels(labels, "test.slp");
  return { labels, skeleton, video };
}

/** Render the panel, switch to the Edges tab, and open the Add Edge dialog. */
async function renderAndOpenAddEdge() {
  const { SkeletonPanel } = await import("@/components/panels/SkeletonPanel");
  render(<SkeletonPanel />);

  // Radix Tabs need a pointer-down sequence (a plain click is a no-op in
  // happy-dom); after this the Edges TabsContent (and "New Edge") is mounted.
  const edgesTab = screen
    .getAllByRole("tab")
    .find((t) => /Edges/.test(t.textContent ?? ""));
  if (!edgesTab) throw new Error("Edges tab not found");
  fireEvent.pointerDown(edgesTab, { button: 0 });
  fireEvent.mouseDown(edgesTab, { button: 0 });

  fireEvent.click(screen.getByText("New Edge"));
}

/** The open Add Edge dialog element. */
function addEdgeDialog(): HTMLElement {
  return screen.getByText("Add Edge").closest('[role="dialog"]') as HTMLElement;
}

/** [sourceText, destinationText] read off the two Select triggers' SelectValue. */
function selectionText(): [string, string] {
  const combos = within(addEdgeDialog()).getAllByRole("combobox");
  return [combos[0].textContent ?? "", combos[1].textContent ?? ""];
}

describe("SkeletonPanel Add Edge dialog (#158)", () => {
  beforeEach(() => {
    resetStore();
  });

  it("opens pre-filled with the first node as source and the first valid destination", async () => {
    setupProject();
    await renderAndOpenAddEdge();

    expect(addEdgeDialog()).toBeTruthy();
    // Source defaults to first node "a"; destination to first valid target "b".
    expect(selectionText()).toEqual(["a", "b"]);
  });

  it("filters the Destination options to valid targets (excludes src + connected)", async () => {
    // Seed a -> b. Source defaults to "a"; valid destinations of "a" are {c}
    // ("a" itself excluded as self-loop, "b" excluded as already connected).
    setupProject({ seedEdge: true });
    await renderAndOpenAddEdge();

    // Pre-filled destination is "c" (the only valid target).
    expect(selectionText()).toEqual(["a", "c"]);

    // Open ONLY the Destination Select and inspect its mounted options. (Doing
    // this last; opening a Select aria-hides the dialog and breaks subsequent
    // accessible queries — see the file header note.)
    const destCombo = within(addEdgeDialog()).getAllByRole("combobox")[1];
    fireEvent.pointerDown(destCombo, { button: 0 });
    fireEvent.keyDown(destCombo, { key: "Enter" });

    const destOptions = screen
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(destOptions).toEqual(["c"]); // excludes self "a" and connected "b"
  });

  it("disables Add for an invalid selection and enables it for a valid one", async () => {
    // With every edge from "a" already present, "a" has no valid destination,
    // so the dialog opens with an empty destination and Add must be disabled.
    const skeleton = new Skeleton({ nodes: ["a", "b"], name: "test" });
    skeleton.addEdge(skeleton.nodes[0], skeleton.nodes[1]); // a -> b (only option)
    const video = new Video({
      filename: "test.mp4",
      backendMetadata: { shape: [100, 480, 640, 3] },
      openBackend: false,
    });
    useAppStore
      .getState()
      .setLabels(new Labels({ videos: [video], skeletons: [skeleton] }), "t.slp");
    await renderAndOpenAddEdge();

    // src "a" has no valid destination left -> dest empty, so the Destination
    // trigger falls back to its placeholder (not a node name) and Add is
    // disabled (isValidEdgeSelection is false for an empty destination).
    const [srcText, dstText] = selectionText();
    expect(srcText).toBe("a");
    expect(dstText).toBe("Select destination node..."); // placeholder => no dst
    const disabledAdd = within(addEdgeDialog()).getByRole("button", {
      name: "Add",
    });
    expect(disabledAdd).toBeDisabled();
  });

  it("enables Add for a valid selection", async () => {
    setupProject(); // a -> b is a fresh, valid selection
    await renderAndOpenAddEdge();

    const addBtn = within(addEdgeDialog()).getByRole("button", { name: "Add" });
    expect(addBtn).not.toBeDisabled();
  });

  it("Add stays open, mutates the store, and advances the source for chaining", async () => {
    setupProject();
    await renderAndOpenAddEdge();

    const before = useAppStore.getState().skeleton!.edges.length;
    expect(selectionText()).toEqual(["a", "b"]); // initial selection

    fireEvent.click(
      within(addEdgeDialog()).getByRole("button", { name: "Add" })
    );

    // 1) Store edge count increased by 1, with the expected a -> b edge. The
    //    new edge lives at the PRE-add index `before` (also the value passed to
    //    setSelectedEdgeIdx), guarding against the in-place-push off-by-one.
    const edges = useAppStore.getState().skeleton!.edges;
    expect(edges.length).toBe(before + 1);
    expect(edges[before].source.name).toBe("a");
    expect(edges[before].destination.name).toBe("b");

    // 2) Dialog is STILL OPEN (rapid chaining) — title + footer "Done" remain.
    expect(screen.getByText("Add Edge")).toBeInTheDocument();
    expect(
      within(addEdgeDialog()).getByRole("button", { name: "Done" })
    ).toBeInTheDocument();

    // 3) Source advanced to the just-added destination "b"; its first valid
    //    destination is "a" (b's valid dests are {a, c}; "a" comes first).
    expect(selectionText()).toEqual(["b", "a"]);
  });
});
