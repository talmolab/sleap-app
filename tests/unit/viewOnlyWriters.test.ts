/**
 * Every app writer, run through the app's own code, for a project whose file
 * is in SLP format 3.0: a project opened View only writes nothing unless the
 * user allows editing (Save, Save As, the NWB, clip and training package
 * exports), a writer's own View only refusal in an editable project is still
 * reported, and a real save over the project's file clears `sourceFormat`.
 *
 * The labels carry a stand-in `sourceFormat`, shaped like sleap-io.js 0.6's,
 * so this runs against any sleap-io.js. Platform I/O is mocked.
 */
import { describe, it, expect, beforeEach, vi } from "../bun-test";
import { Instance, LabeledFrame, Labels, Skeleton, Video } from "@talmolab/sleap-io.js";

const toastError = vi.fn();
const writes: string[] = [];
const writeFileMock = vi.fn(async () => {});
const showSaveDialogMock = vi.fn(async () => "/data/out.file");
const renameFileMock = vi.fn(async () => {});
let writeFileError: Error | null = null;

vi.mock("@/lib/notify", () => ({
  toast: { success: vi.fn(), error: toastError, info: vi.fn(), warning: vi.fn() },
}));
vi.mock("@/platform/index", () => ({
  getPlatform: async () => ({
    isTauri: true,
    writeFile: async (path: string, bytes: Uint8Array) => {
      if (writeFileError) throw writeFileError;
      writes.push(path);
      void bytes;
      return writeFileMock();
    },
    showSaveDialog: showSaveDialogMock,
  }),
}));
vi.mock("@/lib/nativeWrite", () => ({
  renameFile: renameFileMock,
  removeFile: vi.fn(async () => {}),
  withNativeWriteHandle: <T,>(work: () => Promise<T>) => work(),
}));
vi.mock("@/lib/nativeRange", () => ({
  fileSize: vi.fn(async () => 1000),
  readRange: vi.fn(),
}));

import { saveProjectAsSlp } from "@/lib/saveProject";
import { ExportNwbCommand } from "@/commands/exportNwbCommands";
import { ExtractClipAndLabelsCommand } from "@/commands/extractClipCommands";
import { exportTrainingJobPackage } from "@/commands/trainingConfigExport";
import { useAppStore } from "@/stores/appStore";
import { useSlpFormatStore, type SlpFormatAnswer, type SlpFormatPrompt } from "@/stores/slpFormatStore";
import { sourceFormatOf, type Format3Summary, type SlpSourceFormat } from "@/lib/slpFormatCompat";
import type { CommandContext } from "@/commands/CommandContext";

const SUMMARY: Format3Summary = {
  formatId: 3,
  unlabeledPoints: 0,
  unlabeledUserPoints: 0,
  unlabeledPredictedPoints: 0,
  metadataKeys: { instances: ["annotator"], frames: [], bboxes: [] },
  unknownColumns: [],
  lossless: false,
};

/** A small project from a format 3.0 file, opened with `access`. */
function project(access: "view" | "edit"): Labels {
  const skeleton = new Skeleton({ nodes: ["a", "b"] });
  const video = new Video({ filename: "/data/movie.mp4" });
  const inst = new Instance({
    skeleton,
    points: [
      { xy: [1, 2], visible: true, complete: true },
      { xy: [3, 4], visible: true, complete: true },
    ],
  });
  const labels = new Labels({
    labeledFrames: [new LabeledFrame({ video, frameIdx: 0, instances: [inst] })],
    videos: [video],
    skeletons: [skeleton],
  });
  const sf: SlpSourceFormat = { formatId: 3, access, summary: SUMMARY, labelsPath: "/data/x.slp" };
  (labels as unknown as { sourceFormat: SlpSourceFormat }).sourceFormat = sf;
  return labels;
}

const unsubscribers: Array<() => void> = [];

/** Answer every SLP format prompt with `answer` (until the next test); returns the prompts seen. */
function answerPrompts(answer: SlpFormatAnswer): SlpFormatPrompt[] {
  const seen: SlpFormatPrompt[] = [];
  unsubscribers.push(useSlpFormatStore.subscribe((s) => {
    if (!s.prompt) return;
    seen.push(s.prompt);
    queueMicrotask(() => useSlpFormatStore.getState().respond(answer));
  }));
  return seen;
}

function open(labels: Labels): void {
  useAppStore.getState().setLabels(labels, "x.slp", "/data/x.slp");
}

beforeEach(() => {
  while (unsubscribers.length) unsubscribers.pop()!();
  useAppStore.setState(useAppStore.getInitialState());
  useSlpFormatStore.setState({ prompt: null });
  writeFileError = null;
  writes.length = 0;
  for (const m of [toastError, writeFileMock, showSaveDialogMock, renameFileMock]) m.mockClear();
});

describe("a project opened View only writes nothing unless editing is allowed", () => {
  it("Save", async () => {
    const labels = project("view");
    open(labels);
    const prompts = answerPrompts(null);
    await saveProjectAsSlp(labels, "x.slp");
    expect(prompts).toEqual([expect.objectContaining({ kind: "allow-edit", action: "save" })]);
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(renameFileMock).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(sourceFormatOf(labels)?.access).toBe("view");
  });

  it("Save As", async () => {
    const labels = project("view");
    open(labels);
    answerPrompts(null);
    await saveProjectAsSlp(labels, "x.slp", true);
    expect(showSaveDialogMock).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("NWB export", async () => {
    const labels = project("view");
    open(labels);
    const prompts = answerPrompts(null);
    await ExportNwbCommand.execute({ state: useAppStore.getState() } as unknown as CommandContext);
    expect(prompts).toEqual([expect.objectContaining({ kind: "allow-edit", action: "export" })]);
    expect(showSaveDialogMock).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("clip export", async () => {
    const labels = project("view");
    open(labels);
    const video = labels.videos[0];
    (video as unknown as { _shape: number[] })._shape = [100, 32, 32, 1];
    Object.defineProperty(video, "shape", { get: () => [100, 32, 32, 1] });
    const prompts = answerPrompts(null);
    const state = { ...useAppStore.getState(), video, frameRange: [10, 20] };
    await ExtractClipAndLabelsCommand.execute({ state } as unknown as CommandContext);
    expect(prompts).toEqual([expect.objectContaining({ kind: "allow-edit", action: "export" })]);
    expect(showSaveDialogMock).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("training job package export", async () => {
    const labels = project("view");
    open(labels);
    const prompts = answerPrompts(null);
    expect(await exportTrainingJobPackage({} as never)).toBeNull();
    expect(prompts).toEqual([expect.objectContaining({ kind: "allow-edit", action: "export" })]);
    expect(showSaveDialogMock).not.toHaveBeenCalled();
  });

  it("Save after allowing editing writes the 2.x layout and clears sourceFormat", async () => {
    const labels = project("view");
    open(labels);
    answerPrompts("edit");
    await saveProjectAsSlp(labels, "x.slp");
    expect(writeFileMock).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
    expect(sourceFormatOf(labels)).toBeNull();
  });
});

describe("saving a project opened for editing", () => {
  it("a save over the project's file clears sourceFormat", async () => {
    const labels = project("edit");
    open(labels);
    await saveProjectAsSlp(labels, "x.slp");
    expect(writeFileMock).toHaveBeenCalledTimes(1);
    expect(sourceFormatOf(labels)).toBeNull();
  });

  it("a failed save keeps it", async () => {
    const labels = project("edit");
    open(labels);
    writeFileError = new Error("disk full");
    await saveProjectAsSlp(labels, "x.slp");
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(sourceFormatOf(labels)?.access).toBe("edit");
  });

  it("a writer's View only refusal is reported, not swallowed", async () => {
    const labels = project("edit");
    open(labels);
    const refusal = new Error("These labels were loaded ... for viewing only");
    refusal.name = "SlpViewOnlyError";
    writeFileError = refusal;
    const prompts = answerPrompts("edit");
    await saveProjectAsSlp(labels, "x.slp");
    expect(prompts).toEqual([]);
    expect(toastError).toHaveBeenCalledTimes(1);
  });
});
