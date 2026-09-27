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
vi.mock("@talmolab/sleap-io.js", () => ({ loadSlp: loadSlpMock }));

const fetchResultBlobMock = vi.fn(async () => new Uint8Array([1, 2, 3]));
vi.mock("@/stores/connectStore", () => ({
  useConnectStore: { getState: () => ({ fetchResultBlob: fetchResultBlobMock }) },
}));

import { MergePredictions, MergeTracks } from "@/commands/editCommands";
import { fetchAndMergeRemoteResult } from "@/stores/inferenceStore";

// The bun-test vi.fn shim widens mock.calls elements to `never`, so read
// them through `unknown` (mirrors inferenceMergeWiring.test.ts).
const cmdArg = () => executeMock.mock.calls[0][0] as unknown;
const paramsArg = () => executeMock.mock.calls[0][1] as unknown as Record<string, unknown>;

describe("fetchAndMergeRemoteResult", () => {
  beforeEach(() => {
    executeMock.mockClear();
    loadSlpMock.mockClear();
    fetchResultBlobMock.mockClear();
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
