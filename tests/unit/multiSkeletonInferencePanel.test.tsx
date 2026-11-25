/**
 * The Inference panel on a mice + pellet project (#99): no longer gated — it
 * explains that models are matched to skeletons by node names, and on a
 * worker it refuses the targets sleap-nn can't run on mixed-skeleton frames.
 */

import { describe, it, expect, afterEach, vi } from "../bun-test";
import { render, screen, cleanup, fireEvent, within, waitFor, act } from "@testing-library/react";
import { useAppStore } from "@/stores/appStore";
import { useConnectStore } from "@/stores/connectStore";
import { Labels } from "@talmolab/sleap-io.js";
import { makeMouseSkeleton, makeTwoSkeletonProject } from "./multiSkeletonFixture";
import type { InferenceConfig } from "@/stores/inferenceStore";

vi.mock("@/lib/platform", () => ({ isTauri: false, isMac: false, modKey: "Ctrl" }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
// The worker file browser "picks" the next queued path.
const pickQueue: string[] = [];
vi.mock("@/components/dialogs/RemoteFileBrowser", () => ({
  RemoteFileBrowser: ({ open, onSelect }: { open: boolean; onSelect: (p: string) => void }) =>
    open ? <button data-testid="mock-pick" onClick={() => onSelect(pickQueue.shift()!)}>pick</button> : null,
}));

const { InferencePanel } = await import("@/components/panels/InferencePanel");
const { useInferenceStore, useSkeletonInferenceSettingsStore, SKELETON_INFERENCE_SETTINGS_STORAGE_KEY } = await import(
  "@/stores/inferenceStore"
);

/** A worker's training_config.yaml for a model of `head` trained on `nodes`. */
function trainingConfig(skeleton: string, nodes: string[], head: string): string {
  return [
    "data_config:",
    "  skeletons:",
    `  - name: ${skeleton}`,
    "    nodes:",
    ...nodes.map((n) => `    - name: ${n}`),
    "model_config:",
    "  head_configs:",
    `    ${head}:`,
    "      confmaps: {anchor_part: " + nodes[0] + "}",
  ].join("\n");
}

const WORKER_MODELS: Record<string, string> = {
  "/w/mouse_centroid/training_config.yaml": trainingConfig("mouse", ["head", "body", "tail"], "centroid"),
  "/w/mouse_ci/training_config.yaml": trainingConfig("mouse", ["head", "body", "tail"], "centered_instance"),
  "/w/pellet_centroid/training_config.yaml": trainingConfig("pellet", ["centroid"], "centroid"),
};

/** Connected to a worker whose fs.read serves WORKER_MODELS. */
function connectWorker() {
  useConnectStore.setState({
    connectionStatus: "connected",
    selectedWorkerId: "w1",
    workerMounts: [{ path: "/w" }],
    _client: {
      fsRead: async (path: string) => ({ content: new TextEncoder().encode(WORKER_MODELS[path] ?? ""), eof: true }),
    },
  } as unknown as Parameters<typeof useConnectStore.setState>[0]);
}

/** Add the mouse top-down pair and the pellet centroid model from the worker. */
async function addWorkerModels() {
  for (const path of ["/w/mouse_centroid", "/w/mouse_ci", "/w/pellet_centroid"]) {
    pickQueue.push(path);
    fireEvent.click(screen.getByText("Browse Worker"));
    fireEvent.click(screen.getByTestId("mock-pick"));
  }
  await screen.findByTestId("skeleton-tabs");
}

/** In a browser build the panel needs a connected worker to show its body. */
function renderWith(labels: Labels) {
  useAppStore.getState().setLabels(labels, "p.slp");
  useConnectStore.setState({ connectionStatus: "connected" });
  return render(<InferencePanel />);
}

afterEach(() => {
  cleanup();
  useAppStore.setState(useAppStore.getInitialState());
  useConnectStore.setState(useConnectStore.getInitialState());
  useInferenceStore.setState(useInferenceStore.getInitialState());
  useSkeletonInferenceSettingsStore.setState({ bySkeleton: {} });
  localStorage.clear();
  pickQueue.length = 0;
});

describe("Inference panel with several skeletons", () => {
  // Inference is no longer refused on mice + pellets: the panel shows instead.
  it("shows the panel with the node-name matching note, not the gate", () => {
    renderWith(makeTwoSkeletonProject().labels);
    expect(screen.queryByTestId("multi-skeleton-gate")).toBeNull();
    expect(screen.getByTestId("multi-skeleton-pipeline-note")).toBeTruthy();
  });

  // Single-skeleton projects keep the pipeline picker (no note).
  it("keeps the pipeline picker on a single-skeleton project", () => {
    renderWith(new Labels({ skeletons: [makeMouseSkeleton()] }));
    expect(screen.queryByTestId("multi-skeleton-pipeline-note")).toBeNull();
  });
});

describe("per-skeleton tabs", () => {
  // Single-skeleton projects look as before: no tabs, the shared Tracking section.
  it("shows no tabs on a single-skeleton project", () => {
    renderWith(new Labels({ skeletons: [makeMouseSkeleton()] }));
    expect(screen.queryByTestId("skeleton-tabs")).toBeNull();
    expect(screen.getByText("Tracking")).toBeTruthy();
    expect(screen.getByText("Peak threshold")).toBeTruthy();
  });

  // Several skeletons: one tab per skeleton with models, each holding that
  // skeleton's models and its own Max instances / peak threshold / tracking.
  it("shows one tab per skeleton with models, with that skeleton's models", async () => {
    useAppStore.getState().setLabels(makeTwoSkeletonProject().labels, "p.slp");
    connectWorker();
    render(<InferencePanel />);
    await addWorkerModels();

    expect(screen.getByTestId("skeleton-tab-mouse")).toBeTruthy();
    expect(screen.getByTestId("skeleton-tab-pellet")).toBeTruthy();
    const mouseTab = screen.getByTestId("skeleton-tab-content-mouse");
    expect(within(mouseTab).getByText("/w/mouse_centroid")).toBeTruthy();
    expect(within(mouseTab).getByText("/w/mouse_ci")).toBeTruthy();
    expect(within(mouseTab).queryByText("/w/pellet_centroid")).toBeNull();
    expect(within(mouseTab).getByText("Peak threshold")).toBeTruthy();
    expect(within(mouseTab).getByText("Enable tracking")).toBeTruthy();
    // Per-run settings live in the tabs, not in shared sections.
    expect(screen.queryByText("Tracking")).toBeNull();
    expect(screen.getAllByText("Peak threshold")).toHaveLength(1);
    expect(screen.queryByTestId("multi-skeleton-per-run-limit")).toBeNull();

    fireEvent.mouseDown(screen.getByTestId("skeleton-tab-pellet"));
    const pelletTab = await screen.findByTestId("skeleton-tab-content-pellet");
    expect(within(pelletTab).getByText("/w/pellet_centroid")).toBeTruthy();
    expect(within(pelletTab).getByText(/Centroid only/)).toBeTruthy();

    // A 1-node skeleton's tracking shows point distance and says why.
    expect(within(mouseTab).queryByTestId("single-point-similarity-note")).toBeNull();
    fireEvent.click(within(pelletTab).getByLabelText("Enable tracking"));
    expect(within(pelletTab).getByTestId("single-point-similarity-note").textContent).toMatch(/OKS and IoU need several points/);
    expect(within(pelletTab).getByTestId("tracking-similarity").textContent).toMatch(/Euclidean dist\./);
  });

  // Run sends each skeleton's own settings, and they're saved by name + node set.
  it("runs each skeleton with its own tab's settings and saves them", async () => {
    useAppStore.getState().setLabels(makeTwoSkeletonProject().labels, "p.slp");
    connectWorker();
    const started: InferenceConfig[] = [];
    useInferenceStore.setState({ startInference: async (config: InferenceConfig) => void started.push(config) });
    render(<InferencePanel />);
    await addWorkerModels();

    // Mice: 2 instances + tracking (typed in the mouse tab).
    const mouseTab = screen.getByTestId("skeleton-tab-content-mouse");
    fireEvent.click(within(mouseTab).getByLabelText("No limit"));
    fireEvent.click(within(mouseTab).getByLabelText("Enable tracking"));
    // Pellets: 10 instances, no tracking.
    fireEvent.mouseDown(screen.getByTestId("skeleton-tab-pellet"));
    await screen.findByTestId("skeleton-tab-content-pellet");
    act(() => {
      useSkeletonInferenceSettingsStore.getState().update("pellet|centroid", { noMaxInstances: false, maxInstances: 10 });
    });

    pickQueue.push("/w/p.slp");
    fireEvent.click(screen.getByPlaceholderText("Select a .slp or video file on the worker").parentElement!.querySelector("button")!);
    fireEvent.click(screen.getByTestId("mock-pick"));
    const run = screen.getByText("Run Remote Inference").closest("button")!;
    await waitFor(() => expect(run.disabled).toBe(false));
    fireEvent.click(run);

    await waitFor(() => expect(started).toHaveLength(1));
    const config = started[0];
    expect(config.skeletonRuns!.map((r) => [r.skeletonName, r.settings?.maxInstances, r.settings?.tracking])).toEqual([
      ["mouse", 2, true],
      ["pellet", 10, false],
    ]);
    const saved = JSON.parse(localStorage.getItem(SKELETON_INFERENCE_SETTINGS_STORAGE_KEY)!);
    expect(saved.state.bySkeleton["mouse|body,head,tail"]).toMatchObject({ maxInstances: 2, noMaxInstances: false, tracking: true });
  });
});
