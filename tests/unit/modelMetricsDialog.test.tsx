/**
 * Component smoke tests for the evaluation-metrics dialogs.
 *
 * Verifies that a fixture-derived model row renders in the table
 * (ModelMetricsDialog) and that clicking it opens the detail dialog
 * (DetailedModelMetricsDialog) with the per-node distance boxplot (node labels
 * from the training config) and the labeled scalar metrics. The row is built
 * through the real loading pipeline (buildModelMetricsRow) against the fixture
 * dir via an injected node:fs reader, then handed to the dialog through its
 * injectable `buildRow` prop — no Tauri runtime required.
 */

import { describe, it, expect, beforeAll, afterEach } from "../bun-test";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ModelMetricsDialog } from "@/components/dialogs/ModelMetricsDialog";
import { DetailedModelMetricsDialog } from "@/components/dialogs/DetailedModelMetricsDialog";
import {
  buildModelMetricsRow,
  type MetricsFsAccess,
} from "@/lib/metrics/loadModelMetrics";
import type { ModelMetricsRow } from "@/lib/metrics/types";

const FIXTURE_DIR = join(import.meta.dir, "../fixtures/metrics");

const diskFs: MetricsFsAccess = {
  async readTextFile(path: string) {
    return readFileSync(path, "utf-8");
  },
  async exists(path: string) {
    return existsSync(path);
  },
};

// Radix ScrollArea observes size; happy-dom lacks ResizeObserver.
beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

afterEach(() => cleanup());

async function fixtureRow(): Promise<ModelMetricsRow> {
  return buildModelMetricsRow(FIXTURE_DIR, { fs: diskFs, split: "val" });
}

describe("ModelMetricsDialog", () => {
  it("renders a summary row seeded from a run directory", async () => {
    const row = await fixtureRow();
    render(
      <ModelMetricsDialog
        open
        onOpenChange={() => {}}
        runDirs={[row.path]}
        buildRow={async () => row}
      />,
    );

    expect(await screen.findByText("Metrics for Trained Models")).toBeInTheDocument();
    // Config-derived columns.
    expect(await screen.findByText("Centered Instance")).toBeInTheDocument();
    // OKS mAP summary cell (4-decimal table formatting).
    expect(screen.getByText("0.6522")).toBeInTheDocument();
  });

  it("opens the detail dialog with the per-node boxplot on row click", async () => {
    const row = await fixtureRow();
    render(
      <ModelMetricsDialog
        open
        onOpenChange={() => {}}
        runDirs={[row.path]}
        buildRow={async () => row}
      />,
    );

    const cell = await screen.findByText("Centered Instance");
    fireEvent.click(cell);

    // Node labels come from the training config skeleton and are rendered in
    // the boxplot SVG.
    expect(await screen.findByText("head")).toBeInTheDocument();
    expect(screen.getByText("thorax")).toBeInTheDocument();
    expect(screen.getByText("abdomen")).toBeInTheDocument();
    // A labeled scalar metric from METRICS_KEY_LABELS parity.
    expect(
      screen.getByText("VOC with OKS scores - mean Average Precision (mAP)"),
    ).toBeInTheDocument();
  });
});

describe("DetailedModelMetricsDialog", () => {
  it("shows the boxplot + labeled metrics for a loaded model", async () => {
    const row = await fixtureRow();
    render(<DetailedModelMetricsDialog open onOpenChange={() => {}} row={row} />);

    expect(await screen.findByText("head")).toBeInTheDocument();
    // Detailed list uses 5-decimal formatting (parity with classic SLEAP).
    expect(
      screen.getByText("Mean Object Keypoint Similarity (OKS)"),
    ).toBeInTheDocument();
    expect(screen.getByText("0.78420")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: /node distance boxplot/i }),
    ).toBeInTheDocument();
  });

  it("shows a fallback message when a model has no metrics", () => {
    const emptyRow: ModelMetricsRow = {
      path: "/models/untrained_run",
      runName: "untrained_run",
      timestamp: null,
      modelType: null,
      architecture: null,
      nodeNames: null,
      metrics: null,
      summary: null,
    };
    render(<DetailedModelMetricsDialog open onOpenChange={() => {}} row={emptyRow} />);
    expect(
      screen.getByText("Metrics have not been generated for this model."),
    ).toBeInTheDocument();
  });
});
