/** The Correct tab's loop card: hidden until the loop has run, then status + actions. */

import { describe, it, expect, beforeEach, afterEach } from "../bun-test";
import { render, screen, cleanup } from "@testing-library/react";
import { Labels, Skeleton, Video } from "@talmolab/sleap-io.js";
import { LoopStatusCard } from "@/components/panels/LoopStatusCard";
import { useActiveLearningStore } from "@/stores/activeLearningStore";
import { useAppStore } from "@/stores/appStore";
import { DEFAULT_ACTIVE_LEARNING_CONFIG } from "@/lib/activeLearning/config";

function project(names: string[]) {
  const videos = names.map(
    (n) => new Video({ filename: `/d/${n}`, backendMetadata: { shape: [10, 8, 8, 1] }, openBackend: false }),
  );
  useAppStore.setState({ labels: new Labels({ videos, skeletons: [new Skeleton({ nodes: ["a"] })] }) });
}

describe("LoopStatusCard", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    useActiveLearningStore.getState().clear();
    useActiveLearningStore.getState().setConfig(DEFAULT_ACTIVE_LEARNING_CONFIG, []);
  });
  afterEach(() => cleanup());

  it("stays hidden before any round has trained", () => {
    project(["a.mp4"]);
    const { container } = render(<LoopStatusCard />);
    expect(container.textContent).toBe("");
  });

  it("shows the round, new vs predicted videos, last round, and the actions", () => {
    project(["a.mp4", "b.mp4", "c.mp4"]);
    const al = useActiveLearningStore.getState();
    al.recordTraining({
      round: 1,
      modelType: "top_down",
      models: [{ slot: "centroid", dir: "/m/c" }, { slot: "centered_instance", dir: "/m/ci" }],
      trainedAt: "t",
      fineTuned: false,
      predicted: { videos: 1, frames: 1800 },
      queued: 37,
    });
    al.markVideosPredicted(["a.mp4"]);
    al.setStage("reviewing");
    render(<LoopStatusCard />);
    expect(screen.getByText(/round 1 \/ 5/)).toBeTruthy();
    expect(screen.getByText("reviewing")).toBeTruthy();
    expect(screen.getByText(/1800 frame\(s\)/)).toBeTruthy();
    expect(screen.getByText(/37 queued for review/)).toBeTruthy();
    expect(screen.getByText("Predict 2 new videos now")).toBeTruthy();
    expect(screen.getByText("Retrain now → round 2")).toBeTruthy();
  });

  it("disables the actions while a round is training or predicting", () => {
    project(["a.mp4", "b.mp4"]);
    const al = useActiveLearningStore.getState();
    al.recordTraining({ round: 1, modelType: "single_animal", models: [{ slot: "config", dir: "/m" }], trainedAt: "t", fineTuned: false });
    al.setStage("predicting");
    al.setStageProgress({ done: 0, total: 3 });
    render(<LoopStatusCard />);
    expect(screen.getByText("predicting 1 of 3")).toBeTruthy();
    const retrain = screen.getByText("Retrain now → round 2").closest("button") as HTMLButtonElement;
    expect(retrain.disabled).toBe(true);
  });
});
