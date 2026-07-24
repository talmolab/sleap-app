/**
 * Regression test for the Phase-3 correction flow, end to end at the
 * data-model + command level (the layer a real GUI drives): load predictions →
 * build the worst-first queue → correct one instance → accept another untouched
 * → skip a third → undo. Proves the standalone tool turns predictions into
 * user-labeled ground truth and stays undoable.
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import {
  Labels,
  LabeledFrame,
  Instance,
  PredictedInstance,
  Skeleton,
  Video,
} from "@talmolab/sleap-io.js";
import { useAppStore } from "@/stores/appStore";
import { commandContext, BeginEdit } from "@/commands";
import { buildReviewQueue } from "@/lib/activeLearning/reviewQueue";
import { acceptAndAdvanceCorrection } from "@/lib/activeLearning/correctionActions";

const NODE_NAMES = ["head", "body", "tail"];

function makeSkeleton(): Skeleton {
  return new Skeleton({ nodes: [...NODE_NAMES], name: "test" });
}

function stubVideo(name: string): Video {
  const shape: [number, number, number, number] = [10, 480, 640, 1];
  const backend = { shape, getFrame: async () => null } as unknown as NonNullable<Video["backend"]>;
  return new Video({ filename: name, backend });
}

function makePredicted(
  skeleton: Skeleton,
  coords: Record<string, [number, number]>,
  scores: Record<string, number>,
): PredictedInstance {
  return new PredictedInstance({
    skeleton,
    points: skeleton.nodes.map((n) => ({
      xy: coords[n.name] ?? ([10, 20] as [number, number]),
      visible: true,
      complete: true,
      name: n.name,
      score: n.name in scores ? scores[n.name] : 0.99,
    })),
    score: 0.9,
  });
}

function isPredicted(inst: Instance | null): boolean {
  return inst instanceof PredictedInstance;
}

function countPredicted(labels: Labels): number {
  let n = 0;
  for (const lf of labels.labeledFrames) {
    for (const inst of lf.instances) if (inst instanceof PredictedInstance) n++;
  }
  return n;
}

describe("Phase-3 correction flow (regression)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("turns reviewed predictions into user labels, skips leave predictions, and undo restores", () => {
    const sk = makeSkeleton();
    const v = stubVideo("a.mp4");
    // Three predicted instances with distinct worst keypoints.
    const worst = makePredicted(sk, { tail: [40, 40] }, { tail: 0.1 }); // frame 2, worst overall
    const mid = makePredicted(sk, { head: [50, 50] }, { head: 0.3 }); // frame 0
    const easy = makePredicted(sk, { body: [60, 60] }, { body: 0.5 }); // frame 1
    const labels = new Labels({
      videos: [v],
      skeletons: [sk],
      labeledFrames: [
        new LabeledFrame({ video: v, frameIdx: 0, instances: [mid] }),
        new LabeledFrame({ video: v, frameIdx: 1, instances: [easy] }),
        new LabeledFrame({ video: v, frameIdx: 2, instances: [worst] }),
      ],
    });

    const store = useAppStore.getState();
    store.setLabels(labels);
    expect(countPredicted(labels)).toBe(3);

    // Build the queue and enter correction. Worst first: frame 2 (0.1) → 0 (0.3) → 1 (0.5).
    const queue = buildReviewQueue(labels, { limit: 50, scoreThreshold: 1 });
    expect(queue.map((q) => q.frameIdx)).toEqual([2, 0, 1]);
    store.enterCorrectMode({ queue, scoreThreshold: 0.3 });

    // --- Item 0 (frame 2): accept untouched → predicted becomes a user label. ---
    const item0 = queue[0];
    acceptAndAdvanceCorrection();
    let lf0 = labels.find({ video: v, frameIdx: item0.frameIdx })[0];
    expect(isPredicted(lf0.instances[item0.instanceIdx])).toBe(false);
    // Points are preserved through the conversion.
    expect(lf0.instances[item0.instanceIdx].points[item0.worstNodeIdx].xy).toEqual([40, 40]);
    expect(useAppStore.getState().correctCursor).toBe(1);

    // --- Item 1 (frame 0): simulate a drag-correction (adopt + move worst node),
    //     mirroring VideoPlayer's adopt-on-drag, then accept. ---
    const item1 = queue[1];
    useAppStore.getState().syncCorrectSelection();
    const lf1 = labels.find({ video: v, frameIdx: item1.frameIdx })[0];
    const predicted1 = lf1.instances[item1.instanceIdx];
    const adopted = new Instance({
      skeleton: predicted1.skeleton,
      points: predicted1.points.map((p, i) => ({
        xy: i === item1.worstNodeIdx ? ([123, 456] as [number, number]) : ([p.xy[0], p.xy[1]] as [number, number]),
        visible: p.visible,
        complete: p.complete,
        name: p.name,
      })),
      track: predicted1.track,
    });
    lf1.instances.splice(item1.instanceIdx, 1, adopted);
    useAppStore.getState().setInstance(adopted);
    acceptAndAdvanceCorrection(); // already a user instance → just advances
    const lf1After = labels.find({ video: v, frameIdx: item1.frameIdx })[0];
    expect(isPredicted(lf1After.instances[item1.instanceIdx])).toBe(false);
    expect(lf1After.instances[item1.instanceIdx].points[item1.worstNodeIdx].xy).toEqual([123, 456]);
    expect(useAppStore.getState().correctCursor).toBe(2);

    // --- Item 2 (frame 1): SKIP (advance without accepting) → stays predicted. ---
    const item2 = queue[2];
    useAppStore.getState().correctAdvance();
    const lf2 = labels.find({ video: v, frameIdx: item2.frameIdx })[0];
    expect(isPredicted(lf2.instances[item2.instanceIdx])).toBe(true);

    // Queue exhausted; two of three predictions are now user labels.
    expect(useAppStore.getState().correctCursor).toBe(3);
    expect(countPredicted(labels)).toBe(1);

    // --- Undo the second accept (item 1's adopt was not a command, but item 0's
    //     accept was ConvertPredictionToInstance) → restore that prediction. ---
    // Undo pops the most recent command snapshot. Item 1 was adopted directly
    // (no command); item 0's accept is the last COMMAND, so undo restores it.
    commandContext.undo();
    const lf0Undone = labels.find({ video: v, frameIdx: item0.frameIdx })[0];
    expect(isPredicted(lf0Undone.instances[item0.instanceIdx])).toBe(true);
    expect(countPredicted(labels)).toBe(2);
  });

  it("bails (no wrong-frame convert) when the item's frame can't be navigated to", () => {
    // Regression for the clamped-navigation hole: the stub video reports 10
    // frames (shape[0]=10), so setFrameIdx clamps any index to <= 9. An item at
    // frame 20 can never be framed, and frame 9 holds a DIFFERENT prediction —
    // accept must NOT convert frame 9's instance while the queue says "frame 20".
    const sk = makeSkeleton();
    const v = stubVideo("a.mp4"); // shape[0] = 10 → max frame 9
    const far = makePredicted(sk, { body: [1, 1] }, { body: 0.1 }); // frame 20 (worst)
    const near = makePredicted(sk, { body: [2, 2] }, { body: 0.5 }); // frame 9 (clamp target)
    const labels = new Labels({
      videos: [v],
      skeletons: [sk],
      labeledFrames: [
        new LabeledFrame({ video: v, frameIdx: 9, instances: [near] }),
        new LabeledFrame({ video: v, frameIdx: 20, instances: [far] }),
      ],
    });
    const store = useAppStore.getState();
    store.setLabels(labels);
    const queue = buildReviewQueue(labels, { limit: 50 });
    expect(queue[0].frameIdx).toBe(20); // worst first
    store.enterCorrectMode({ queue });

    acceptAndAdvanceCorrection();
    // Nothing converted, cursor did not advance — safe bail.
    expect(isPredicted(labels.find({ video: v, frameIdx: 20 })[0].instances[0])).toBe(true);
    expect(isPredicted(labels.find({ video: v, frameIdx: 9 })[0].instances[0])).toBe(true);
    expect(useAppStore.getState().correctCursor).toBe(0);
  });

  it("adopt-on-drag then undo restores the prediction", () => {
    const sk = makeSkeleton();
    const v = stubVideo("a.mp4");
    const pred = makePredicted(sk, { tail: [30, 30] }, { tail: 0.2 });
    const labels = new Labels({
      videos: [v],
      skeletons: [sk],
      labeledFrames: [new LabeledFrame({ video: v, frameIdx: 0, instances: [pred] })],
    });
    const store = useAppStore.getState();
    store.setLabels(labels);
    const queue = buildReviewQueue(labels, { limit: 50 });
    store.enterCorrectMode({ queue });
    const item = queue[0];
    useAppStore.getState().syncCorrectSelection();

    // Mirror VideoPlayer's adopt-on-drag: snapshot, then swap a user Instance in
    // place with the worst node moved.
    const lf = labels.find({ video: v, frameIdx: item.frameIdx })[0];
    commandContext.execute(BeginEdit);
    const predicted = lf.instances[item.instanceIdx] as PredictedInstance;
    const adopted = new Instance({
      skeleton: predicted.skeleton,
      points: predicted.points.map((p, i) => ({
        xy: i === item.worstNodeIdx ? ([77, 88] as [number, number]) : ([p.xy[0], p.xy[1]] as [number, number]),
        visible: p.visible,
        complete: p.complete,
        name: p.name,
      })),
      track: predicted.track,
    });
    lf.instances.splice(item.instanceIdx, 1, adopted);
    expect(isPredicted(labels.find({ video: v, frameIdx: 0 })[0].instances[0])).toBe(false);

    commandContext.undo();
    const restored = labels.find({ video: v, frameIdx: 0 })[0].instances[0];
    expect(isPredicted(restored)).toBe(true);
    expect(restored.points[item.worstNodeIdx].xy).toEqual([30, 30]);
  });

  it("undo/redo of a cross-frame accept navigates back, restores, and re-lands the cursor", () => {
    const sk = makeSkeleton();
    const v = stubVideo("a.mp4");
    const a = makePredicted(sk, { body: [1, 1] }, { body: 0.1 }); // frame 0 (worst, item 0)
    const b = makePredicted(sk, { body: [2, 2] }, { body: 0.5 }); // frame 7 (item 1)
    const labels = new Labels({
      videos: [v],
      skeletons: [sk],
      labeledFrames: [
        new LabeledFrame({ video: v, frameIdx: 0, instances: [a] }),
        new LabeledFrame({ video: v, frameIdx: 7, instances: [b] }),
      ],
    });
    const store = useAppStore.getState();
    store.setLabels(labels);
    store.enterCorrectMode({ queue: buildReviewQueue(labels, { limit: 50 }) });

    // Accept item 0 (frame 0) → converts and advances to item 1 (frame 7).
    acceptAndAdvanceCorrection();
    expect(isPredicted(labels.find({ video: v, frameIdx: 0 })[0].instances[0])).toBe(false);
    expect(useAppStore.getState().correctCursor).toBe(1);
    expect(useAppStore.getState().frameIdx).toBe(7);

    // Undo: navigate back to frame 0, restore the prediction, cursor back on item 0.
    commandContext.undo();
    expect(isPredicted(labels.find({ video: v, frameIdx: 0 })[0].instances[0])).toBe(true);
    expect(useAppStore.getState().frameIdx).toBe(0); // view followed the restore
    expect(useAppStore.getState().correctCursor).toBe(0);

    // Redo: re-accept item 0 (data round-trips).
    commandContext.redo();
    expect(isPredicted(labels.find({ video: v, frameIdx: 0 })[0].instances[0])).toBe(false);
  });

  it("an empty queue enters and immediately reports complete", () => {
    const sk = makeSkeleton();
    const v = stubVideo("a.mp4");
    // Only user instances → nothing to correct.
    const user = Instance.empty({ skeleton: sk });
    const labels = new Labels({
      videos: [v],
      skeletons: [sk],
      labeledFrames: [new LabeledFrame({ video: v, frameIdx: 0, instances: [user] })],
    });
    const store = useAppStore.getState();
    store.setLabels(labels);
    const queue = buildReviewQueue(labels, { limit: 50 });
    expect(queue.length).toBe(0);
    store.enterCorrectMode({ queue });
    const s = useAppStore.getState();
    expect(s.labelingMode).toBe("correct");
    expect(s.correctCursor).toBe(0);
    expect(s.correctQueue.length).toBe(0); // cursor(0) >= length(0) → complete state
  });
});
