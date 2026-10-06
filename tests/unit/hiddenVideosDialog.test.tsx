/**
 * PR3b §3b.3 — HiddenVideosDialog: the pre-submit dialog TrainingPanel opens
 * when a "this window" remote run has hidden videos (visibility case "some"
 * or "none"), offering Train (embed only labeled frames of hidden videos,
 * as buildRemoteLabelsPayload always does) or additionally embedding
 * suggested frames so post-training inference can cover a hidden video too.
 */
import { describe, it, expect, afterEach, vi } from "../bun-test";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Labels, LabeledFrame, Instance, Skeleton, SuggestionFrame, Video } from "@talmolab/sleap-io.js";
import type { VideoVisibility } from "@/lib/remoteVisibility";
import { HiddenVideosDialog } from "@/components/connect/HiddenVideosDialog";

const skeleton = new Skeleton({ nodes: ["a"], edges: [] });

function video(name: string): Video {
  return new Video({ filename: name, openBackend: false });
}

function instanceAt(v: Video, frameIdx: number): LabeledFrame {
  return new LabeledFrame({
    video: v,
    frameIdx,
    instances: [Instance.fromNumpy({ pointsData: [[1, 1]], skeleton })],
  });
}

/** `onTrain` has a required typed param, which this repo's `vi.fn()` shim
 * (typed `Mock<(...args: never[]) => unknown>`, not generic over the impl)
 * can't satisfy as a strictly-typed prop — track calls manually instead. */
function trackedTrain() {
  const calls: Array<{ embedFramesToPredict: boolean }> = [];
  const fn = (opts: { embedFramesToPredict: boolean }) => {
    calls.push(opts);
  };
  return { fn, calls };
}

afterEach(cleanup);

describe("HiddenVideosDialog", () => {
  it("lists hidden videos with their labeled-frame counts", () => {
    const hidden1 = video("hidden1.mp4");
    const hidden2 = video("hidden2.mp4");
    const visible = video("visible.mp4");
    const labels = new Labels({
      videos: [visible, hidden1, hidden2],
      skeletons: [skeleton],
      labeledFrames: [
        instanceAt(hidden1, 0),
        instanceAt(hidden1, 1),
        instanceAt(hidden2, 0),
      ],
    });
    const visibility: VideoVisibility[] = [
      { index: 0, local: "visible.mp4", worker: "/w/visible.mp4", visible: true },
      { index: 1, local: "hidden1.mp4", worker: null, visible: false, reason: "no-location" },
      { index: 2, local: "hidden2.mp4", worker: null, visible: false, reason: "no-location" },
    ];
    render(
      <HiddenVideosDialog
        open
        onClose={() => {}}
        labels={labels}
        visibility={visibility}
        inferenceTarget="nothing"
        onTrain={() => {}}
      />,
    );
    expect(screen.getByText(/hidden1\.mp4/)).toBeInTheDocument();
    expect(screen.getByText(/2 frames/)).toBeInTheDocument();
    expect(screen.getByText(/hidden2\.mp4/)).toBeInTheDocument();
    expect(screen.getByText(/1 frame\b/)).toBeInTheDocument();
    expect(screen.queryByText(/visible\.mp4/)).toBeNull();
  });

  it("shows the coverage outcome for the visibility case", () => {
    const hidden = video("hidden.mp4");
    const labels = new Labels({ videos: [hidden], skeletons: [skeleton], labeledFrames: [] });
    const visibility: VideoVisibility[] = [
      { index: 0, local: "hidden.mp4", worker: null, visible: false, reason: "no-location" },
    ];
    render(
      <HiddenVideosDialog
        open
        onClose={() => {}}
        labels={labels}
        visibility={visibility}
        inferenceTarget="nothing"
        onTrain={() => {}}
      />,
    );
    expect(screen.getByText(/Training only — videos not visible/)).toBeInTheDocument();
  });

  it("disables 'Also embed' unless the target is suggestions AND hidden videos have suggestions", () => {
    const hidden = video("hidden.mp4");
    const labels = new Labels({
      videos: [hidden],
      skeletons: [skeleton],
      labeledFrames: [],
      suggestions: [new SuggestionFrame({ video: hidden, frameIdx: 0 })],
    });
    const visibility: VideoVisibility[] = [
      { index: 0, local: "hidden.mp4", worker: null, visible: false, reason: "no-location" },
    ];

    const { rerender } = render(
      <HiddenVideosDialog
        open
        onClose={() => {}}
        labels={labels}
        visibility={visibility}
        inferenceTarget="user_labeled"
        onTrain={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /Also embed/ })).toBeDisabled();

    rerender(
      <HiddenVideosDialog
        open
        onClose={() => {}}
        labels={labels}
        visibility={visibility}
        inferenceTarget="suggestions"
        onTrain={() => {}}
      />,
    );
    const enableBtn = screen.getByRole("button", { name: /Also embed 1 suggested frame/ });
    expect(enableBtn).not.toBeDisabled();
  });

  it("disables 'Also embed' when hidden videos have zero suggestions, even for target=suggestions", () => {
    const hidden = video("hidden.mp4");
    const labels = new Labels({ videos: [hidden], skeletons: [skeleton], labeledFrames: [] });
    const visibility: VideoVisibility[] = [
      { index: 0, local: "hidden.mp4", worker: null, visible: false, reason: "no-location" },
    ];
    render(
      <HiddenVideosDialog
        open
        onClose={() => {}}
        labels={labels}
        visibility={visibility}
        inferenceTarget="suggestions"
        onTrain={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /Also embed/ })).toBeDisabled();
  });

  it("Train trains without embedding frames to predict, and closes", () => {
    const hidden = video("hidden.mp4");
    const labels = new Labels({ videos: [hidden], skeletons: [skeleton], labeledFrames: [] });
    const visibility: VideoVisibility[] = [
      { index: 0, local: "hidden.mp4", worker: null, visible: false, reason: "no-location" },
    ];
    const { fn: onTrain, calls } = trackedTrain();
    const onClose = vi.fn();
    render(
      <HiddenVideosDialog
        open
        onClose={onClose}
        labels={labels}
        visibility={visibility}
        inferenceTarget="nothing"
        onTrain={onTrain}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Train" }));
    expect(calls).toEqual([{ embedFramesToPredict: false }]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("'Also embed' trains WITH embedFramesToPredict, and closes", () => {
    const hidden = video("hidden.mp4");
    const labels = new Labels({
      videos: [hidden],
      skeletons: [skeleton],
      labeledFrames: [],
      suggestions: [new SuggestionFrame({ video: hidden, frameIdx: 0 })],
    });
    const visibility: VideoVisibility[] = [
      { index: 0, local: "hidden.mp4", worker: null, visible: false, reason: "no-location" },
    ];
    const { fn: onTrain, calls } = trackedTrain();
    const onClose = vi.fn();
    render(
      <HiddenVideosDialog
        open
        onClose={onClose}
        labels={labels}
        visibility={visibility}
        inferenceTarget="suggestions"
        onTrain={onTrain}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Also embed 1 suggested frame/ }));
    expect(calls).toEqual([{ embedFramesToPredict: true }]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Cancel closes without training", () => {
    const hidden = video("hidden.mp4");
    const labels = new Labels({ videos: [hidden], skeletons: [skeleton], labeledFrames: [] });
    const visibility: VideoVisibility[] = [
      { index: 0, local: "hidden.mp4", worker: null, visible: false, reason: "no-location" },
    ];
    const { fn: onTrain, calls } = trackedTrain();
    const onClose = vi.fn();
    render(
      <HiddenVideosDialog
        open
        onClose={onClose}
        labels={labels}
        visibility={visibility}
        inferenceTarget="nothing"
        onTrain={onTrain}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(calls).toHaveLength(0);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Locate on worker closes without training", () => {
    const hidden = video("hidden.mp4");
    const labels = new Labels({ videos: [hidden], skeletons: [skeleton], labeledFrames: [] });
    const visibility: VideoVisibility[] = [
      { index: 0, local: "hidden.mp4", worker: null, visible: false, reason: "no-location" },
    ];
    const { fn: onTrain, calls } = trackedTrain();
    const onClose = vi.fn();
    render(
      <HiddenVideosDialog
        open
        onClose={onClose}
        labels={labels}
        visibility={visibility}
        inferenceTarget="nothing"
        onTrain={onTrain}
      />,
    );
    fireEvent.click(screen.getByText(/Locate on worker/));
    expect(calls).toHaveLength(0);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
