/**
 * The Training panel's dry-run card: per-model summary or error, a warning
 * once the config no longer matches what was checked, Cancel while running,
 * and dismiss after.
 */

import { describe, it, expect, beforeEach, vi } from "../bun-test";
import { render, screen, fireEvent, cleanup, within, act } from "@testing-library/react";
import { useTrainingStore, type DryRunState } from "@/stores/trainingStore";
import { DryRunResult } from "@/components/panels/DryRunResult";

function setDryRun(patch: Partial<DryRunState>) {
  const dryRun: DryRunState = {
    id: 1,
    status: "passed",
    models: [
      {
        label: "Centroid",
        status: "passed",
        summary: [
          { label: "Model type", value: "centroid" },
          { label: "Steps per epoch", value: "200 train, 1 val" },
        ],
        error: null,
        stderrTail: [],
      },
      {
        label: "Centered Instance",
        status: "failed",
        summary: null,
        error: "ValueError: bad crop",
        stderrTail: ["Traceback (most recent call last):", '  File "train.py", line 1', "ValueError: bad crop"],
      },
    ],
    log: ["— Dry run: Centroid...", "Dry run passed: ..."],
    config: useTrainingStore.getState().config,
    ...patch,
  };
  useTrainingStore.setState({ dryRun });
  return dryRun;
}

function Card() {
  const dryRun = useTrainingStore((s) => s.dryRun);
  return dryRun ? <DryRunResult dryRun={dryRun} /> : null;
}

const card = () => screen.queryByTestId("dry-run-result");

// happy-dom has no clipboard; record what the card writes.
let clipboardText: string | null = null;
Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: { writeText: vi.fn(async (t: string) => void (clipboardText = t)) },
});

describe("DryRunResult", () => {
  beforeEach(() => {
    cleanup();
    useTrainingStore.setState(useTrainingStore.getInitialState());
    clipboardText = null;
  });

  it("shows each model's summary or error output", () => {
    setDryRun({ status: "failed" });
    render(<Card />);
    const [centroid, centered] = screen.getAllByTestId("dry-run-model");
    expect(centroid.textContent).toContain("Steps per epoch");
    expect(centroid.textContent).toContain("200 train, 1 val");
    // The traceback, not just its last line.
    expect(centered.textContent).toContain("Traceback (most recent call last):");
    expect(centered.textContent).toContain("ValueError: bad crop");
    expect(card()!.textContent).toContain("Dry run failed");
  });

  it("copies a failed model's error output", async () => {
    setDryRun({ status: "failed" });
    render(<Card />);
    const centered = screen.getAllByTestId("dry-run-model")[1];
    await act(async () => {
      fireEvent.click(within(centered).getByRole("button", { name: "Copy error output" }));
    });
    expect(clipboardText).toBe(
      'Traceback (most recent call last):\n  File "train.py", line 1\nValueError: bad crop',
    );
  });

  it("copies the whole log", async () => {
    setDryRun({});
    render(<Card />);
    await act(async () => {
      fireEvent.click(within(card()!).getByRole("button", { name: "Copy log" }));
    });
    expect(clipboardText).toBe("— Dry run: Centroid...\nDry run passed: ...");
    expect(within(card()!).getByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("warns once the config changes after the check", () => {
    setDryRun({});
    render(<Card />);
    expect(card()!.textContent).not.toContain("config changed");

    act(() => useTrainingStore.getState().setConfig("trainingLabelsPath", "/data/other.slp"));
    expect(card()!.textContent).toContain("config changed");
  });

  it("shows the log on demand", () => {
    setDryRun({});
    render(<Card />);
    expect(card()!.textContent).not.toContain("— Dry run: Centroid...");
    fireEvent.click(within(card()!).getByText("Show log"));
    expect(card()!.textContent).toContain("— Dry run: Centroid...");
  });

  it("offers Cancel while running, which marks the run cancelled", async () => {
    setDryRun({ status: "running" });
    render(<Card />);
    await act(async () => {
      fireEvent.click(within(card()!).getByRole("button", { name: "Cancel" }));
    });
    expect(useTrainingStore.getState().dryRun!.status).toBe("cancelled");
  });

  it("dismisses a finished result", () => {
    setDryRun({});
    render(<Card />);
    fireEvent.click(within(card()!).getByRole("button", { name: "Dismiss dry run result" }));
    expect(useTrainingStore.getState().dryRun).toBeNull();
    expect(card()).toBeNull();
  });

  it("explains an unsupported sleap-nn", () => {
    setDryRun({ status: "unsupported" });
    render(<Card />);
    expect(card()!.textContent).toContain("release after 0.3.5");
  });
});
