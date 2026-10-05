/**
 * PR5b §5b.4 — MergePredictionsDialog: loads a completed track job's
 * predictions (`loadRemotePredictions`) and runs the compatibility check
 * (`checkMergeCompat`, PR5a.7), then either merges right away (a "mine" job
 * whose predictions fully match) or shows Merge matching / Open predictions
 * / Download .slp. Every dependency this pulls in is mocked per this repo's
 * `vi.mock` convention — not hoisted, so the module under test is imported
 * dynamically AFTER the mocks are registered. `Labels`/`Video` are never
 * constructed for real here (`checkMergeCompat`/`filterPredictionsToMatchedVideos`
 * are mocked too) — predictions/project "labels" are plain duck-typed
 * objects, same convention as remoteLabelsPayload.test.ts's `FakeVideo`.
 *
 * Mock return values are driven through captured `let`s (reset per test)
 * rather than `.mockResolvedValue` — the bun-test `vi.fn` shim widens the
 * impl to `(...args: never[]) => unknown`, which makes `.mockResolvedValue`
 * unusable without casts (see saveInPlaceRouting.test.ts's own doc on this).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "../bun-test";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { useAppStore } from "@/stores/appStore";
import { useConnectStore } from "@/stores/connectStore";
import type { JobStatus } from "@/lib/protocolV1/client";
import type { MergeCompat } from "@/lib/mergeCompat";

const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: toastSuccessMock, error: toastErrorMock, info: vi.fn(), warning: vi.fn() },
}));

const SAVED_BYTES = new Uint8Array([1, 2, 3]);
const saveSlpToBytesMock = vi.fn(async () => SAVED_BYTES);
vi.mock("@talmolab/sleap-io.js", () => ({
  saveSlpToBytes: saveSlpToBytesMock,
}));

interface FakeVideo {
  filename: string | string[];
}
interface FakeLabels {
  videos: FakeVideo[];
  skeletons: unknown[];
}

// --- mutable mock outputs (reset in beforeEach) -----------------------------
let predictionsResult: FakeLabels | null = null;
let compatResult: MergeCompat = { sameFile: false, skeletonOk: false, skeletonDetail: "", videos: [], matchedCount: 0, total: 0 };
let confirmResult = true;

const loadRemotePredictionsMock = vi.fn(async () => predictionsResult);
vi.mock("@/stores/inferenceStore", () => ({
  loadRemotePredictions: loadRemotePredictionsMock,
}));

const FILTERED = { filtered: true };
const checkMergeCompatMock = vi.fn(async () => compatResult);
const filterPredictionsToMatchedVideosMock = vi.fn(() => FILTERED);
const translatePathToLocalMock = vi.fn((workerPath: string) => `/local${workerPath}`);
vi.mock("@/lib/mergeCompat", () => ({
  checkMergeCompat: checkMergeCompatMock,
  filterPredictionsToMatchedVideos: filterPredictionsToMatchedVideosMock,
  translatePathToLocal: translatePathToLocalMock,
}));

const executeMock = vi.fn(async () => {});
vi.mock("@/commands", () => ({
  commandContext: { execute: executeMock },
}));
vi.mock("@/commands/editCommands", () => ({
  MergePredictions: { name: "MergePredictions" },
}));

const saveBytesFileMock = vi.fn(async () => "/saved/path.slp");
vi.mock("@/commands/fileCommands", () => ({
  saveBytesFile: saveBytesFileMock,
}));

const confirmDiscardUnsavedWorkMock = vi.fn(async () => confirmResult);
vi.mock("@/lib/unsavedGuard", () => ({
  confirmDiscardUnsavedWork: confirmDiscardUnsavedWorkMock,
}));

const resolveExternalVideosMock = vi.fn(async () => {});
vi.mock("@/lib/resolveVideos", () => ({
  resolveExternalVideos: resolveExternalVideosMock,
}));

const { MergePredictionsDialog } = await import("@/components/connect/MergePredictionsDialog");

const WORKER_ID = "node-a";
const JOB_ID = "job_1";
const PROJECT_PATH = "/Users/x/labels.v003.slp";

function fakeLabels(videoNames: string[]): FakeLabels {
  return { videos: videoNames.map((name) => ({ filename: name })), skeletons: [{}] };
}

function fullMatchCompat(total: number): MergeCompat {
  return {
    sameFile: false,
    skeletonOk: true,
    skeletonDetail: "Skeleton matches",
    videos: Array.from({ length: total }, (_, i) => ({ name: `video_${i}.mp4`, matched: true })),
    matchedCount: total,
    total,
  };
}

function partialMatchCompat(matched: number, total: number): MergeCompat {
  return {
    sameFile: false,
    skeletonOk: true,
    skeletonDetail: "Skeleton matches",
    videos: Array.from({ length: total }, (_, i) => ({ name: `video_${i}.mp4`, matched: i < matched })),
    matchedCount: matched,
    total,
  };
}

function skeletonMismatchCompat(): MergeCompat {
  return {
    sameFile: false,
    skeletonOk: false,
    skeletonDetail: "Skeleton doesn't match the open project (8 vs 13 node(s))",
    videos: [{ name: "video_0.mp4", matched: true }],
    matchedCount: 0,
    total: 1,
  };
}

function noProjectCompat(): MergeCompat {
  return {
    sameFile: false,
    skeletonOk: false,
    skeletonDetail: "No project open",
    videos: [{ name: "video_0.mp4", matched: false }],
    matchedCount: 0,
    total: 1,
  };
}

function jobStatus(overrides: Partial<JobStatus> = {}): JobStatus {
  return {
    jobId: JOB_ID,
    state: "completed",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:05:00.000Z",
    result: { blobs: { predictions: { sha256: "abc123", size: 42 } } },
    error: null,
    queuePosition: null,
    kind: "track",
    modelTypes: [],
    labelsPath: "/root/vast/exp1/flies.slp",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  toastSuccessMock.mockClear();
  toastErrorMock.mockClear();
  saveSlpToBytesMock.mockClear();
  loadRemotePredictionsMock.mockClear();
  checkMergeCompatMock.mockClear();
  filterPredictionsToMatchedVideosMock.mockClear();
  translatePathToLocalMock.mockClear();
  executeMock.mockClear();
  saveBytesFileMock.mockClear();
  confirmDiscardUnsavedWorkMock.mockClear();
  resolveExternalVideosMock.mockClear();
});

beforeEach(() => {
  predictionsResult = null;
  compatResult = noProjectCompat();
  confirmResult = true;
  useAppStore.setState({ projectPath: PROJECT_PATH, labels: fakeLabels(["video_0.mp4"]) as never });
  useConnectStore.setState({
    jobDetail: async () => jobStatus(),
  });
});

describe("MergePredictionsDialog", () => {
  it("mine + full match + skeleton ok merges directly, without ever showing the dialog's buttons", async () => {
    predictionsResult = fakeLabels(["video_0.mp4"]);
    compatResult = fullMatchCompat(1);
    const onClose = vi.fn();

    render(<MergePredictionsDialog workerId={WORKER_ID} jobId={JOB_ID} mine onClose={onClose} />);

    await waitFor(() => expect(executeMock).toHaveBeenCalledTimes(1));
    expect(executeMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "MergePredictions" }),
      expect.objectContaining({ mode: "replace" }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /Merge matching/ })).not.toBeInTheDocument();
    expect(toastSuccessMock).toHaveBeenCalledWith(
      "Loaded. Predictions merged into the project.",
      expect.anything(),
    );
  });

  it("not mine (even with a full match) shows the dialog instead of merging directly", async () => {
    predictionsResult = fakeLabels(["video_0.mp4"]);
    compatResult = fullMatchCompat(1);

    render(<MergePredictionsDialog workerId={WORKER_ID} jobId={JOB_ID} mine={false} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole("button", { name: /Merge matching/ })).toBeInTheDocument());
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("partial match: Merge matching merges only the filtered predictions", async () => {
    const predictions = fakeLabels(["video_0.mp4", "video_1.mp4"]);
    predictionsResult = predictions;
    compatResult = partialMatchCompat(1, 2);
    const onClose = vi.fn();

    render(<MergePredictionsDialog workerId={WORKER_ID} jobId={JOB_ID} mine onClose={onClose} />);

    const mergeButton = await screen.findByRole("button", { name: /Merge matching \(1\/2 videos\)/ });
    expect(mergeButton).not.toBeDisabled();
    fireEvent.click(mergeButton);

    await waitFor(() => expect(executeMock).toHaveBeenCalledTimes(1));
    expect(filterPredictionsToMatchedVideosMock).toHaveBeenCalledWith(predictions, expect.anything());
    expect(executeMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "MergePredictions" }),
      expect.objectContaining({ predictions: FILTERED, mode: "replace" }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("skeleton mismatch disables Merge matching with the reason", async () => {
    predictionsResult = fakeLabels(["video_0.mp4"]);
    compatResult = skeletonMismatchCompat();

    render(<MergePredictionsDialog workerId={WORKER_ID} jobId={JOB_ID} mine onClose={vi.fn()} />);

    const mergeButton = await screen.findByRole("button", { name: /Merge matching/ });
    expect(mergeButton).toBeDisabled();
    expect(mergeButton).toHaveAttribute(
      "title",
      "Skeleton doesn't match the open project (8 vs 13 node(s))",
    );
  });

  it("no open project disables Merge matching, shows Open/Download, and never toasts 'Loaded'", async () => {
    useAppStore.setState({ projectPath: null, labels: null });
    predictionsResult = fakeLabels(["video_0.mp4"]);
    compatResult = noProjectCompat();

    render(<MergePredictionsDialog workerId={WORKER_ID} jobId={JOB_ID} mine={false} onClose={vi.fn()} />);

    const mergeButton = await screen.findByRole("button", { name: /Merge matching/ });
    expect(mergeButton).toBeDisabled();
    expect(mergeButton).toHaveAttribute("title", "No project open");
    expect(screen.getByRole("button", { name: "Open predictions" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download .slp" })).toBeInTheDocument();
    expect(executeMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).not.toHaveBeenCalled(); // no "Loaded" toast — nothing was merged
  });

  it("Open predictions re-points filenames through translatePathToLocal and calls setLabels", async () => {
    const predictions = fakeLabels(["/mnt/data/exp1/video_0.mp4"]);
    predictionsResult = predictions;
    compatResult = partialMatchCompat(0, 1);

    render(<MergePredictionsDialog workerId={WORKER_ID} jobId={JOB_ID} mine={false} onClose={vi.fn()} />);

    const openButton = await screen.findByRole("button", { name: "Open predictions" });
    fireEvent.click(openButton);

    await waitFor(() => expect(confirmDiscardUnsavedWorkMock).toHaveBeenCalledTimes(1));
    expect(translatePathToLocalMock).toHaveBeenCalledWith("/mnt/data/exp1/video_0.mp4", expect.anything());
    // translatePathToLocal's (mocked) result is written back onto the video in place.
    expect(predictions.videos[0]!.filename).toBe("/local/mnt/data/exp1/video_0.mp4");
    await waitFor(() => expect(resolveExternalVideosMock).toHaveBeenCalledWith(predictions));
    await waitFor(() => expect(useAppStore.getState().labels).toBe(predictions as never));
    expect(useAppStore.getState().projectPath).toBeNull(); // opened as a new, unsaved project
  });

  it("Open predictions does nothing if the user declines to discard unsaved work", async () => {
    confirmResult = false;
    predictionsResult = fakeLabels(["video_0.mp4"]);
    compatResult = partialMatchCompat(0, 1);
    const previousLabels = useAppStore.getState().labels;

    render(<MergePredictionsDialog workerId={WORKER_ID} jobId={JOB_ID} mine={false} onClose={vi.fn()} />);

    const openButton = await screen.findByRole("button", { name: "Open predictions" });
    fireEvent.click(openButton);

    await waitFor(() => expect(confirmDiscardUnsavedWorkMock).toHaveBeenCalledTimes(1));
    expect(resolveExternalVideosMock).not.toHaveBeenCalled();
    expect(useAppStore.getState().labels).toBe(previousLabels);
  });

  it("Download calls saveSlpToBytes then saveBytesFile with a .slp suggested name", async () => {
    const predictions = fakeLabels(["video_0.mp4"]);
    predictionsResult = predictions;
    compatResult = partialMatchCompat(0, 1);

    render(<MergePredictionsDialog workerId={WORKER_ID} jobId={JOB_ID} mine={false} onClose={vi.fn()} />);

    const downloadButton = await screen.findByRole("button", { name: "Download .slp" });
    fireEvent.click(downloadButton);

    await waitFor(() => expect(saveBytesFileMock).toHaveBeenCalledTimes(1));
    expect(saveSlpToBytesMock).toHaveBeenCalledWith(predictions);
    expect(saveBytesFileMock).toHaveBeenCalledWith(SAVED_BYTES, `${JOB_ID}.predictions.slp`, {
      name: "SLEAP Labels",
      ext: "slp",
    });
  });
});
