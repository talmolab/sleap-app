/**
 * Tests the ModelMetricsDialog's auto-detect wiring: on open, it should scan
 * the current project's `models/` folder (via `findTrainedModels`, the same
 * scanner InferencePanel uses to auto-select a model) and merge any hits into
 * the seeded run-dir set, so users don't have to manually "Add Trained
 * Model(s)…" every model that's already on disk.
 *
 * `findTrainedModels` and `@tauri-apps/api/path` are mocked so this runs
 * without a Tauri runtime or real filesystem — the underlying scan logic
 * itself is covered independently by modelDiscovery.test.ts.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from "../bun-test";
import { render, screen, cleanup } from "@testing-library/react";

// `vi.mock` (bun `mock.module`) is NOT hoisted, so register mocks before the
// dialog module is dynamically imported below.
const findTrainedModelsMock = vi.fn(async () => [
  { path: "/project/models/250101_120000.centroid.n=100", headKey: "centroid", runName: null, mtimeMs: 1000 },
]);
vi.mock("@/lib/modelDiscovery", () => ({ findTrainedModels: findTrainedModelsMock }));
vi.mock("@tauri-apps/api/path", () => ({
  dirname: async (p: string) => p.replace(/[/\\][^/\\]+$/, ""),
}));

type DialogModule = typeof import("@/components/dialogs/ModelMetricsDialog");
let mod: DialogModule;
async function load(): Promise<DialogModule> {
  mod ??= await import("@/components/dialogs/ModelMetricsDialog");
  return mod;
}

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

afterEach(() => {
  cleanup();
  findTrainedModelsMock.mockClear();
});

describe("ModelMetricsDialog auto-detect", () => {
  it("merges the project's auto-detected models into the table on open", async () => {
    const { useAppStore } = await import("@/stores/appStore");
    useAppStore.getState().set("projectPath", "/project/labels.slp");

    const { ModelMetricsDialog } = await load();
    render(
      <ModelMetricsDialog
        open
        onOpenChange={() => {}}
        runDirs={[]}
        buildRow={async (dir) => ({
          path: dir,
          runName: null,
          timestamp: null,
          modelType: null,
          architecture: null,
          nodeNames: null,
          metrics: null,
          summary: null,
        })}
      />,
    );

    expect(await screen.findByText(/250101_120000\.centroid\.n=100/)).toBeInTheDocument();
    expect(findTrainedModelsMock).toHaveBeenCalledWith("/project");

    useAppStore.getState().set("projectPath", null);
  });

  it("does nothing when no project is loaded (projectPath null)", async () => {
    const { useAppStore } = await import("@/stores/appStore");
    useAppStore.getState().set("projectPath", null);

    const { ModelMetricsDialog } = await load();
    render(<ModelMetricsDialog open onOpenChange={() => {}} runDirs={[]} />);

    expect(await screen.findByText(/No trained models\./i)).toBeInTheDocument();
    expect(findTrainedModelsMock).not.toHaveBeenCalled();
  });
});
