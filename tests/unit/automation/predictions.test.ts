// Why: Claude must be pointed at the predictions worth a look, by ids that keep pointing at the same animal.
import { describe, it, expect, beforeEach } from "../../bun-test";
import { useAppStore } from "@/stores/appStore";
import { useModelOverlayStore } from "@/stores/modelOverlayStore";
import { useProposalStore } from "@/stores/proposalStore";
import { ConvertPredictionToInstance } from "@/commands/editCommands";
import {
  clearDisagreementCache,
  findPrediction,
  listPredictionCandidates,
  parsePredictionId,
  quantiles,
  sortCandidates,
} from "@/automation/predictions";
import { registry } from "@/automation/tools";
import { clearRenders, rememberRender } from "@/automation/render";
import { poseOf } from "@/stores/proposalStore";
import { AutomationError } from "@/automation/errors";
import { loadFixtureWithOneInstance, loadPredictionFixture } from "../helpers/automationFixture";
import type { ToolResult } from "@/automation/registry";

let fx: ReturnType<typeof loadPredictionFixture>;

const json = (r: ToolResult) => JSON.parse((r.content[0] as { text: string }).text);

async function codeOf(fn: () => unknown) {
  try {
    await fn();
  } catch (e) {
    return (e as AutomationError).code;
  }
  return null;
}

/** Two Compare Models models on the video; on frame 30 they put B's tail 40 px apart. */
function loadDisagreeingModels() {
  const pose = (dx: number, tailDy: number) => ({
    xy: new Float64Array([100 + dx, 100, 110 + dx, 110, 130 + dx, 120 + tailDy]),
    score: 0.9,
    trackName: null,
  });
  useModelOverlayStore.getState().addModels(fx.labels, [
    { name: "m1", source: "m1.slp", video: fx.video, frames: new Map([[30, [pose(300, 0)]]]) },
    { name: "m2", source: "m2.slp", video: fx.video, frames: new Map([[30, [pose(300, 40)]]]) },
  ]);
}

describe("prediction candidates", () => {
  beforeEach(() => {
    useModelOverlayStore.getState().clear();
    clearDisagreementCache();
    clearRenders();
    fx = loadPredictionFixture();
    useProposalStore.getState().clear();
  });

  // Why: only predictions the model was unsure of are listed; ones the user already labeled are not.
  it("lists low-scored predictions and leaves out confident and already-labeled ones", () => {
    const list = listPredictionCandidates();
    const got = list.candidates.map((c) => [c.frameIdx, c.predIdx]);
    expect(got).toEqual([
      [30, 0],
      [40, 0],
    ]);
    const a = list.candidates.find((c) => c.frameIdx === 30)!;
    expect(a.lowNodes).toEqual([{ node: 2, score: expect.closeTo(0.2, 5) }]);
    expect(a.lowInstance).toBe(false);
    expect(list.candidates.find((c) => c.frameIdx === 40)!.lowInstance).toBe(true);
    // Frame 20's and frame 50's predictions are dealt with: A, B and C were looked at.
    expect(list.reviewed).toBe(3);
    expect(list.scoreSummary.instance?.median).toBeGreaterThan(0);
  });

  // Why: the least confident prediction should come first.
  it("sorts least confident first", () => {
    const sorted = sortCandidates(listPredictionCandidates().candidates, "score");
    expect(sorted.map((c) => c.frameIdx)).toEqual([30, 40]); // tail 0.2 < instance 0.3
    expect(sortCandidates(listPredictionCandidates().candidates, "frame").map((c) => c.frameIdx)).toEqual([30, 40]);
  });

  // Why: thresholds are Claude's to change when the defaults list too much or too little.
  it("takes other thresholds", () => {
    expect(listPredictionCandidates({ maxNodeScore: 0.1, maxInstanceScore: 0.1 }).candidates).toHaveLength(0);
    expect(listPredictionCandidates({ maxNodeScore: 0.95 }).candidates.map((c) => c.frameIdx)).toContain(30);
    expect(listPredictionCandidates({ maxNodeScore: 0.95 }).candidates.filter((c) => c.frameIdx === 30)).toHaveLength(2);
  });

  // Why: accepting one prediction shifts the others' indices; an id must still find its own animal.
  it("resolves an id by its pose after the indices shift, and refuses a gone prediction", async () => {
    const list = listPredictionCandidates({ maxNodeScore: 0.95 });
    const bId = list.candidates.find((c) => c.instance === fx.b)!.id;
    const aId = list.candidates.find((c) => c.instance === fx.a)!.id;
    expect(parsePredictionId(bId).predIdx).toBe(1);
    useAppStore.getState().setFrameIdx(30);
    await fx.ctx.execute(ConvertPredictionToInstance, { instanceIdx: 0 }); // A becomes a user instance
    const b = findPrediction(fx.labels, bId);
    expect(b.instance).toBe(fx.b);
    expect(b.predIdx).toBe(0);
    expect(await codeOf(() => findPrediction(fx.labels, aId))).toBe("UNKNOWN_PREDICTION");
    expect(await codeOf(() => findPrediction(fx.labels, "v0:f30:i1:anomaly"))).toBe("BAD_INPUT");
  });

  // Why: when Compare Models shows models that disagree, that animal needs a look even if its scores are high.
  it("lists predictions the compared models disagree on, with each model's placement", () => {
    loadDisagreeingModels();
    const list = listPredictionCandidates();
    const b = list.candidates.find((c) => c.instance === fx.b)!;
    expect(b.disagreement?.models.map((m) => m.model)).toEqual(["m1", "m2"]);
    expect(b.disagreement?.nodes).toEqual([{ node: 2, spreadPx: 20 }]);
    expect(list.unmatchedDisagreements).toBe(0);
    expect(listPredictionCandidates({ disagreement: false }).candidates.some((c) => c.instance === fx.b)).toBe(false);
    // Disagreement-only candidates sort after low-scored ones, first in "disagreement" order.
    expect(sortCandidates(list.candidates, "score").at(-1)!.instance).toBe(fx.b);
    expect(sortCandidates(list.candidates, "disagreement")[0].instance).toBe(fx.b);
  });

  // Why: a disagreeing animal the project has no prediction for can't be corrected; Claude is told how many.
  it("counts disagreements that match no project prediction", () => {
    const pose = (dy: number) => ({ xy: new Float64Array([400, 400, 410, 410, 430, 420 + dy]), score: 1, trackName: null });
    useModelOverlayStore.getState().addModels(fx.labels, [
      { name: "m1", source: "m1.slp", video: fx.video, frames: new Map([[60, [pose(0)]]]) },
      { name: "m2", source: "m2.slp", video: fx.video, frames: new Map([[60, [pose(50)]]]) },
    ]);
    expect(listPredictionCandidates().unmatchedDisagreements).toBe(1);
  });

  // Why: score_summary is sampled for huge projects but must stay sensible.
  it("quantiles", () => {
    expect(quantiles([])).toBeNull();
    expect(quantiles([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0])).toEqual({ p10: 0.2, median: 0.6, p90: 1 });
  });
});

describe("prediction review tools", () => {
  beforeEach(() => {
    useModelOverlayStore.getState().clear();
    clearDisagreementCache();
    clearRenders();
    fx = loadPredictionFixture();
    useProposalStore.getState().clear();
  });

  /** A render of prediction `inst` like render_prediction remembers (no canvas in tests). */
  function renderOf(id: string) {
    const t = findPrediction(fx.labels, id);
    return rememberRender({
      labels: fx.labels,
      pose: poseOf(t.instance),
      flagId: t.id,
      videoIdx: t.videoIdx,
      frameIdx: t.frameIdx,
      instIdx: t.predIdx,
      transform: { originX: 50, originY: 50, scale: 2, offsetX: 0, offsetY: 0 },
      width: 400,
      height: 400,
    });
  }

  // Why: the tool is what Claude reads; it must name nodes and say why each prediction is listed.
  it("list_predictions_to_review reports reasons by node name", async () => {
    const out = json(await registry.call("list_predictions_to_review", {}));
    expect(out.total).toBe(2);
    expect(out.predictions[0]).toMatchObject({
      frame: 30,
      low_instance_score: false,
      low_nodes: [{ node: "tail", score: 0.2 }],
      disagreement: null,
      proposal: null,
    });
    expect(out.compare_models).toBeNull();
    expect(out.thresholds).toEqual({ instance_score: 0.5, node_score: 0.5, disagreement_px: null });
    const paged = json(await registry.call("list_predictions_to_review", { offset: 1, limit: 1 }));
    expect(paged.predictions.map((p: { frame: number }) => p.frame)).toEqual([40]);
  });

  // Why: with no predictions there is nothing to review; Claude should say how to get some.
  it("errors when the project has no predictions", async () => {
    loadFixtureWithOneInstance();
    expect(await codeOf(() => registry.call("list_predictions_to_review", {}))).toBe("NO_PREDICTIONS");
  });

  // Why: Claude gives picture pixels; the correction must hold frame coordinates and change nothing yet.
  it("propose_correction converts picture pixels and adds a pending correction", async () => {
    const [first] = json(await registry.call("list_predictions_to_review", {})).predictions;
    const r = renderOf(first.id);
    const out = json(
      await registry.call("propose_correction", {
        prediction_id: first.id,
        render_id: r.renderId,
        nodes: { tail: [200, 150] },
        reason: "tail was on the floor",
      }),
    );
    expect(out.status).toBe("pending");
    const [p] = useProposalStore.getState().proposals;
    expect(p.kind).toBe("correct");
    expect(p.after).toEqual({ 2: [150, 125] });
    expect(p.before).toEqual({ 2: [130, 120] });
    // Labels unchanged: A is still a prediction where it was.
    expect(fx.labels.find({ video: fx.video, frameIdx: 30 })[0].predictedInstances[0]).toBe(fx.a);
    expect(fx.a.points[2].xy).toEqual([130, 120]);
    const listed = json(await registry.call("list_proposals", {}));
    expect(listed.proposals[0]).toMatchObject({ prediction_id: first.id, kind: "correct", status: "pending", prediction: 0 });
    expect(listed.proposals[0].after).toEqual({ tail: [150, 125] });
    // The candidate list shows Claude's proposal for it.
    expect(json(await registry.call("list_predictions_to_review", {})).predictions[0].proposal).toBe("pending");
  });

  // Why: an empty correction means "the prediction is right": it can be accepted as a label as is.
  it("propose_correction with no nodes proposes accepting the prediction as is", async () => {
    const [first] = json(await registry.call("list_predictions_to_review", {})).predictions;
    const r = renderOf(first.id);
    const out = json(
      await registry.call("propose_correction", { prediction_id: first.id, render_id: r.renderId, nodes: {}, reason: "looks right" }),
    );
    expect(out.message).toContain("as is");
    expect(useProposalStore.getState().proposals[0].after).toEqual({});
  });

  // Why: a picture of another animal (or of a QC flag) must not be used to correct this prediction.
  it("refuses a render of something else, unknown nodes and points off the picture", async () => {
    const [first, second] = json(await registry.call("list_predictions_to_review", {})).predictions;
    const other = renderOf(second.id);
    const mine = renderOf(first.id);
    const call = (args: Record<string, unknown>) =>
      codeOf(() =>
        registry.call("propose_correction", { prediction_id: first.id, render_id: mine.renderId, nodes: {}, reason: "r", ...args }),
      );
    expect(await call({ render_id: other.renderId })).toBe("BAD_INPUT");
    expect(await call({ nodes: { wing: [1, 1] } })).toBe("BAD_INPUT");
    expect(await call({ nodes: { tail: [500, 1] } })).toBe("BAD_INPUT");
    const flagRender = rememberRender({
      flagId: "v0:f30:i0:anomaly",
      videoIdx: 0,
      frameIdx: 30,
      instIdx: 0,
      transform: { originX: 0, originY: 0, scale: 1, offsetX: 0, offsetY: 0 },
      width: 100,
      height: 100,
    });
    expect(await call({ render_id: flagRender.renderId })).toBe("BAD_INPUT");
    expect(useProposalStore.getState().proposals).toHaveLength(0);
  });

  // Why: get_session tells Claude whether there is anything to correct.
  it("get_session counts predictions and compared models", async () => {
    loadDisagreeingModels();
    const out = json(await registry.call("get_session", {}));
    expect(out.predictions).toEqual({ instances: 5, frames: 4 });
    expect(out.compare_models.models.map((m: { name: string }) => m.name)).toEqual(["m1", "m2"]);
  });
});
