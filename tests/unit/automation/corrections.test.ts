// Why: a correction becomes a user instance only when the user accepts it, as one undo step, and never from a stale picture.
import { describe, it, expect, beforeEach } from "../../bun-test";
import { Instance, PredictedInstance } from "@talmolab/sleap-io.js";
import { useAppStore } from "@/stores/appStore";
import {
  correctionResult,
  poseOf,
  proposalState,
  useProposalStore,
  type ProposalTarget,
} from "@/stores/proposalStore";
import { ConvertPredictionToInstance } from "@/commands/editCommands";
import { classifyDirty } from "@/lib/autosaveDirty";
import { proposalGhosts } from "@/hooks/useProposalGhosts";
import { AutomationError } from "@/automation/errors";
import { loadPredictionFixture } from "../helpers/automationFixture";

let fx: ReturnType<typeof loadPredictionFixture>;

const lf30 = () => fx.labels.find({ video: fx.video, frameIdx: 30 })[0];
const targetA: ProposalTarget = { flagId: "v0:f30:p0:aaaaaa", videoIdx: 0, frameIdx: 30, instIdx: 0, reason: "tail was on the floor" };
const targetB: ProposalTarget = { flagId: "v0:f30:p1:bbbbbb", videoIdx: 0, frameIdx: 30, instIdx: 1, reason: "head was off" };
const store = () => useProposalStore.getState();

async function codeOf(fn: () => unknown) {
  try {
    await fn();
  } catch (e) {
    return (e as AutomationError).code;
  }
  return null;
}

describe("correction proposals", () => {
  beforeEach(() => {
    fx = loadPredictionFixture();
    store().clear();
  });

  // Why: accepting turns the prediction into a user instance with Claude's changes, in place, keeping track and provenance.
  it("accept replaces the prediction with a user instance carrying the changes", async () => {
    const p = store().addCorrection(targetA, { 2: [150, 125], 1: null }, { pose: poseOf(fx.a) });
    await store().accept(p.id, fx.ctx);
    const lf = lf30();
    expect(lf.predictedInstances).toEqual([fx.b]);
    const user = lf.userInstances[0];
    expect(lf.instances.indexOf(user)).toBe(0); // in place of A
    expect(user.fromPredicted).toBe(fx.a);
    expect(user.points[2].xy).toEqual([150, 125]);
    expect(user.points[2].visible).toBe(true);
    expect(user.points[2].complete).toBe(true);
    expect(user.points[1].visible).toBe(false);
    expect(user.points[0].xy).toEqual([100, 100]); // unchanged node keeps the model's position
    expect(useAppStore.getState().frameIdx).toBe(30);
    expect(useAppStore.getState().instance).toBe(user);
    expect(fx.ctx.undoCommandName).toBe("Claude: tail was on the floor");
    expect(proposalState(store().proposals[0])).toBe("accepted");
    expect(correctionResult(store().proposals[0])).toBe(user);
  });

  // Why: one ⌘Z must bring the prediction back, and the suggestion can be accepted again; redo re-applies it.
  it("undo brings the prediction back as 'undone'; redo and re-accept work", async () => {
    const p = store().addCorrection(targetA, { 2: [150, 125] }, { pose: poseOf(fx.a) });
    await store().accept(p.id, fx.ctx);
    fx.ctx.undo();
    expect(lf30().userInstances).toHaveLength(0);
    expect(lf30().predictedInstances).toHaveLength(2);
    expect(proposalState(store().proposals[0])).toBe("undone");
    fx.ctx.redo();
    expect(lf30().userInstances[0].points[2].xy).toEqual([150, 125]);
    expect(proposalState(store().proposals[0])).toBe("accepted");
    fx.ctx.undo();
    await store().accept(p.id, fx.ctx);
    expect(lf30().userInstances[0].points[2].xy).toEqual([150, 125]);
    expect(lf30().predictedInstances).toHaveLength(1);
  });

  // Why: two animals on one frame: accepting one shifts the other's index, but its correction must still land on it.
  it("follows its prediction after another one on the frame is accepted", async () => {
    const pA = store().addCorrection(targetA, { 2: [150, 125] }, { pose: poseOf(fx.a) });
    const pB = store().addCorrection(targetB, { 0: [410, 95] }, { pose: poseOf(fx.b) });
    expect(store().proposals).toHaveLength(2); // a correction for another prediction doesn't replace it
    await store().accept(pA.id, fx.ctx);
    expect(proposalState(store().proposals[1])).toBe("pending");
    await store().accept(pB.id, fx.ctx);
    const users = lf30().userInstances;
    expect(users.map((u) => u.fromPredicted)).toEqual([fx.a, fx.b]);
    expect(users[1].points[0].xy).toEqual([410, 95]);
    expect(lf30().predictedInstances).toHaveLength(0);
  });

  // Why: if the user accepted or changed the prediction themselves, Claude's correction is stale and must be refused.
  it("is outdated once the user converts the prediction by hand", async () => {
    const p = store().addCorrection(targetA, { 2: [150, 125] }, { pose: poseOf(fx.a) });
    useAppStore.getState().setFrameIdx(30);
    await fx.ctx.execute(ConvertPredictionToInstance, { instanceIdx: 0 });
    expect(proposalState(store().proposals[0])).toBe("outdated");
    expect(await codeOf(() => store().accept(p.id, fx.ctx))).toBe("OUTDATED");
    expect(lf30().userInstances[0].points[2].xy).toEqual([130, 120]);
  });

  // Why: a correction proposed from a picture of a pose that has since changed must not be acceptable.
  it("is outdated when proposed from a pose no prediction has any more", () => {
    const stale = poseOf(fx.a);
    stale[0] = [1, 1, true];
    store().addCorrection(targetA, { 2: [150, 125] }, { pose: stale });
    expect(proposalState(store().proposals[0])).toBe("outdated");
  });

  // Why: if the user labeled that animal themselves (by hand, or from the prediction), accepting would label it twice.
  it("is outdated once a user instance overlaps its prediction, and accept refuses", async () => {
    const p = store().addCorrection(targetA, { 2: [150, 125] }, { pose: poseOf(fx.a) });
    lf30().instances.push(
      Instance.fromNumpy({
        pointsData: [
          [101, 100],
          [111, 110],
          [131, 121],
        ],
        skeleton: fx.skeleton,
      }),
    );
    expect(proposalState(store().proposals[0])).toBe("outdated");
    expect(await codeOf(() => store().accept(p.id, fx.ctx))).toBe("OUTDATED");
    expect(lf30().userInstances).toHaveLength(1);
  });

  // Why: a user instance made from the prediction (fromPredicted) means it is dealt with, even after the user moved it away.
  it("is outdated once a user instance links to its prediction", () => {
    store().addCorrection(targetA, { 2: [150, 125] }, { pose: poseOf(fx.a) });
    const moved = Instance.fromNumpy({
      pointsData: [
        [500, 400],
        [510, 410],
        [530, 420],
      ],
      skeleton: fx.skeleton,
    });
    moved.fromPredicted = fx.a;
    lf30().instances.push(moved);
    expect(proposalState(store().proposals[0])).toBe("outdated");
  });

  // Why: after undoing an accepted correction, a new one for the same prediction must replace it, not sit beside it.
  it("a new correction replaces an undone one for the same prediction", async () => {
    const p = store().addCorrection(targetA, { 2: [150, 125] }, { pose: poseOf(fx.a) });
    await store().accept(p.id, fx.ctx);
    fx.ctx.undo();
    expect(proposalState(store().proposals[0])).toBe("undone");
    store().addCorrection({ ...targetA, reason: "r2" }, { 2: [170, 140] }, { pose: poseOf(fx.a) });
    expect(store().proposals.map((x) => [x.reason, proposalState(x)])).toEqual([["r2", "pending"]]);
    expect(proposalGhosts(store().proposals, lf30(), fx.video, 0)).toHaveLength(1);
  });

  // Why: "accept as is" makes the prediction a label without changing any node.
  it("accepting with no changes makes the prediction a label as is", async () => {
    const p = store().addCorrection(targetA, {}, { pose: poseOf(fx.a) });
    await store().accept(p.id, fx.ctx);
    const user = lf30().userInstances[0];
    expect(user).not.toBeInstanceOf(PredictedInstance);
    expect(user.points.map((q) => [...q.xy])).toEqual(fx.a.points.map((q) => [...q.xy]));
  });

  // Why: a newer correction for the same prediction replaces the pending one, even if its id's index changed.
  it("a newer correction for the same prediction replaces the pending one", () => {
    store().addCorrection(targetA, { 2: [150, 125] }, { pose: poseOf(fx.a) });
    store().addCorrection({ ...targetA, flagId: "v0:f30:p3:aaaaaa", instIdx: 3 }, { 2: [151, 126] }, { pose: poseOf(fx.a) });
    expect(store().proposals).toHaveLength(1);
    expect(store().proposals[0].after).toEqual({ 2: [151, 126] });
  });

  // Why: the incremental autosave must journal just this frame, not force a full save.
  it("is a frame-level edit for autosave", () => {
    expect(
      classifyDirty({
        commandName: "AcceptCorrectedPrediction",
        frame: { videoRef: fx.video, frameIdx: 30 },
        scopedFrames: null,
        allFrames: null,
      } as Parameters<typeof classifyDirty>[0]).kind,
    ).toBe("frames");
  });
});
