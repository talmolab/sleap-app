/**
 * Tests for `File ▸ Export ▸ SLP Copy…`, `<SaveSlpCopyDialog />`, `saveSlpCopy`,
 * and `<ExportPackageDialog />` SLP format controls (real `sleap-io.js`
 * round-trip verification).
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

const savedFiles = new Map<string, Uint8Array>();
let pickedSavePath: string | null = "/out/session.v2.slp";
const executedCommands: Array<{ name: string; params: unknown }> = [];

vi.mock("@/platform/index", () => ({
  isTauri: true,
  consumeLastBrowserFileHandle: () => null,
  getPlatform: async () => ({
    isTauri: true,
    showSaveDialog: async () => pickedSavePath,
    writeFile: async (path: string, bytes: Uint8Array) => {
      savedFiles.set(path, new Uint8Array(bytes));
    },
  }),
}));

vi.mock("@/lib/notify", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
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

vi.mock("@/lib/exportToast", () => ({
  toastExported: vi.fn(),
}));

vi.mock("@/commands/CommandContext", () => ({
  commandContext: {
    execute: async (cmd: { name: string }, params?: unknown) => {
      executedCommands.push({ name: cmd.name, params });
    },
    undo: () => false,
    redo: () => false,
  },
}));

const { useAppStore } = await import("@/stores/appStore");
const { useSlpFormatStore } = await import("@/stores/slpFormatStore");
const { SaveSlpCopyDialog } = await import("@/components/dialogs/SaveSlpCopyDialog");
const { ExportPackageDialog } = await import(
  "@/components/dialogs/ExportPackageDialog"
);
const { buildAppMenu } = await import("@/lib/menu/appMenu");
const { searchableCommands } = await import("@/lib/menu/searchable");
const { packageSlpFormatParam } = await import(
  "@/commands/exportPackageCommands"
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

function makeFormat3Project() {
  const skeleton = new Skeleton({ nodes: ["head", "tail"], name: "mouse" });
  const video = new Video({
    filename: "/data/movie.mp4",
    backendMetadata: { shape: [50, 64, 64, 1] },
    openBackend: false,
  });
  const inst = new Instance({
    skeleton,
    points: [
      { xy: [10, 20], visible: true, complete: true },
      { xy: [NaN, NaN], visible: false, complete: false, labeled: false },
    ],
  });
  inst.metadata = { annotator: "bob" };
  const lf = new LabeledFrame({ video, frameIdx: 0, instances: [inst] });
  lf.metadata = { note: "check" };
  const labels = new Labels({
    videos: [video],
    skeletons: [skeleton],
    labeledFrames: [lf],
  });
  labels.sourceFormat = Object.freeze({
    formatId: 3,
    access: "keep" as const,
    summary: {
      formatId: 3,
      unlabeledPoints: 1,
      unlabeledUserPoints: 1,
      unlabeledPredictedPoints: 0,
      metadataKeys: { instances: ["annotator"], frames: ["note"], bboxes: [] },
      unknownColumns: [],
      unreadTables: [],
      lossless: false,
    },
    labelsPath: "/data/session.slp",
  });
  (labels as unknown as { _slpLayout?: string | null })._slpLayout = "v3";
  useAppStore.getState().setLabels(labels, "session.slp", "/data/session.slp");
  useAppStore.getState().setVideo(video);
  useAppStore.getState().markChanged();
  return labels;
}

describe("File ▸ Export ▸ SLP Copy… menu wiring", () => {
  beforeEach(() => {
    useSlpFormatStore.setState({
      saveSlpCopyDialogOpen: false,
      saveSlpCopyInitialVersion: "auto",
    });
  });

  it("exposes File ▸ Export ▸ SLP Copy… in appMenu and searchableCommands, opening SaveSlpCopyDialog", async () => {
    const menu = buildAppMenu({
      isTauri: true,
      projectLoaded: true,
      hasProjectPath: true,
      videoNames: ["a.mp4"],
      trackNames: [],
      hasInstance: false,
      hasClipboardInstance: false,
      skeletonHasNodes: true,
      undoLabel: null,
      redoLabel: null,
      navigationDomain: "all",
      sidebarCollapsed: false,
      sidebarSide: "right",
      sidebarMultiPanel: false,
      fit: false,
      followSelection: false,
      actualSize: false,
      defaultToPan: false,
      placementMode: false,
      showInstances: true,
      showNonVisibleNodes: true,
      qcDisplayMode: "all",
      showLabels: true,
      showEdges: true,
      showBboxes: true,
      showCentroids: true,
      showPoseBboxes: false,
      bboxDrawMode: false,
      showCrosshair: true,
      showInset: true,
      temporalLoupe: false,
      edgeStyle: "Line",
      markerSize: 4,
      poseOpacity: 100,
      nodeLabelSize: 10,
      trailLength: 0,
      trailNode: "centroid",
      trailNodeOptions: [],
      trailAlpha: 1,
      trailFade: true,
      trailWidth: 4,
      boldLines: false,
      showMeanNodeScore: false,
      palette: "standard",
      distinctlyColor: "auto",
      colorPredicted: false,
      showTrackScore: false,
      scrubProxyEnabled: false,
      hiddenPanels: [],
      instanceInitMethod: "best",
      showLabelingHints: true,
      frameIsNegative: false,
      hasFrameRange: false,
      totalLabeled: 1,
      totalInstances: 1,
      overlayModelCount: 0,
      overlayModelOutputs: false,
      propagateTrackLabels: true,
      seekbarHeaderGraph: "none",
    });
    const cmds = searchableCommands(menu);
    const item = cmds.find((c) => c.id === "file.export.slpCopy");
    expect(item?.label).toBe("Export › SLP Copy");
    await item?.run();
    expect(useSlpFormatStore.getState().saveSlpCopyDialogOpen).toBe(true);
  });
});

describe("SaveSlpCopyDialog round-trip and safety", () => {
  beforeEach(() => {
    cleanup();
    savedFiles.clear();
    pickedSavePath = "/out/session.v2.slp";
    useAppStore.setState(useAppStore.getInitialState());
    useSlpFormatStore.setState({
      prompt: null,
      saveSlpCopyDialogOpen: false,
      saveSlpCopyInitialVersion: "auto",
    });
  });

  it("shows live DropList on SLP 2.x, refuses on unlabeledAs='error', writes true 2.x on 'absent', and leaves project state untouched", async () => {
    const labels = makeFormat3Project();
    useSlpFormatStore.getState().openSaveSlpCopyDialog("auto");
    render(<SaveSlpCopyDialog />);

    expect(screen.getByTestId("save-slp-copy-dialog")).toBeInTheDocument();
    // No fake compression selector.
    expect(screen.queryByText(/compression/i)).toBeNull();

    // Switch to SLP 2.x.
    fireEvent.click(screen.getByRole("radio", { name: /SLP 2\.x/i }));
    expect(screen.getByTestId("save-slp-copy-suggested").textContent).toBe("session.v2.slp");
    const drops = screen.getByTestId("slp-format-v2-drops");
    expect(drops.textContent).toContain("1 node marked as not labeled");
    expect(drops.textContent).toContain("annotator");
    expect(drops.textContent).toContain("note");

    // Pick "Refuse if unlabeled points exist" -> inline refusal error, nothing written.
    fireEvent.click(screen.getByRole("radio", { name: /Refuse if unlabeled points exist/i }));
    expect(screen.getByTestId("slp-format-v2-unlabeled-refusal")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByTestId("save-slp-copy-submit"));
    });
    expect(screen.getByTestId("save-slp-copy-error").textContent).toContain("1 unlabeled node");
    expect(savedFiles.size).toBe(0);
    expect(useSlpFormatStore.getState().saveSlpCopyDialogOpen).toBe(true);

    // Switch to "Save unlabeled as absent" -> writes genuine 2.x copy!
    fireEvent.click(screen.getByRole("radio", { name: /Save unlabeled as absent/i }));
    await act(async () => {
      fireEvent.click(screen.getByTestId("save-slp-copy-submit"));
    });
    await waitFor(() => expect(useSlpFormatStore.getState().saveSlpCopyDialogOpen).toBe(false));
    expect(savedFiles.has("/out/session.v2.slp")).toBe(true);

    // Reload exported copy: must be SLP 2.x (sourceFormat === null), unlabeled -> absent, metadata dropped.
    const v2Back = await loadSlp(savedFiles.get("/out/session.v2.slp")!, { openVideos: false });
    expect(v2Back.sourceFormat).toBeNull();
    expect(isUnlabeledPoint(v2Back.labeledFrames[0].instances[0].points[1])).toBe(false);
    expect(Number.isNaN(v2Back.labeledFrames[0].instances[0].points[1].xy[0])).toBe(true);
    expect(metadataOf(v2Back.labeledFrames[0].instances[0])).toBeNull();
    expect(metadataOf(v2Back.labeledFrames[0])).toBeNull();

    // Open project state AND remembered _slpLayout MUST be completely unchanged!
    expect(useAppStore.getState().projectPath).toBe("/data/session.slp");
    expect(useAppStore.getState().filename).toBe("session.slp");
    expect(useAppStore.getState().hasChanges).toBe(true);
    expect((labels as unknown as { _slpLayout?: unknown })._slpLayout).toBe("v3");
  });

  it("exports an explicit SLP 3.0 copy preserving unlabeled nodes and metadata", async () => {
    makeFormat3Project();
    pickedSavePath = "/out/session.copy.slp";
    useSlpFormatStore.getState().openSaveSlpCopyDialog("v3");
    render(<SaveSlpCopyDialog />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("save-slp-copy-submit"));
    });
    await waitFor(() => expect(useSlpFormatStore.getState().saveSlpCopyDialogOpen).toBe(false));

    const v3Back = await loadSlp(savedFiles.get("/out/session.copy.slp")!, { openVideos: false });
    expect(v3Back.sourceFormat?.formatId).toBe(3);
    expect(isUnlabeledPoint(v3Back.labeledFrames[0].instances[0].points[1])).toBe(true);
    expect(metadataOf(v3Back.labeledFrames[0].instances[0])).toEqual({ annotator: "bob" });
    expect(metadataOf(v3Back.labeledFrames[0])).toEqual({ note: "check" });
  });
});

describe("ExportPackageDialog collapsible SLP format controls", () => {
  beforeEach(() => {
    cleanup();
    executedCommands.length = 0;
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("forwards explicit slpVersion & unlabeledAs when expanded and changed, and parses params cleanly", async () => {
    makeFormat3Project();
    render(<ExportPackageDialog open={true} onOpenChange={() => {}} />);

    // Collapsed by default.
    const toggle = screen.getByTestId("slp-format-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("Auto (SLP 3.0)");

    // Expand and pick SLP 2.x + error.
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: /SLP 2\.x/i }));
    expect(screen.getByTestId("slp-format-v2-drops")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /Refuse if unlabeled points exist/i }));

    fireEvent.click(screen.getByText("Export"));
    await waitFor(() => expect(executedCommands).toHaveLength(1));
    expect(executedCommands[0]).toEqual({
      name: "ExportTrainingPackage",
      params: {
        image: { format: "png", quality: 95 },
        slpVersion: "v2",
        unlabeledAs: "error",
      },
    });

    // Helper parser validates allowed values and ignores unlabeledAs outside v2.
    expect(packageSlpFormatParam(undefined)).toEqual({
      slpVersion: undefined,
      unlabeledAs: undefined,
    });
    expect(packageSlpFormatParam({ slpVersion: "v3", unlabeledAs: "error" })).toEqual({
      slpVersion: "v3",
      unlabeledAs: undefined,
    });
    expect(packageSlpFormatParam({ slpVersion: "v2", unlabeledAs: "error" })).toEqual({
      slpVersion: "v2",
      unlabeledAs: "error",
    });
  });
});
