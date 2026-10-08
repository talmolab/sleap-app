/**
 * The top-bar inference indicator vs. a finished REMOTE run. Main's Connect
 * inference doesn't merge until the user fetches (`pendingRemoteMerge`); the
 * bar must say so and offer the fetch — not claim "complete" and let Dismiss
 * (a store reset) silently throw the results away.
 */

import { describe, it, expect, beforeEach, afterEach } from "../bun-test";
import { render, screen, cleanup } from "@testing-library/react";
import { useInferenceStore } from "@/stores/inferenceStore";
import { InferenceProgressBar } from "@/components/layout/InferenceProgressBar";

describe("InferenceProgressBar", () => {
  beforeEach(() => {
    useInferenceStore.setState(useInferenceStore.getInitialState());
  });
  afterEach(() => cleanup());

  it("offers Fetch & Load (not Dismiss) while remote results await a merge", () => {
    useInferenceStore.setState({
      status: "completed",
      pendingRemoteMerge: { results: [], mode: "replace", trackOnly: false },
    });
    render(<InferenceProgressBar />);
    expect(screen.getByText(/not merged yet/)).toBeTruthy();
    expect(screen.getByText("Fetch & Load")).toBeTruthy();
    expect(screen.queryByText("Dismiss")).toBeNull();
  });

  it("shows a plain completion with Dismiss once nothing is pending", () => {
    useInferenceStore.setState({ status: "completed", pendingRemoteMerge: null });
    render(<InferenceProgressBar />);
    expect(screen.getByText("Inference complete")).toBeTruthy();
    expect(screen.getByText("Dismiss")).toBeTruthy();
  });
});
