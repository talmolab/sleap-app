/**
 * Regression guard for the "Existing predictions" bug: the inference merge-back
 * MUST forward the chosen mode (clear_all/replace/keep) to MergePredictions.
 *
 * The original bug was a silent WIRING gap — the merge call omitted the mode
 * param, so the setting did nothing. Types can't catch that (mode defaults), so
 * this test asserts the value actually reaches the command. Collaborators are
 * mocked (commandContext, loadSlp, platform) so this exercises only the wiring.
 */

import { describe, it, expect, beforeEach, vi } from "../bun-test";

const executeMock = vi.fn(async (_cmd: unknown, _params?: unknown) => {});
vi.mock("@/commands", () => ({ commandContext: { execute: executeMock } }));
vi.mock("@talmolab/sleap-io.js", () => ({
  loadSlp: async () => ({ videos: [], labeledFrames: [], tracks: [] }),
}));
vi.mock("@/platform", () => ({
  getPlatform: async () => ({ readFile: async () => new Uint8Array([1]) }),
}));

import { useInferenceStore } from "@/stores/inferenceStore";
import { MergePredictions } from "@/commands/editCommands";

describe("inference merge wiring — existingPredictions reaches MergePredictions", () => {
  beforeEach(() => {
    useInferenceStore.setState(useInferenceStore.getInitialState());
    useInferenceStore.setState({ outputPath: "/tmp/out.slp" });
    executeMock.mockClear();
  });

  // The bun-test vi.fn shim widens mock.calls elements to `never`, so read
  // them through `unknown` (mirrors tests/unit/saveInPlaceRouting.test.ts).
  const cmdArg = () => executeMock.mock.calls[0][0] as unknown;
  const paramsArg = () =>
    executeMock.mock.calls[0][1] as unknown as { mode: string };

  it("forwards the selected mode to MergePredictions", async () => {
    await useInferenceStore.getState().loadAndMergeResults("clear_all");
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(cmdArg()).toBe(MergePredictions);
    expect(paramsArg().mode).toBe("clear_all");
  });

  it("defaults to replace (the safe, no-duplicate mode) when none is given", async () => {
    await useInferenceStore.getState().loadAndMergeResults();
    expect(paramsArg().mode).toBe("replace");
  });
});
