/**
 * Tests for stage 1.10's remote-result fetch+merge wiring
 * (`fetchAndMergeRemoteResult`) — the counterpart to
 * `inferenceMergeWiring.test.ts`'s local-file path, but sourcing bytes from
 * connectStore's `fetchResultBlob` (a protocol v1 worker's blob HTTP
 * endpoint) instead of `platform.readFile`. Collaborators are mocked
 * (commandContext, loadSlp, connectStore) so this exercises only the
 * wiring, matching that file's own stated scope.
 */

import { describe, it, expect, beforeEach, vi } from "../bun-test";
import type { JobResult } from "@/lib/sleapConnect";

const executeMock = vi.fn(async (_cmd: unknown, _params?: unknown) => {});
vi.mock("@/commands", () => ({ commandContext: { execute: executeMock } }));

const loadSlpMock = vi.fn(async () => ({ videos: [], labeledFrames: [], tracks: [] }));
const readSlpStreamingMock = vi.fn(async () => ({ videos: [], labeledFrames: [], tracks: [] }));
vi.mock("@talmolab/sleap-io.js", () => ({
  loadSlp: loadSlpMock,
  readSlpStreaming: readSlpStreamingMock,
}));

const fetchResultBlobMock = vi.fn(async () => new Uint8Array([1, 2, 3]));
// `activeTransport` is mutable per-test (default undefined = the existing
// WebSocket-path tests below) rather than a fixed mock, since item 2.4 adds
// a second branch in `fetchAndMergeRemoteResult` keyed on this field.
let mockActiveTransport: string | undefined;
vi.mock("@/stores/connectStore", () => ({
  useConnectStore: {
    getState: () => ({ fetchResultBlob: fetchResultBlobMock, activeTransport: mockActiveTransport }),
  },
}));

const disposeMock = vi.fn(async () => {});
const createTauriIrohBlobRangeSourceMock = vi.fn(() => ({
  source: { size: 0, readRange: async () => new Uint8Array() },
  dispose: disposeMock,
}));
vi.mock("@/lib/protocolV1/tauriIrohBlob", () => ({
  createTauriIrohBlobRangeSource: createTauriIrohBlobRangeSourceMock,
}));

import { MergePredictions, MergeTracks } from "@/commands/editCommands";
import { fetchAndMergeRemoteResult, useInferenceStore } from "@/stores/inferenceStore";

// The bun-test vi.fn shim widens mock.calls elements to `never`, so read
// them through `unknown` (mirrors inferenceMergeWiring.test.ts).
const cmdArg = () => executeMock.mock.calls[0][0] as unknown;
const paramsArg = () => executeMock.mock.calls[0][1] as unknown as Record<string, unknown>;

describe("fetchAndMergeRemoteResult", () => {
  beforeEach(() => {
    executeMock.mockClear();
    loadSlpMock.mockClear();
    readSlpStreamingMock.mockClear();
    fetchResultBlobMock.mockClear();
    createTauriIrohBlobRangeSourceMock.mockClear();
    disposeMock.mockClear();
    mockActiveTransport = undefined;
  });

  it("is a no-op when the result has no predictions blob ref", async () => {
    const result: JobResult = { jobId: "job_1", success: true };

    await fetchAndMergeRemoteResult(result, "replace", false);

    expect(fetchResultBlobMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("fetches the ref, loads it, and merges via MergePredictions", async () => {
    const result: JobResult = {
      jobId: "job_1",
      success: true,
      resultBlobs: { predictions: { sha256: "abc123", size: 4096 } },
    };

    await fetchAndMergeRemoteResult(result, "clear_all", false);

    expect(fetchResultBlobMock).toHaveBeenCalledWith({ sha256: "abc123", size: 4096 });
    expect(loadSlpMock).toHaveBeenCalledTimes(1);
    expect(cmdArg()).toBe(MergePredictions);
    expect(paramsArg().mode).toBe("clear_all");
  });

  it("routes through MergeTracks instead when trackOnly is set", async () => {
    const result: JobResult = {
      jobId: "job_1",
      success: true,
      resultBlobs: { predictions: { sha256: "abc123", size: 4096 } },
    };

    await fetchAndMergeRemoteResult(result, "replace", true);

    expect(cmdArg()).toBe(MergeTracks);
  });

  it("propagates a fetchResultBlob failure to the caller", async () => {
    fetchResultBlobMock.mockImplementationOnce(async () => {
      throw new Error("blob.hash_mismatch");
    });
    const result: JobResult = {
      jobId: "job_1",
      success: true,
      resultBlobs: { predictions: { sha256: "abc123", size: 4096 } },
    };

    await expect(fetchAndMergeRemoteResult(result, "replace", false)).rejects.toThrow(
      "blob.hash_mismatch",
    );
    expect(executeMock).not.toHaveBeenCalled();
  });
});

describe("fetchAndMergeRemoteResult over an iroh connection (item 2.4)", () => {
  beforeEach(() => {
    executeMock.mockClear();
    loadSlpMock.mockClear();
    readSlpStreamingMock.mockClear();
    fetchResultBlobMock.mockClear();
    createTauriIrohBlobRangeSourceMock.mockClear();
    disposeMock.mockClear();
    mockActiveTransport = "iroh";
  });

  const result: JobResult = {
    jobId: "job_1",
    success: true,
    resultBlobs: { predictions: { sha256: "abc123", size: 4096 } },
  };

  it("uses readSlpStreaming via a RangeSource instead of fetchResultBlob", async () => {
    await fetchAndMergeRemoteResult(result, "clear_all", false);

    expect(fetchResultBlobMock).not.toHaveBeenCalled();
    expect(loadSlpMock).not.toHaveBeenCalled();
    expect(createTauriIrohBlobRangeSourceMock).toHaveBeenCalledWith("abc123", 4096);
    expect(readSlpStreamingMock).toHaveBeenCalledTimes(1);
    expect(cmdArg()).toBe(MergePredictions);
    expect(paramsArg().mode).toBe("clear_all");
  });

  it("routes through MergeTracks instead when trackOnly is set", async () => {
    await fetchAndMergeRemoteResult(result, "replace", true);

    expect(cmdArg()).toBe(MergeTracks);
  });

  it("disposes the range source even when readSlpStreaming throws", async () => {
    readSlpStreamingMock.mockImplementationOnce(async () => {
      throw new Error("simulated parse failure");
    });

    await expect(fetchAndMergeRemoteResult(result, "replace", false)).rejects.toThrow(
      "simulated parse failure",
    );

    expect(disposeMock).toHaveBeenCalledTimes(1);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("disposes the range source after a successful merge", async () => {
    await fetchAndMergeRemoteResult(result, "replace", false);

    expect(disposeMock).toHaveBeenCalledTimes(1);
  });
});

describe("mergePendingRemoteResults", () => {
  beforeEach(() => {
    executeMock.mockClear();
    fetchResultBlobMock.mockClear();
    mockActiveTransport = undefined;
    useInferenceStore.setState(useInferenceStore.getInitialState());
  });

  it("is a no-op when nothing is pending", async () => {
    await useInferenceStore.getState().mergePendingRemoteResults();

    expect(executeMock).not.toHaveBeenCalled();
  });

  it("merges every pending result in order, then clears pendingRemoteMerge", async () => {
    const results: JobResult[] = [
      { jobId: "job_1", success: true, resultBlobs: { predictions: { sha256: "a", size: 1 } } },
      { jobId: "job_2", success: true, resultBlobs: { predictions: { sha256: "b", size: 2 } } },
    ];
    useInferenceStore.setState({
      pendingRemoteMerge: { results, mode: "replace", trackOnly: false },
    });

    await useInferenceStore.getState().mergePendingRemoteResults();

    expect(fetchResultBlobMock).toHaveBeenCalledTimes(2);
    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(useInferenceStore.getState().pendingRemoteMerge).toBeNull();
  });

  it("surfaces a failure as a store error and clears pendingRemoteMerge", async () => {
    fetchResultBlobMock.mockImplementationOnce(async () => {
      throw new Error("worker unreachable");
    });
    useInferenceStore.setState({
      pendingRemoteMerge: {
        results: [{ jobId: "job_1", success: true, resultBlobs: { predictions: { sha256: "a", size: 1 } } }],
        mode: "replace",
        trackOnly: false,
      },
    });

    await useInferenceStore.getState().mergePendingRemoteResults();

    const state = useInferenceStore.getState();
    expect(state.status).toBe("error");
    expect(state.error).toContain("worker unreachable");
    expect(state.pendingRemoteMerge).toBeNull();
  });
});
