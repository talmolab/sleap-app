/**
 * File ▸ Merge into Project with several files, as legacy SLEAP's MergeProject
 * (its "import predictions" action, sleap/gui/commands.py) does: the picker
 * takes any number of .slp files, and each gets its own merge dialog in turn.
 * Closing one moves on to the next file. Audit bug B11.
 *
 * Real .slp bytes (written and read back with sleap-io.js); only the platform
 * file picker/reader and toasts are faked. The picker returns paths, as on
 * desktop: sleap-io.js under bun reads bytes or paths but not browser `File`s,
 * and the queue logic is the same for both (the browser path is checked live).
 */

import { describe, it, expect, beforeEach, beforeAll } from "../bun-test";
import { vi } from "../bun-test";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";
import {
  Instance,
  Labels,
  LabeledFrame,
  Skeleton,
  Video,
  saveSlpToBytes,
} from "@talmolab/sleap-io.js";

let pickResult: string[] | string | null = null;
const pickCalls: Array<{ multiple?: boolean; filters?: Array<{ extensions: string[] }> }> = [];
/** The "disk": path -> bytes. */
const disk = new Map<string, Uint8Array>();
const platform = {
  isTauri: true,
  showOpenDialog: async (o: { multiple?: boolean; filters?: Array<{ extensions: string[] }> }) => {
    pickCalls.push(o);
    return pickResult;
  },
  readFile: async (path: string) => {
    const bytes = disk.get(path);
    if (!bytes) throw new Error(`No such file: ${path}`);
    return bytes;
  },
};
vi.mock("@/platform/index", () => ({
  getPlatform: async () => platform,
  isTauri: true,
  consumeLastBrowserFileHandle: () => null,
}));
const toastSuccess = vi.fn((..._args: unknown[]) => {});
vi.mock("@/lib/notify", () => ({
  toast: Object.assign(vi.fn(), {
    success: toastSuccess,
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }),
}));

const { useAppStore } = await import("@/stores/appStore");
const { commandContext } = await import("@/commands/CommandContext");
const { MergeProjectDialog, pickedSources } = await import(
  "@/components/dialogs/MergeProjectDialog"
);

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

const NODES = ["head", "tail"];

function video(dir: string) {
  return new Video({
    filename: `${dir}/session.mp4`,
    backendMetadata: { shape: [1000, 64, 64, 1] },
    openBackend: false,
  });
}

function labelsWithFrames(frameIdxs: number[], dir: string, nodes = NODES) {
  const sk = new Skeleton({ nodes, name: "s" });
  const v = video(dir);
  return new Labels({
    videos: [v],
    skeletons: [sk],
    labeledFrames: frameIdxs.map(
      (frameIdx) =>
        new LabeledFrame({
          video: v,
          frameIdx,
          instances: [Instance.fromArray(nodes.map((_, i) => [10 + i, 20 + i]), sk)],
        })
    ),
  });
}

/** A real .slp on the fake disk holding user instances on `frameIdxs`; returns its path. */
async function slpFile(name: string, frameIdxs: number[], nodes = NODES): Promise<string> {
  const path = `/picked/${name}`;
  disk.set(path, await saveSlpToBytes(labelsWithFrames(frameIdxs, "/elsewhere", nodes)));
  return path;
}

/** The open project: frames 0 and 1. */
function openProject() {
  const labels = labelsWithFrames([0, 1], "/data");
  useAppStore.getState().setLabels(labels, "base.slp");
  useAppStore.getState().setMergeProjectDialogOpen(true);
  return labels;
}

const frameIdxs = (labels: Labels) => labels.labeledFrames.map((lf) => lf.frameIdx).sort((a, b) => a - b);

async function pickFiles(files: string[] | string | null) {
  pickResult = files;
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /^Choose / }));
  });
}

/**
 * Wait until `name` is the file shown AND it has finished loading: either its
 * preview is up, or it failed with an error.
 */
async function waitForPreviewOf(name: string) {
  await waitFor(() => {
    expect(screen.getByTitle(name)).toBeInTheDocument();
    expect(screen.queryByText(/Reading, matching/)).toBeNull();
    const done =
      screen.queryByText("Preview (nothing changed yet)") ?? screen.queryByTestId("merge-load-error");
    expect(done).not.toBeNull();
  });
}

async function click(name: RegExp | string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

const position = () => screen.queryByTestId("merge-queue-position")?.textContent ?? null;
const isOpen = () => useAppStore.getState().mergeProjectDialogOpen;

describe("pickedSources", () => {
  it("turns any picker result into a list", () => {
    const f = new File(["x"], "a.slp");
    // Browser pickers return File(s); desktop returns path(s).
    expect(pickedSources(null)).toEqual([]);
    expect(pickedSources(undefined)).toEqual([]);
    expect(pickedSources(f)).toEqual([f]);
    expect(pickedSources([f, f])).toEqual([f, f]);
    expect(pickedSources("/p/a.slp")).toEqual(["/p/a.slp"]);
    expect(pickedSources(["/p/a.slp", "/p/b.slp"])).toEqual(["/p/a.slp", "/p/b.slp"]);
  });
});

describe("Merge into Project: several files, one at a time", () => {
  beforeEach(() => {
    cleanup();
    useAppStore.setState(useAppStore.getInitialState());
    while (commandContext.canUndo) commandContext.undo();
    pickResult = null;
    pickCalls.length = 0;
    disk.clear();
    toastSuccess.mockClear();
  });

  it("asks the picker for several .slp files", async () => {
    openProject();
    render(<MergeProjectDialog />);
    await pickFiles(null);

    expect(pickCalls).toHaveLength(1);
    expect(pickCalls[0].multiple).toBe(true);
    expect(pickCalls[0].filters?.[0].extensions).toEqual(["slp"]);
  });

  it("canceling the picker changes nothing", async () => {
    const labels = openProject();
    render(<MergeProjectDialog />);
    await pickFiles(null);

    expect(position()).toBeNull();
    expect(screen.queryByText(/Preview/)).toBeNull();
    expect(frameIdxs(labels)).toEqual([0, 1]);
    expect(isOpen()).toBe(true);
  });

  it("merges each picked file in turn, then closes, each as its own undo step", async () => {
    const labels = openProject();
    const a = await slpFile("a.slp", [10, 11]);
    const b = await slpFile("b.slp", [20]);
    render(<MergeProjectDialog />);

    await pickFiles([a, b]);
    await waitForPreviewOf("a.slp");
    expect(position()).toBe("File 1 of 2");
    expect(frameIdxs(labels)).toEqual([0, 1]); // nothing yet

    await click(/^Merge/);
    await waitForPreviewOf("b.slp");
    expect(position()).toBe("File 2 of 2");
    expect(frameIdxs(labels)).toEqual([0, 1, 10, 11]);
    expect(isOpen()).toBe(true);

    await click(/^Merge/);
    await waitFor(() => expect(isOpen()).toBe(false));
    expect(frameIdxs(labels)).toEqual([0, 1, 10, 11, 20]);
    expect(toastSuccess).toHaveBeenCalledTimes(2);

    // Two undo steps: the first undoes only b.slp.
    expect(commandContext.undo()).toBe(true);
    expect(frameIdxs(useAppStore.getState().labels!)).toEqual([0, 1, 10, 11]);
    expect(commandContext.undo()).toBe(true);
    expect(frameIdxs(useAppStore.getState().labels!)).toEqual([0, 1]);
  });

  it("Skip this file leaves it out and moves on to the next", async () => {
    const labels = openProject();
    const a = await slpFile("a.slp", [10]);
    const b = await slpFile("b.slp", [20]);
    render(<MergeProjectDialog />);

    await pickFiles([a, b]);
    await waitForPreviewOf("a.slp");
    await click("Skip this file");
    await waitForPreviewOf("b.slp");
    expect(frameIdxs(labels)).toEqual([0, 1]);

    await click(/^Merge/);
    await waitFor(() => expect(isOpen()).toBe(false));
    expect(frameIdxs(labels)).toEqual([0, 1, 20]);
  });

  it("closing the dialog skips to the next file, like closing a legacy merge dialog; on the last it closes", async () => {
    const labels = openProject();
    const a = await slpFile("a.slp", [10]);
    const b = await slpFile("b.slp", [20]);
    render(<MergeProjectDialog />);

    await pickFiles([a, b]);
    await waitForPreviewOf("a.slp");
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    });
    await waitForPreviewOf("b.slp");
    expect(isOpen()).toBe(true);
    expect(position()).toBe("File 2 of 2");
    expect(screen.getByRole("button", { name: "Skip and close" })).toBeInTheDocument();

    await click("Skip and close");
    await waitFor(() => expect(isOpen()).toBe(false));
    expect(frameIdxs(labels)).toEqual([0, 1]);
  });

  it("a file that can't be read can be skipped, and the rest still merge", async () => {
    const labels = openProject();
    const broken = "/picked/broken.slp";
    disk.set(broken, new Uint8Array([1, 2, 3, 4]));
    const b = await slpFile("b.slp", [20]);
    render(<MergeProjectDialog />);

    await pickFiles([broken, b]);
    await waitForPreviewOf("broken.slp");
    expect(position()).toBe("File 1 of 2");
    expect(screen.getByRole("button", { name: /^Merge/ })).toBeDisabled();

    await click("Skip this file");
    await waitForPreviewOf("b.slp");
    await click(/^Merge/);
    await waitFor(() => expect(isOpen()).toBe(false));
    expect(frameIdxs(labels)).toEqual([0, 1, 20]);
  });

  it("a file with a different skeleton is blocked but can be skipped", async () => {
    const labels = openProject();
    const other = await slpFile("other.slp", [30], ["nose", "ear", "tail"]);
    const b = await slpFile("b.slp", [20]);
    render(<MergeProjectDialog />);

    await pickFiles([other, b]);
    await waitForPreviewOf("other.slp");
    expect(screen.getByText(/skeleton doesn't match/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Merge/ })).toBeDisabled();

    await click("Skip this file");
    await waitForPreviewOf("b.slp");
    await click(/^Merge/);
    await waitFor(() => expect(isOpen()).toBe(false));
    expect(frameIdxs(labels)).toEqual([0, 1, 20]);
  });

  it("previews each file against the project as merged so far", async () => {
    // b.slp repeats a.slp's frame 10 with the same instance: once a.slp is in,
    // b.slp's preview must see a conflict on it.
    const labels = openProject();
    const a = await slpFile("a.slp", [10]);
    const b = await slpFile("b.slp", [10]);
    render(<MergeProjectDialog />);

    await pickFiles([a, b]);
    await waitForPreviewOf("a.slp");
    expect(screen.getByText(/clean merge/)).toBeInTheDocument();
    await click(/^Merge/);

    await waitForPreviewOf("b.slp");
    expect(screen.getByRole("button", { name: /^Merge \(1 conflict\)/ })).toBeInTheDocument();
    expect(frameIdxs(labels)).toEqual([0, 1, 10]);
  });

  it("one file works as before: no counter, Cancel closes, Merge merges and closes", async () => {
    const labels = openProject();
    const a = await slpFile("a.slp", [10]);
    render(<MergeProjectDialog />);

    await pickFiles([a]);
    await waitForPreviewOf("a.slp");
    expect(position()).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    await click(/^Merge/);
    await waitFor(() => expect(isOpen()).toBe(false));
    expect(frameIdxs(labels)).toEqual([0, 1, 10]);
  });

  it("Cancel on a single file merges nothing", async () => {
    const labels = openProject();
    const a = await slpFile("a.slp", [10]);
    render(<MergeProjectDialog />);

    await pickFiles([a]);
    await waitForPreviewOf("a.slp");
    await click("Cancel");
    await waitFor(() => expect(isOpen()).toBe(false));
    expect(frameIdxs(labels)).toEqual([0, 1]);
    expect(commandContext.canUndo).toBe(false);
  });

  it("choosing new files mid-way replaces the remaining queue", async () => {
    const labels = openProject();
    const a = await slpFile("a.slp", [10]);
    const b = await slpFile("b.slp", [20]);
    const c = await slpFile("c.slp", [30]);
    render(<MergeProjectDialog />);

    await pickFiles([a, b]);
    await waitForPreviewOf("a.slp");
    await pickFiles([c]);
    await waitForPreviewOf("c.slp");
    expect(position()).toBeNull();

    await click(/^Merge/);
    await waitFor(() => expect(isOpen()).toBe(false));
    expect(frameIdxs(labels)).toEqual([0, 1, 30]);
  });

  it("reopening after it closed starts fresh", async () => {
    openProject();
    const a = await slpFile("a.slp", [10]);
    const b = await slpFile("b.slp", [20]);
    render(<MergeProjectDialog />);

    await pickFiles([a, b]);
    await waitForPreviewOf("a.slp");
    await click("Skip this file");
    await waitForPreviewOf("b.slp");
    await click("Skip and close");
    await waitFor(() => expect(isOpen()).toBe(false));

    await act(async () => useAppStore.getState().setMergeProjectDialogOpen(true));
    expect(position()).toBeNull();
    expect(screen.queryByText(/Preview/)).toBeNull();
    expect(screen.getByRole("button", { name: "Choose .slp files…" })).toBeInTheDocument();
  });
});
