/**
 * Render tests for the Skeleton panel's "Load From File…" / "Save As…" wiring
 * (#163, Task 4).
 *
 * These prove the PANEL ORCHESTRATION, not the IO/diff/command cores (those are
 * covered by Task 1's skeletonIO tests, Task 2's OpenSkeletonCommand tests, and
 * Task 3's ReplaceSkeletonDialog tests). To keep no real picker / HDF5 decode
 * from running under the bun test runner, we mock:
 *   - `@/platform`        → a fake `getPlatform()` whose `showOpenDialog` returns
 *                            a fake `File` (browser shape) and whose `isTauri` is
 *                            false (so Save As routes to the browser path).
 *   - `@/lib/skeletonIO`  → `parseSkeletonFile` returns a known Skeleton; we let
 *                            the REAL pure `compareSkeletons` run, and stub
 *                            `serializeSkeletonYaml` to a sentinel YAML string.
 *   - `@/lib/exportUtils` → spy `downloadFile` (Save As, no File-System-Access).
 *
 * Covered:
 *   - Buttons render; Save As… disabled at 0 nodes, enabled with nodes.
 *   - Load into a 0-node (seed) skeleton → direct apply, store skeleton swapped.
 *   - Load into an existing skeleton with a diff → ReplaceSkeletonDialog opens.
 *   - Save As… (browser, no FSA) → downloadFile called with YAML + .yaml name.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  beforeAll,
  vi,
} from "../bun-test";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  within,
} from "@testing-library/react";
import { useAppStore } from "@/stores/appStore";
import { Labels, Skeleton } from "@talmolab/sleap-io.js";

// Toast is fire-and-forget here; stub it so handlers don't depend on sonner.
vi.mock("@/lib/notify", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

// Radix dialogs need ResizeObserver in the DOM shim.
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

/** Reset the store + unmount any prior render between tests. */
function resetStore() {
  cleanup();
  useAppStore.setState(useAppStore.getInitialState());
}

/** Load a project whose single skeleton has the given node names. */
function setupProject(nodeNames: string[]) {
  const skeleton = new Skeleton({ nodes: nodeNames, name: "current" });
  const labels = new Labels({ videos: [], skeletons: [skeleton] });
  useAppStore.getState().setLabels(labels, "test.slp");
  return { labels, skeleton };
}

describe("SkeletonPanel — Load From File… / Save As… (#163)", () => {
  beforeEach(() => {
    resetStore();
  });

  it("renders both buttons; Save As… is disabled at 0 nodes and enabled with nodes", async () => {
    // 0-node seed skeleton.
    setupProject([]);
    const { SkeletonPanel } = await import(
      "@/components/panels/SkeletonPanel"
    );
    const view = render(<SkeletonPanel />);

    expect(
      screen.getByRole("button", { name: /load from file/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /save as/i }),
    ).toBeDisabled();

    // Re-render with a populated skeleton: Save As… becomes enabled.
    view.unmount();
    setupProject(["a", "b"]);
    render(<SkeletonPanel />);
    expect(screen.getByRole("button", { name: /save as/i })).not.toBeDisabled();
  });

  it("Load into a 0-node skeleton applies the imported skeleton directly (no dialog)", async () => {
    setupProject([]);

    const imported = new Skeleton({ nodes: ["head", "tail"], name: "imported" });

    // Browser-shape platform: showOpenDialog returns a single File.
    vi.mock("@/platform", () => ({
      getPlatform: vi.fn(async () => ({
        isTauri: false,
        showOpenDialog: vi.fn(async () => new File(["{}"], "imported.json")),
        showSaveDialog: vi.fn(async () => null),
        readFile: vi.fn(),
        writeFile: vi.fn(),
        exists: vi.fn(async () => false),
      })),
    }));
    vi.mock("@/lib/skeletonIO", () => ({
      parseSkeletonFile: vi.fn(async () => imported),
      // Let the real compareSkeletons/serializeSkeletonYaml run via the panel?
      // No — the panel imports these from the SAME module, so provide them.
      compareSkeletons: (oldNames: string[], newNames: string[]) => {
        const oldSet = new Set(oldNames);
        const newSet = new Set(newNames);
        return {
          renameNodes: oldNames.filter((n) => newSet.has(n)),
          deleteNodes: oldNames.filter((n) => !newSet.has(n)),
          addNodes: newNames.filter((n) => !oldSet.has(n)),
        };
      },
      serializeSkeletonYaml: vi.fn(() => "name: imported\n"),
    }));

    const { SkeletonPanel } = await import(
      "@/components/panels/SkeletonPanel"
    );
    render(<SkeletonPanel />);

    fireEvent.click(screen.getByRole("button", { name: /load from file/i }));

    await waitFor(() => {
      const names =
        useAppStore.getState().skeleton?.nodes.map((n) => n.name) ?? [];
      expect(names).toEqual(["head", "tail"]);
    });

    // Direct apply: no Replace dialog appears.
    expect(screen.queryByText(/replace nodes/i)).not.toBeInTheDocument();
  });

  it("Load into an existing skeleton with a node-set diff opens the ReplaceSkeletonDialog", async () => {
    // Current nodes {a, b}; imported {b, c} → addNodes=[c], deleteNodes=[a].
    setupProject(["a", "b"]);

    const imported = new Skeleton({ nodes: ["b", "c"], name: "imported" });

    vi.mock("@/platform", () => ({
      getPlatform: vi.fn(async () => ({
        isTauri: false,
        showOpenDialog: vi.fn(async () => new File(["{}"], "imported.json")),
        showSaveDialog: vi.fn(async () => null),
        readFile: vi.fn(),
        writeFile: vi.fn(),
        exists: vi.fn(async () => false),
      })),
    }));
    vi.mock("@/lib/skeletonIO", () => ({
      parseSkeletonFile: vi.fn(async () => imported),
      compareSkeletons: (oldNames: string[], newNames: string[]) => {
        const oldSet = new Set(oldNames);
        const newSet = new Set(newNames);
        return {
          renameNodes: oldNames.filter((n) => newSet.has(n)),
          deleteNodes: oldNames.filter((n) => !newSet.has(n)),
          addNodes: newNames.filter((n) => !oldSet.has(n)),
        };
      },
      serializeSkeletonYaml: vi.fn(() => "name: imported\n"),
    }));

    const { SkeletonPanel } = await import(
      "@/components/panels/SkeletonPanel"
    );
    render(<SkeletonPanel />);

    fireEvent.click(screen.getByRole("button", { name: /load from file/i }));

    // The Replace dialog opens (its title is "Replace Nodes").
    await waitFor(() => {
      expect(screen.getByText(/replace nodes/i)).toBeInTheDocument();
    });
    // Scope to the dialog so panel-table node names don't collide. The diff
    // summary lists the deleted node ("a") and the added node ("c"); "c" also
    // appears as the link-table "New" row, so allow multiple matches.
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getAllByText("a").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("c").length).toBeGreaterThan(0);

    // The store skeleton is unchanged until the user confirms.
    expect(
      useAppStore.getState().skeleton?.nodes.map((n) => n.name),
    ).toEqual(["a", "b"]);
  });

  it("Save As… (browser, no File-System-Access) routes to downloadFile with YAML + .yaml name", async () => {
    setupProject(["head", "tail"]);

    const downloadFileSpy = vi.fn(
      (_content: string | Blob, _filename: string, _mime?: string) => undefined,
    );

    vi.mock("@/platform", () => ({
      getPlatform: vi.fn(async () => ({
        isTauri: false,
        showOpenDialog: vi.fn(async () => null),
        showSaveDialog: vi.fn(async () => null),
        readFile: vi.fn(),
        writeFile: vi.fn(),
        exists: vi.fn(async () => false),
      })),
    }));
    vi.mock("@/lib/skeletonIO", () => ({
      parseSkeletonFile: vi.fn(),
      compareSkeletons: vi.fn(() => ({
        renameNodes: [],
        deleteNodes: [],
        addNodes: [],
      })),
      serializeSkeletonYaml: vi.fn(() => "name: current\nnodes:\n  - head\n  - tail\n"),
    }));
    vi.mock("@/lib/exportUtils", () => ({
      downloadFile: downloadFileSpy,
      suggestSaveFilename: (name: string, ext: string) => `${name}${ext}`,
    }));

    // Ensure the browser File-System-Access path is NOT taken.
    const hadFSA = "showSaveFilePicker" in window;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).showSaveFilePicker;

    const { SkeletonPanel } = await import(
      "@/components/panels/SkeletonPanel"
    );
    render(<SkeletonPanel />);

    fireEvent.click(screen.getByRole("button", { name: /save as/i }));

    await waitFor(() => {
      expect(downloadFileSpy).toHaveBeenCalled();
    });
    const [content, filename] = downloadFileSpy.mock.calls[0];
    expect(String(content)).toContain("head");
    expect(String(content)).toContain("tail");
    expect(String(filename)).toMatch(/\.yaml$/);

    if (hadFSA) {
      // (cannot restore the original; not needed — isolate gives a fresh global)
    }
  });

  it("Load with an IDENTICAL node set applies directly (only edges change, no dialog)", async () => {
    // Current {a, b}; imported also {a, b} (a DIFFERENT edge), so
    // addNodes=[]+deleteNodes=[] → the panel applies directly, no Replace UI.
    const { skeleton: current } = setupProject(["a", "b"]);
    // The current skeleton starts with no edges; the import adds one.
    expect(current.edges.length).toBe(0);

    const imported = new Skeleton({ nodes: ["a", "b"], name: "imported" });
    imported.addEdge(imported.nodes[0], imported.nodes[1]);

    vi.mock("@/platform", () => ({
      getPlatform: vi.fn(async () => ({
        isTauri: false,
        showOpenDialog: vi.fn(async () => new File(["{}"], "imported.json")),
        showSaveDialog: vi.fn(async () => null),
        readFile: vi.fn(),
        writeFile: vi.fn(),
        exists: vi.fn(async () => false),
      })),
    }));
    vi.mock("@/lib/skeletonIO", () => ({
      parseSkeletonFile: vi.fn(async () => imported),
      compareSkeletons: (oldNames: string[], newNames: string[]) => {
        const oldSet = new Set(oldNames);
        const newSet = new Set(newNames);
        return {
          renameNodes: oldNames.filter((n) => newSet.has(n)),
          deleteNodes: oldNames.filter((n) => !newSet.has(n)),
          addNodes: newNames.filter((n) => !oldSet.has(n)),
        };
      },
      serializeSkeletonYaml: vi.fn(() => "name: imported\n"),
    }));

    const { SkeletonPanel } = await import(
      "@/components/panels/SkeletonPanel"
    );
    render(<SkeletonPanel />);

    fireEvent.click(screen.getByRole("button", { name: /load from file/i }));

    // Direct apply: OpenSkeletonCommand ran in place (same node names, +1 edge),
    // observable on the live project skeleton object.
    await waitFor(() => {
      expect(useAppStore.getState().skeleton?.edges.length).toBe(1);
    });
    expect(
      useAppStore.getState().skeleton?.nodes.map((n) => n.name),
    ).toEqual(["a", "b"]);

    // No Replace dialog at all.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText(/replace nodes/i)).not.toBeInTheDocument();
  });

  it("Parse failure toasts an error and leaves the store skeleton unchanged", async () => {
    const { skeleton: before } = setupProject(["a", "b"]);

    vi.mock("@/platform", () => ({
      getPlatform: vi.fn(async () => ({
        isTauri: false,
        showOpenDialog: vi.fn(async () => new File(["nope"], "bad.json")),
        showSaveDialog: vi.fn(async () => null),
        readFile: vi.fn(),
        writeFile: vi.fn(),
        exists: vi.fn(async () => false),
      })),
    }));
    vi.mock("@/lib/skeletonIO", () => ({
      // Reject mid-flow (after the dialog + read) to exercise the catch block.
      parseSkeletonFile: vi.fn(async () => {
        throw new Error("bad skeleton file");
      }),
      compareSkeletons: vi.fn(() => ({
        renameNodes: [],
        deleteNodes: [],
        addNodes: [],
      })),
      serializeSkeletonYaml: vi.fn(() => ""),
    }));

    // Grab the mocked toast so we can assert error() fired.
    const { toast } = await import("@/lib/notify");

    const { SkeletonPanel } = await import(
      "@/components/panels/SkeletonPanel"
    );
    render(<SkeletonPanel />);

    fireEvent.click(screen.getByRole("button", { name: /load from file/i }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });

    // No partial mutation: same skeleton object, same node names.
    expect(useAppStore.getState().skeleton).toBe(before);
    expect(
      useAppStore.getState().skeleton?.nodes.map((n) => n.name),
    ).toEqual(["a", "b"]);
    // And certainly no Replace dialog.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
