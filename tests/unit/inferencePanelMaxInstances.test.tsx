/**
 * Max Instances set in the Inference panel's Full Configuration window has to
 * reach the run. The window only set the number and left the panel's "No
 * limit" box (on by default) checked, so the run still sent no limit.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "../bun-test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { InferenceConfig } from "@/stores/inferenceStore";

const realPlatform = await import("@/platform");
vi.mock("@/platform", () => ({ ...realPlatform, isTauri: true }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async () => "cpu",
  Channel: class {},
  convertFileSrc: (p: string) => p,
}));

let InferencePanel: typeof import("@/components/panels/InferencePanel").InferencePanel;
let useInferenceStore: typeof import("@/stores/inferenceStore").useInferenceStore;
let useEnvironmentStore: typeof import("@/stores/environmentStore").useEnvironmentStore;

const startInference = vi.fn(async (_config: InferenceConfig) => {});

beforeAll(async () => {
  ({ InferencePanel } = await import("@/components/panels/InferencePanel"));
  ({ useInferenceStore } = await import("@/stores/inferenceStore"));
  ({ useEnvironmentStore } = await import("@/stores/environmentStore"));
});

beforeEach(() => {
  startInference.mockClear();
  useInferenceStore.setState({ status: "idle", startInference } as never);
  useEnvironmentStore.setState({ tools: [{ name: "sleap-nn" }], detectionStatus: "done" } as never);
});

/** Open Full Configuration, commit `value` in Max Instances, close it, Run. */
async function runWithDialogMaxInstances(value: string): Promise<InferenceConfig> {
  render(<InferencePanel />);
  // Track only needs no model, so Run is enabled without one.
  fireEvent.click(screen.getByLabelText("Track only"));
  fireEvent.click(screen.getByRole("button", { name: /Full Configuration/ }));
  const field = await waitFor(() => {
    const input = document.querySelector<HTMLInputElement>("#field-maxinstances input");
    if (!input) throw new Error("Max Instances field not rendered");
    return input;
  });
  fireEvent.change(field, { target: { value } });
  fireEvent.blur(field);
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: /Run Inference/ }));
  await waitFor(() => expect(startInference).toHaveBeenCalledTimes(1));
  return startInference.mock.calls[0][0] as unknown as InferenceConfig;
}

describe("Max Instances from the Full Configuration window", () => {
  it("is sent to the run", async () => {
    const config = await runWithDialogMaxInstances("3");
    expect(config.maxInstances).toBe(3);
  });

  it("clearing it there sends no limit", async () => {
    const config = await runWithDialogMaxInstances("");
    expect(config.maxInstances).toBeNull();
  });
});
