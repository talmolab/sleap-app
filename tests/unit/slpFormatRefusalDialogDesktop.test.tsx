/**
 * Desktop (`isTauri = true`) tests for `SlpFormatRefusalDialog` `[Upgrade]`
 * navigation and refusal handling from `MergeProjectDialog`.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from "../bun-test";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Labels, Skeleton, Video } from "@talmolab/sleap-io.js";

const FORMAT3_PATH = join(import.meta.dir, "../fixtures/format3_minimal.slp");
const format3Bytes = new Uint8Array(readFileSync(FORMAT3_PATH));

vi.mock("@/platform/index", () => ({
  isTauri: true,
  consumeLastBrowserFileHandle: () => null,
  getPlatform: async () => ({
    isTauri: true,
    showOpenDialog: async () => FORMAT3_PATH,
    readFile: async () => format3Bytes,
  }),
}));

vi.mock("@/lib/notify", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const { useAppStore } = await import("@/stores/appStore");
const { useSlpFormatDialogStore } = await import(
  "@/stores/slpFormatDialogStore"
);
const { SlpFormatRefusalDialog } = await import(
  "@/components/dialogs/SlpFormatRefusalDialog"
);
const { MergeProjectDialog } = await import(
  "@/components/dialogs/MergeProjectDialog"
);
const { toast } = await import("@/lib/notify");

const originalWindowOpen = window.open;
let windowOpenMock: ReturnType<typeof vi.fn>;

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

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  useSlpFormatDialogStore.setState({
    refusal: null,
    welcomeEnvironmentRequestSeq: 0,
  });
  (toast.error as unknown as { mockClear: () => void }).mockClear();
  windowOpenMock = vi.fn(() => null);
  window.open = windowOpenMock as unknown as typeof window.open;
});

afterEach(() => {
  cleanup();
  window.open = originalWindowOpen;
});

describe("SlpFormatRefusalDialog Desktop [Upgrade]", () => {
  it("with a loaded project: closes modal, unhides and opens Environment panel, and closes Merge dialog", () => {
    useAppStore.setState({
      projectLoaded: true,
      sidebarCollapsed: true,
      sidebarOpenPanels: ["instances"],
      hiddenPanels: ["environment"],
      mergeProjectDialogOpen: true,
    });
    useSlpFormatDialogStore.getState().open({
      fileName: "labels.slp",
      formatId: 3,
      unsupportedFeatures: [],
      detail: "SLP format 3.0",
    });

    render(<SlpFormatRefusalDialog />);
    fireEvent.click(screen.getByTestId("slp-format-refusal-upgrade"));

    expect(useSlpFormatDialogStore.getState().refusal).toBeNull();
    const app = useAppStore.getState();
    expect(app.sidebarCollapsed).toBe(false);
    expect(app.hiddenPanels).not.toContain("environment");
    expect(app.sidebarOpenPanels).toContain("environment");
    expect(app.mergeProjectDialogOpen).toBe(false);
    expect(windowOpenMock).not.toHaveBeenCalled();
  });

  it("on the Welcome screen (no project loaded): requests the Welcome Environment panel", () => {
    useAppStore.setState({ projectLoaded: false });
    useSlpFormatDialogStore.getState().open({
      fileName: "labels.slp",
      formatId: 3,
      unsupportedFeatures: [],
      detail: "SLP format 3.0",
    });

    render(<SlpFormatRefusalDialog />);
    fireEvent.click(screen.getByTestId("slp-format-refusal-upgrade"));

    const state = useSlpFormatDialogStore.getState();
    expect(state.refusal).toBeNull();
    expect(state.welcomeEnvironmentRequestSeq).toBe(1);
    expect(windowOpenMock).not.toHaveBeenCalled();
  });

  it("MergeProjectDialog opens the refusal modal on a format 3.0 donor file without raw library wording", async () => {
    const sk = new Skeleton({ nodes: ["head", "tail"], name: "s" });
    const v = new Video({
      filename: "session.mp4",
      backendMetadata: { shape: [100, 64, 64, 1] },
      openBackend: false,
    });
    const current = new Labels({ videos: [v], skeletons: [sk], labeledFrames: [] });
    useAppStore.setState({
      labels: current as never,
      projectLoaded: true,
      mergeProjectDialogOpen: true,
      mergeProjectSeedPath: FORMAT3_PATH,
    });

    render(<MergeProjectDialog />);

    await waitFor(() => {
      expect(useSlpFormatDialogStore.getState().refusal).not.toBeNull();
    });

    const refusal = useSlpFormatDialogStore.getState().refusal;
    expect(refusal?.fileName).toBe("format3_minimal.slp");
    expect(refusal?.formatId).toBe(3);
    expect(toast.error).not.toHaveBeenCalled();

    const inlineErr = screen.getByTestId("merge-load-error");
    expect(inlineErr.textContent).toContain("format3_minimal.slp");
    expect(inlineErr.textContent).not.toContain("sleap-io.js");
  });
});
