/**
 * Merge into Project, several files: skipping past a file that is still
 * loading must not let its late result replace the preview of the file shown
 * next (or merge the wrong file). The loader is faked with promises the test
 * resolves by hand, to force the late finish deterministically.
 */

import { describe, it, expect, beforeEach, beforeAll } from "../bun-test";
import { vi } from "../bun-test";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";
import { Instance, Labels, LabeledFrame, Skeleton, Video } from "@talmolab/sleap-io.js";

const platform = {
  isTauri: true,
  showOpenDialog: async () => ["/picked/slow.slp", "/picked/fast.slp"],
  readFile: async () => new Uint8Array(),
};
vi.mock("@/platform/index", () => ({
  getPlatform: async () => platform,
  isTauri: true,
  consumeLastBrowserFileHandle: () => null,
}));
vi.mock("@/lib/notify", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}));

/** Pending loads by path; the test resolves them. */
const pending = new Map<string, (labels: Labels) => void>();
vi.mock("@/lib/loadProject", () => ({
  loadLabelsFromSlpPath: (path: string) =>
    new Promise<Labels>((resolve) => pending.set(path, resolve)),
  loadLabelsFromSlpFile: () => Promise.reject(new Error("not used")),
}));

const { useAppStore } = await import("@/stores/appStore");
const { MergeProjectDialog } = await import("@/components/dialogs/MergeProjectDialog");

beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

function project(frameIdxs: number[], nodes: string[]) {
  const sk = new Skeleton({ nodes, name: "s" });
  const v = new Video({ filename: "/d/session.mp4", backendMetadata: { shape: [100, 8, 8, 1] }, openBackend: false });
  return new Labels({
    videos: [v],
    skeletons: [sk],
    labeledFrames: frameIdxs.map(
      (frameIdx) =>
        new LabeledFrame({ video: v, frameIdx, instances: [Instance.fromArray(nodes.map(() => [1, 2]), sk)] })
    ),
  });
}

describe("Merge into Project: a late load after Skip", () => {
  beforeEach(() => {
    cleanup();
    pending.clear();
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("is ignored: the next file's preview stays, and Merge merges the next file", async () => {
    const labels = project([0], ["head", "tail"]);
    useAppStore.getState().setLabels(labels, "base.slp");
    useAppStore.getState().setMergeProjectDialogOpen(true);
    render(<MergeProjectDialog />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Choose / }));
    });
    await waitFor(() => expect(pending.has("/picked/slow.slp")).toBe(true));

    // Skip slow.slp while it is still loading.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Skip this file" }));
    });
    await waitFor(() => expect(pending.has("/picked/fast.slp")).toBe(true));

    // fast.slp finishes first: a clean, mergeable file.
    await act(async () => pending.get("/picked/fast.slp")!(project([5], ["head", "tail"])));
    await waitFor(() => expect(screen.getByText(/clean merge/)).toBeInTheDocument());

    // Then slow.slp finishes late, with a skeleton that would block the merge.
    await act(async () => pending.get("/picked/slow.slp")!(project([9], ["nose", "ear", "tail"])));
    await act(async () => new Promise((r) => setTimeout(r, 20)));

    // Plain booleans, so a failure reports quickly (printing a DOM node in a
    // failure message can take bun a very long time).
    expect(screen.queryByTitle("fast.slp") !== null).toBe(true);
    expect(screen.queryByText(/skeleton doesn't match/) === null).toBe(true);
    expect((screen.getByRole("button", { name: /^Merge/ }) as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Merge/ }));
    });
    await waitFor(() => expect(useAppStore.getState().mergeProjectDialogOpen).toBe(false));
    expect(labels.labeledFrames.map((lf) => lf.frameIdx).sort((a, b) => a - b)).toEqual([0, 5]);
  });
});
