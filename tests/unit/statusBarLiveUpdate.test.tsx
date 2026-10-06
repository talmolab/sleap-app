/**
 * Regression test: the footer status bar must live-update instance/frame
 * counts as edits land in the SAME session, not just after a reload.
 *
 * Some commands mutate an already-referenced LabeledFrame's `instances`
 * array in place (e.g. bulk "accept all predictions", or any edit that
 * doesn't reselect a single instance) without ever swapping the `labels`,
 * `labeledFrame`, or `instance` store fields to a new reference. Zustand's
 * Object.is check means subscribing to those fields alone won't trigger a
 * re-render for such an edit — StatusBar must also subscribe to `editSeq`
 * (bumped by every `markChanged()`) so it re-renders on every edit,
 * matching the pattern already used by InstancesPanel/VideoPlayer for the
 * same class of bug.
 */
import { describe, it, expect, beforeEach, beforeAll } from "../bun-test";
import { render, screen, cleanup } from "@testing-library/react";
import { useAppStore } from "@/stores/appStore";
import { Instance, Labels, LabeledFrame, Skeleton, Video } from "@talmolab/sleap-io.js";

beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

function resetStore() {
  useAppStore.setState(useAppStore.getInitialState());
}

function makeInstance(skeleton: Skeleton): Instance {
  const inst = Instance.empty({ skeleton });
  skeleton.nodes.forEach((_, n) => {
    inst.points[n].xy = [10 * n, 20 * n];
    inst.points[n].visible = true;
    inst.points[n].complete = true;
  });
  return inst;
}

function loadProject() {
  const skeleton = new Skeleton({ nodes: ["a", "b"], name: "test" });
  const video = new Video({
    filename: "test.mp4",
    backendMetadata: { shape: [100, 480, 640, 3] },
    openBackend: false,
  });
  const labels = new Labels({ videos: [video], skeletons: [skeleton] });
  useAppStore.getState().setLabels(labels, "test.slp");
  useAppStore.getState().setVideo(video);
  useAppStore.getState().setFrameIdx(0);
  return { skeleton, video, labels };
}

describe("StatusBar live updates on in-place edits", () => {
  beforeEach(() => {
    cleanup();
    resetStore();
  });

  it("updates the instance count when instances are added to the SAME LabeledFrame reference without reselecting", async () => {
    const { skeleton, video, labels } = loadProject();
    const { StatusBar } = await import("@/components/layout/StatusBar");
    render(<StatusBar />);

    // First instance: a genuinely new LabeledFrame reference lands in the
    // store, so this update is visible even without an editSeq subscriber.
    const lf = new LabeledFrame({ video, frameIdx: 0 });
    lf.instances.push(makeInstance(skeleton));
    labels.append(lf);
    useAppStore.getState().setLabeledFrame(lf);
    useAppStore.getState().markChanged();
    expect(await screen.findByText("1 instance")).toBeTruthy();

    // Second instance: pushed onto the SAME `lf` object (mutated in place),
    // and setLabeledFrame(lf) sets that identical reference again — no
    // subscribed field's reference/value changes except editSeq.
    lf.instances.push(makeInstance(skeleton));
    useAppStore.getState().setLabeledFrame(lf);
    useAppStore.getState().markChanged();
    expect(await screen.findByText("2 instances")).toBeTruthy();
  });
});
