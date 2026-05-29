import { describe, it, expect, beforeEach } from "../bun-test";
import { useInferenceStore } from "@/stores/inferenceStore";

function resetStore() {
  useInferenceStore.setState(useInferenceStore.getInitialState());
}

describe("inferenceStore", () => {
  beforeEach(() => {
    resetStore();
  });

  it("starts in idle state", () => {
    const state = useInferenceStore.getState();
    expect(state.status).toBe("idle");
    expect(state.error).toBeNull();
    expect(state.progress).toBeNull();
    expect(state.log).toEqual([]);
    expect(state.minimized).toBe(false);
    expect(state.outputPath).toBeNull();
  });

  it("updates progress from stdout JSON", () => {
    const { handleProcessEvent } = useInferenceStore.getState();
    handleProcessEvent({
      event: "stdout",
      data: { line: JSON.stringify({ n_processed: 50, n_total: 1000, rate: 12.5, eta: 76.0 }) },
    });
    const state = useInferenceStore.getState();
    expect(state.progress).toEqual({
      nProcessed: 50,
      nTotal: 1000,
      rate: 12.5,
      eta: 76.0,
    });
    // Progress JSON should not be appended to log
    expect(state.log).toEqual([]);
  });

  it("appends non-JSON stdout to log", () => {
    const { handleProcessEvent } = useInferenceStore.getState();
    handleProcessEvent({
      event: "stdout",
      data: { line: "Starting inference..." },
    });
    const state = useInferenceStore.getState();
    expect(state.log).toEqual(["Starting inference..."]);
  });

  it("appends stderr to log", () => {
    const { handleProcessEvent } = useInferenceStore.getState();
    handleProcessEvent({
      event: "stderr",
      data: { line: "Warning: something happened" },
    });
    const state = useInferenceStore.getState();
    expect(state.log).toEqual(["Warning: something happened"]);
  });

  it("sets completed on successful finish", () => {
    const { handleProcessEvent } = useInferenceStore.getState();
    handleProcessEvent({
      event: "finished",
      data: { success: true, code: 0 },
    });
    const state = useInferenceStore.getState();
    expect(state.status).toBe("completed");
    expect(state.error).toBeNull();
  });

  it("sets error on failed finish with exit code in message", () => {
    const { handleProcessEvent } = useInferenceStore.getState();
    handleProcessEvent({
      event: "finished",
      data: { success: false, code: 1 },
    });
    const state = useInferenceStore.getState();
    expect(state.status).toBe("error");
    expect(state.error).toContain("1");
  });

  it("toggles minimized state", () => {
    const { setMinimized } = useInferenceStore.getState();
    expect(useInferenceStore.getState().minimized).toBe(false);
    setMinimized(true);
    expect(useInferenceStore.getState().minimized).toBe(true);
    setMinimized(false);
    expect(useInferenceStore.getState().minimized).toBe(false);
  });

  it("resets to initial state", () => {
    const { handleProcessEvent, setMinimized, reset } =
      useInferenceStore.getState();

    // Modify state
    handleProcessEvent({ event: "stdout", data: { line: "some output" } });
    handleProcessEvent({
      event: "finished",
      data: { success: true, code: 0 },
    });
    setMinimized(true);

    // Verify state was modified
    const modified = useInferenceStore.getState();
    expect(modified.status).toBe("completed");
    expect(modified.log).toHaveLength(1);
    expect(modified.minimized).toBe(true);

    // Reset
    reset();

    const state = useInferenceStore.getState();
    expect(state.status).toBe("idle");
    expect(state.error).toBeNull();
    expect(state.progress).toBeNull();
    expect(state.log).toEqual([]);
    expect(state.minimized).toBe(false);
    expect(state.outputPath).toBeNull();
  });
});
