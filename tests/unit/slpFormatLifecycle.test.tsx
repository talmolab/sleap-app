/**
 * Tests for SLP format status pill, popover, one-time 2.x -> 3.0 upgrade toast,
 * and one-time upgrade confirmation dialog when overwriting an on-disk 2.x file.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "../bun-test";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";
import {
  Instance,
  Labels,
  LabeledFrame,
  Skeleton,
  Video,
  loadSlp,
} from "@talmolab/sleap-io.js";
import { isUnlabeledPoint, metadataOf } from "@/lib/slpFormat";
import type { SlpFormatAnswer, SlpFormatPrompt } from "@/stores/slpFormatStore";

const toastInfo = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();
const savedFiles = new Map<string, Uint8Array>();
let saveDialogPath: string | null = "/data/new_copy.slp";

vi.mock("@/lib/notify", () => ({
  toast: Object.assign(vi.fn(), {
    info: toastInfo,
    success: toastSuccess,
    error: toastError,
    warning: vi.fn(),
  }),
}));

vi.mock("@/platform/index", () => ({
  isTauri: true,
  getPlatform: async () => ({
    isTauri: true,
    writeFile: async (path: string, bytes: Uint8Array) => {
      savedFiles.set(path, new Uint8Array(bytes));
    },
    showSaveDialog: async () => saveDialogPath,
  }),
}));

vi.mock("@/lib/nativeWrite", () => ({
  renameFile: vi.fn(async () => {}),
  removeFile: vi.fn(async () => {}),
  copyFile: vi.fn(async () => {}),
  writeOpen: vi.fn(async () => {}),
  writeOpenAppend: vi.fn(async () => {}),
  writeAt: vi.fn(async () => {}),
  readAt: vi.fn(async () => new Uint8Array()),
  truncateFile: vi.fn(async () => {}),
  writeClose: vi.fn(async () => {}),
  withNativeWriteHandle: <T,>(work: () => Promise<T>) => work(),
}));

vi.mock("@/lib/nativeRange", () => ({
  fileSize: vi.fn(async () => 1000),
  readRange: vi.fn(),
}));

const { useAppStore } = await import("@/stores/appStore");
const { useSlpFormatStore } = await import("@/stores/slpFormatStore");
const {
  inspectProjectFormat,
  deriveSlpCopyFilename,
  defaultUnmappedForLabels,
  resetFormat3UpgradeTracking,
} = await import("@/lib/slpFormatStatus");
const { saveProjectAsSlp } = await import("@/lib/saveProject");
const { StatusBar } = await import("@/components/layout/StatusBar");
const { SlpFormatDialog } = await import("@/components/dialogs/SlpFormatDialog");

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

function makeV2Project(withFormat3Content = false) {
  const skeleton = new Skeleton({ nodes: ["head", "tail"], name: "mouse" });
  const video = new Video({
    filename: "/data/movie.mp4",
    backendMetadata: { shape: [100, 64, 64, 1] },
    openBackend: false,
  });
  const inst = new Instance({
    skeleton,
    points: [
      { xy: [10, 20], visible: true, complete: true },
      withFormat3Content
        ? { xy: [NaN, NaN], visible: false, complete: false, labeled: false }
        : { xy: [30, 40], visible: true, complete: true },
    ],
  });
  if (withFormat3Content) {
    inst.metadata = { annotator: "alice" };
  }
  const lf = new LabeledFrame({ video, frameIdx: 0, instances: [inst] });
  const labels = new Labels({
    videos: [video],
    skeletons: [skeleton],
    labeledFrames: [lf],
  });
  useAppStore.getState().setLabels(labels, "proj.slp", "/data/proj.slp");
  useAppStore.getState().setVideo(video);
  return { labels, skeleton, video, lf, inst };
}

const activeUnsubs: Array<() => void> = [];
function answerNextPrompt(answer: SlpFormatAnswer): SlpFormatPrompt[] {
  const seen: SlpFormatPrompt[] = [];
  const unsub = useSlpFormatStore.subscribe((s) => {
    if (!s.prompt) return;
    seen.push(s.prompt);
    unsub();
    queueMicrotask(() => useSlpFormatStore.getState().respond(answer));
  });
  activeUnsubs.push(unsub);
  return seen;
}

describe("slpFormatStatus pure inspection helpers", () => {
  beforeEach(() => {
    cleanup();
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("classifies 2.x, pending-upgrade 2.x->3.0, native 3.0, and View-only projects", () => {
    const { labels, inst } = makeV2Project(false);
    expect(inspectProjectFormat(labels)?.pillLabel).toBe("SLP 2.x");
    expect(inspectProjectFormat(labels)?.pendingUpgradeFromV2).toBe(false);
    expect(defaultUnmappedForLabels(labels)).toBe("absent");

    // Introducing an unlabeled node triggers pending SLP 3.0 upgrade.
    inst.points = [
      { xy: [10, 20], visible: true, complete: true, name: "head" },
      { xy: [NaN, NaN], visible: false, complete: false, labeled: false, name: "tail" },
    ];
    const upgraded = inspectProjectFormat(labels)!;
    expect(upgraded.pillLabel).toBe("SLP 3.0 (pending save)");
    expect(upgraded.pendingUpgradeFromV2).toBe(true);
    expect(upgraded.summary.unlabeledUserPoints).toBe(1);
    expect(defaultUnmappedForLabels(labels)).toBe("unlabeled");

    // Native 3.0 source format reports SLP 3.0 (not pending).
    labels.sourceFormat = Object.freeze({
      formatId: 3,
      access: "keep" as const,
      summary: upgraded.summary,
      labelsPath: "/data/proj.slp",
    });
    expect(inspectProjectFormat(labels)?.pillLabel).toBe("SLP 3.0");
    expect(inspectProjectFormat(labels)?.pendingUpgradeFromV2).toBe(false);

    // View-only reports SLP 3.0 · View only.
    labels.sourceFormat = Object.freeze({
      formatId: 3,
      access: "view" as const,
      summary: upgraded.summary,
      labelsPath: "/data/proj.slp",
    });
    expect(inspectProjectFormat(labels)?.pillLabel).toBe("SLP 3.0 · View only");
    expect(inspectProjectFormat(labels)?.viewOnly).toBe(true);
  });

  it("derives non-clobbering suggested copy filenames", () => {
    expect(deriveSlpCopyFilename("mouse.slp", "v2", true)).toBe("mouse.v2.slp");
    expect(deriveSlpCopyFilename("mouse.pkg.slp", "v2", true)).toBe("mouse.pkg.v2.slp");
    expect(deriveSlpCopyFilename("mouse.slp", "v3", false)).toBe("mouse.v3.slp");
    expect(deriveSlpCopyFilename("mouse.slp", "auto", true)).toBe("mouse.copy.slp");
  });
});

describe("StatusBar format pill, popover & one-time upgrade toast", () => {
  beforeEach(() => {
    cleanup();
    useAppStore.setState(useAppStore.getInitialState());
    useSlpFormatStore.setState({
      prompt: null,
      saveSlpCopyDialogOpen: false,
      saveSlpCopyInitialVersion: "auto",
    });
    toastInfo.mockClear();
  });

  it("shows SLP 2.x pill, transitions live to SLP 3.0 (pending save) with one-time toast, and opens Export SLP Copy from popover", async () => {
    const { labels, inst } = makeV2Project(false);
    resetFormat3UpgradeTracking(labels);

    render(<StatusBar />);
    const pill = screen.getByTestId("status-slp-format-pill");
    expect(pill.textContent).toBe("SLP 2.x");
    expect(toastInfo).not.toHaveBeenCalled();

    // Introduce 3.0 data in-place and bump editSeq.
    await act(async () => {
      inst.points = [
        { xy: [10, 20], visible: true, complete: true, name: "head" },
        { xy: [NaN, NaN], visible: false, complete: false, labeled: false, name: "tail" },
      ];
      useAppStore.getState().markChanged();
    });

    expect(screen.getByTestId("status-slp-format-pill").textContent).toBe(
      "SLP 3.0 (pending save)",
    );
    expect(toastInfo).toHaveBeenCalledTimes(1);

    // Subsequent edits must not spam the toast.
    await act(async () => {
      useAppStore.getState().markChanged();
    });
    expect(toastInfo).toHaveBeenCalledTimes(1);

    // Clicking the pill opens the popover with compatibility info & Export SLP Copy button.
    fireEvent.click(screen.getByTestId("status-slp-format-pill"));
    const popover = await screen.findByTestId("status-slp-format-popover");
    expect(popover.textContent).toContain("1 unlabeled node");
    expect(popover.textContent).toContain("sleap-io >= 0.10");

    fireEvent.click(screen.getByTestId("status-export-slp-copy"));
    expect(useSlpFormatStore.getState().saveSlpCopyDialogOpen).toBe(true);
  });
});

describe("2.x -> 3.0 overwrite upgrade confirmation dialog", () => {
  beforeEach(() => {
    cleanup();
    while (activeUnsubs.length) activeUnsubs.pop()!();
    savedFiles.clear();
    saveDialogPath = "/data/new_copy.slp";
    useAppStore.setState(useAppStore.getInitialState());
    useSlpFormatStore.setState({
      prompt: null,
      saveSlpCopyDialogOpen: false,
      saveSlpCopyInitialVersion: "auto",
    });
    toastInfo.mockClear();
    toastSuccess.mockClear();
    toastError.mockClear();
  });

  it("renders all four actions in SlpFormatDialog for upgrade-on-save prompt", async () => {
    const { labels } = makeV2Project(true);
    const status = inspectProjectFormat(labels)!;
    render(<SlpFormatDialog />);

    let answerPromise!: Promise<SlpFormatAnswer>;
    await act(async () => {
      answerPromise = useSlpFormatStore.getState().ask({
        kind: "upgrade-on-save",
        fileName: "proj.slp",
        summary: status.summary,
      });
    });

    await waitFor(() => {
      expect(screen.getByText("Upgrade proj.slp to SLP 3.0?")).toBeInTheDocument();
    });
    expect(screen.getByTestId("slp-upgrade-features").textContent).toContain("1 unlabeled node");
    expect(screen.getByTestId("slp-upgrade-features").textContent).toContain("annotator");
    expect(screen.getByTestId("slp-upgrade-export-v2")).toBeInTheDocument();
    expect(screen.getByTestId("slp-upgrade-save-as")).toBeInTheDocument();
    expect(screen.getByTestId("slp-upgrade-v3")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("slp-upgrade-v3"));
    expect(await answerPromise).toBe("upgrade-v3");
  });

  it("Cancel writes nothing; Save 2.x Copy opens SaveSlpCopyDialog in v2 mode without overwriting", async () => {
    const { labels } = makeV2Project(true);
    resetFormat3UpgradeTracking(labels);

    const p1 = answerNextPrompt(null);
    await saveProjectAsSlp(labels, "proj.slp");
    expect(p1).toHaveLength(1);
    expect(p1[0].kind).toBe("upgrade-on-save");
    expect(savedFiles.size).toBe(0);

    const p2 = answerNextPrompt("export-v2");
    await saveProjectAsSlp(labels, "proj.slp");
    expect(p2).toHaveLength(1);
    expect(savedFiles.size).toBe(0);
    expect(useSlpFormatStore.getState().saveSlpCopyDialogOpen).toBe(true);
    expect(useSlpFormatStore.getState().saveSlpCopyInitialVersion).toBe("v2");
  });

  it("Save As New File writes to the new path and leaves the original 2.x path untouched", async () => {
    const { labels } = makeV2Project(true);
    resetFormat3UpgradeTracking(labels);

    answerNextPrompt("save-as");
    await saveProjectAsSlp(labels, "proj.slp");

    expect(savedFiles.has("/data/proj.slp")).toBe(false);
    expect(savedFiles.has("/data/new_copy.slp")).toBe(true);
    const back = await loadSlp(savedFiles.get("/data/new_copy.slp")!, { openVideos: false });
    expect(back.sourceFormat?.formatId).toBe(3);
    expect(isUnlabeledPoint(back.labeledFrames[0].instances[0].points[1])).toBe(true);
  });

  it("Save as SLP 3.0 writes native format 3.0, clears pending state, and does not re-prompt on second save", async () => {
    const { labels } = makeV2Project(true);
    resetFormat3UpgradeTracking(labels);

    const firstPrompts = answerNextPrompt("upgrade-v3");
    await saveProjectAsSlp(labels, "proj.slp");
    expect(firstPrompts).toHaveLength(1);
    expect(savedFiles.has("/data/proj.slp")).toBe(true);

    const back = await loadSlp(savedFiles.get("/data/proj.slp")!, { openVideos: false });
    expect(back.sourceFormat?.formatId).toBe(3);
    expect(isUnlabeledPoint(back.labeledFrames[0].instances[0].points[1])).toBe(true);
    expect(metadataOf(back.labeledFrames[0].instances[0])).toEqual({ annotator: "alice" });

    // Status transitions from pending to SLP 3.0, and a second save prompts nothing.
    expect(inspectProjectFormat(labels)?.pillLabel).toBe("SLP 3.0");
    const secondPrompts = answerNextPrompt(null);
    await saveProjectAsSlp(labels, "proj.slp");
    expect(secondPrompts).toHaveLength(0);
  });
});
