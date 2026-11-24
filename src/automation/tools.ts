/**
 * The Claude connector's tools. QC review: Claude looks at Label QC flags and
 * proposes fixes. Prediction review: Claude looks at predictions the model
 * was unsure of (or that Compare Models' models disagree on) and proposes
 * corrected poses. Claude can't edit or save anything itself — every change
 * waits for the user to accept it (QC fixes in Label QC Review, corrections
 * in Compare Models' Review disagreements window).
 */
import { useAppStore } from "@/stores/appStore";
import { useQcStore } from "@/stores/qcStore";
import { useModelOverlayStore } from "@/stores/modelOverlayStore";
import {
  correctionResult,
  isOutdated,
  poseFingerprint,
  proposalInstance,
  proposalState,
  useProposalStore,
  type NodeEdits,
  type Proposal,
} from "@/stores/proposalStore";
import { AutomationError } from "./errors";
import { findQcFlag, flagTarget, listQcFlags, requireLabels, type QcFlag } from "./qcFlags";
import { DEFAULT_MAX_EDGE, getRender, renderFlag, renderPrediction, type RenderRecord } from "./render";
import { frameToRender, renderToFrame } from "./coords";
import {
  cachedCandidates,
  comparedModels,
  DEFAULT_MAX_INSTANCE_SCORE,
  DEFAULT_MAX_NODE_SCORE,
  DEFAULT_SCAN_BUDGET_MS,
  findPrediction,
  parsePredictionId,
  predictionDisagreement,
  scanDisagreements,
  type CandidateOrder,
} from "./predictions";
import { textResult, ToolRegistry, type Tool } from "./registry";

const FLAG_ID = { type: "string", description: 'A flag id from list_qc_flags, e.g. "v0:f120:i1:anomaly".' };
const REASON = {
  type: "string",
  minLength: 1,
  maxLength: 500,
  description: "One short sentence the user will read, saying what is wrong and why this is right.",
};

/** Base64 of bytes, in chunks (String.fromCharCode can't take a huge array). */
export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/** The latest proposal for each flag. */
function latestProposals(): Map<string, Proposal> {
  const m = new Map<string, Proposal>();
  for (const p of useProposalStore.getState().proposals) m.set(p.flagId, p);
  return m;
}

const latestState = (p: Proposal | undefined) => (p ? proposalState(p) : null);

/** A flag the proposal tools can act on: one user instance, still open. */
function instanceFlag(flagId: string): QcFlag & { instIdx: number } {
  const flag = findQcFlag(flagId);
  if (flag.instIdx === null) {
    throw new AutomationError(
      "BAD_INPUT",
      `Flag "${flagId}" is about the whole frame, not one instance, so there is nothing to fix or ignore here. Leave it for the user.`,
    );
  }
  return flag as QcFlag & { instIdx: number };
}

function describeProposal(p: Proposal) {
  const names = proposalNodeNames(p);
  const byName = (edits: NodeEdits) =>
    Object.fromEntries(
      Object.entries(edits).map(([k, v]) => [
        names[Number(k)] ?? `node ${Number(k) + 1}`,
        v && [Math.round(v[0] * 100) / 100, Math.round(v[1] * 100) / 100],
      ]),
    );
  const correct = p.kind === "correct";
  return {
    proposal_id: p.id,
    flag_id: correct ? undefined : p.flagId,
    prediction_id: correct ? p.flagId : undefined,
    kind: p.kind,
    status: proposalState(p),
    video: p.videoIdx,
    frame: p.frameIdx,
    // A correction's prediction index is as it was when proposed.
    instance: correct ? undefined : p.instIdx,
    prediction: correct ? p.instIdx : undefined,
    reason: p.reason,
    before: p.kind !== "ignore" ? byName(p.before) : undefined,
    after: p.kind !== "ignore" ? byName(p.after) : undefined,
  };
}

function proposalNodeNames(p: Proposal): string[] {
  const labels = useAppStore.getState().labels;
  const inst = proposalInstance(p) ?? correctionResult(p);
  return inst?.skeleton.nodeNames ?? labels?.skeletons[0]?.nodeNames ?? [];
}

/** The latest correction proposal for each prediction, keyed by frame and pose. */
function latestCorrections(): Map<string, Proposal> {
  const m = new Map<string, Proposal>();
  for (const p of useProposalStore.getState().proposals) {
    if (p.kind === "correct") m.set(`${p.videoIdx}:${p.frameIdx}:${p.fingerprint}`, p);
  }
  return m;
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const round3 = (v: number) => Math.round(v * 1000) / 1000;

export const getSession: Tool = {
  name: "get_session",
  description:
    "What is open in SLEAP: the project, its videos, the skeleton's nodes and edges, the frame on screen, whether Label QC has been run (and how many flags are open), how many predicted instances the project has, which models are loaded in Compare Model Predictions, and how many proposals are pending. Call this first.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { title: "Get SLEAP session", readOnlyHint: true, openWorldHint: false },
  async handler() {
    const app = useAppStore.getState();
    const labels = app.labels;
    if (!labels) return textResult({ project: null, message: "No project is open in SLEAP." });
    const qc = useQcStore.getState();
    const qcState = qc.labels === labels ? qc.state : "idle";
    let openFlags: number | null = null;
    if (qcState === "done") openFlags = listQcFlags().length;
    const skeleton = app.skeleton ?? labels.skeletons[0];
    const proposals = useProposalStore.getState().proposals;
    let predicted = 0;
    let predictedFrames = 0;
    for (const lf of labels.labeledFrames) {
      const n = lf.predictedInstances.length;
      predicted += n;
      if (n > 0) predictedFrames++;
    }
    const overlay = useModelOverlayStore.getState();
    const compared = overlay.labels === labels ? overlay.models.filter((m) => m.visible) : [];
    return textResult({
      project: app.filename ?? app.projectPath ?? "(unsaved)",
      videos: labels.videos.map((v, i) => ({
        video: i,
        file: v.filename,
        frames: v.shape?.[0] ?? null,
        height: v.shape?.[1] ?? null,
        width: v.shape?.[2] ?? null,
      })),
      skeleton: skeleton
        ? {
            nodes: skeleton.nodeNames,
            edges: skeleton.edgeIndices.map(([a, b]) => [skeleton.nodeNames[a], skeleton.nodeNames[b]]),
          }
        : null,
      on_screen: { video: app.video ? labels.videos.indexOf(app.video) : null, frame: app.frameIdx },
      label_qc: {
        state: qcState === "done" ? "done" : qcState === "running" ? "running" : "not run",
        open_flags: openFlags,
      },
      predictions: { instances: predicted, frames: predictedFrames },
      compare_models:
        compared.length > 0
          ? {
              models: compared.map((m) => ({ name: m.name, video: labels.videos.indexOf(m.video) })),
              disagreement_threshold_px: overlay.threshold,
            }
          : null,
      proposals: {
        pending: proposals.filter((p) => p.status === "pending").length,
        accepted: proposals.filter((p) => p.status === "accepted").length,
        rejected: proposals.filter((p) => p.status === "rejected").length,
      },
    });
  },
};

export const listQcFlagsTool: Tool = {
  name: "list_qc_flags",
  description:
    "The open Label QC flags, most severe first. Each flag is one problem on one user instance (or, with instance null, on a whole frame): a rule finding (duplicate, out_of_range, chirality, …) or a statistical 'anomaly' with a score in [0,1] and the nodes it is about. Flags the user ignored are left out. Each has a stable id to pass to render_flag and the propose_ tools, and the status of Claude's latest proposal for it, if any. Errors if Label QC hasn't been run: then ask the user to run Analyze → Label Quality Check.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 500, description: "Most flags to return (default 50)." },
      offset: { type: "integer", minimum: 0, description: "Skip this many flags first (default 0)." },
    },
    additionalProperties: false,
  },
  annotations: { title: "List Label QC flags", readOnlyHint: true, openWorldHint: false },
  async handler(args) {
    const all = listQcFlags();
    const offset = (args.offset as number | undefined) ?? 0;
    const limit = (args.limit as number | undefined) ?? 50;
    const latest = latestProposals();
    return textResult({
      total: all.length,
      offset,
      flags: all.slice(offset, offset + limit).map((f) => ({
        id: f.id,
        video: f.videoIdx,
        frame: f.frameIdx,
        instance: f.instIdx,
        kind: f.kind,
        message: f.message,
        score: f.score,
        nodes: f.nodes,
        proposal: latestState(latest.get(f.id)),
      })),
    });
  },
};

export const renderFlagTool: Tool = {
  name: "render_flag",
  description:
    "A picture of a flagged instance: the video frame cropped around it and enlarged, every pose drawn with node names, the flagged instance at full strength and others dimmed. Also returns a render_id and the flagged instance's node positions IN THIS PICTURE'S PIXELS (origin top-left, x right, y down; null = not placed). Always call this before propose_fix and give propose_fix positions in the picture's pixels with this render_id. The user's view doesn't move.",
  inputSchema: {
    type: "object",
    properties: {
      flag_id: FLAG_ID,
      max_edge: {
        type: "integer",
        minimum: 256,
        maximum: 1568,
        description: `Longest side of the picture in pixels (default ${DEFAULT_MAX_EDGE}).`,
      },
    },
    required: ["flag_id"],
    additionalProperties: false,
  },
  annotations: { title: "Render a flagged instance", readOnlyHint: true, openWorldHint: false },
  async handler(args) {
    const r = await renderFlag(args.flag_id as string, { maxEdge: args.max_edge as number | undefined });
    const flag = findQcFlag(r.flagId);
    return {
      content: [
        { type: "image", data: bytesToBase64(r.png), mimeType: "image/png" },
        {
          type: "text",
          text: JSON.stringify(
            {
              render_id: r.renderId,
              flag: { id: flag.id, kind: flag.kind, message: flag.message, nodes: flag.nodes },
              width: r.width,
              height: r.height,
              scale: Math.round(r.transform.scale * 1000) / 1000,
              nodes: r.nodes,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};

export const proposeFixTool: Tool = {
  name: "propose_fix",
  description:
    "Propose moving or hiding nodes of a flagged instance. Positions are pixels in the picture render_flag returned for this flag (pass its render_id); the app converts them to frame coordinates. Map node names to [x, y], or to null to mark the node not visible (occluded or out of view). Only list nodes you want to change. Nothing changes until the user accepts the proposal in SLEAP's QC Review window — never tell the user a fix is applied. A new proposal for the same flag replaces a pending one.",
  inputSchema: {
    type: "object",
    properties: {
      flag_id: FLAG_ID,
      render_id: { type: "string", description: "The render_id from render_flag for this flag." },
      nodes: {
        type: "object",
        description: 'Node name → [x, y] in the picture\'s pixels, or null for "not visible". E.g. {"nose": [412, 233]}.',
        additionalProperties: { type: ["array", "null"], items: { type: "number" }, minItems: 2, maxItems: 2 },
      },
      reason: REASON,
    },
    required: ["flag_id", "render_id", "nodes", "reason"],
    additionalProperties: false,
  },
  annotations: {
    title: "Propose a node fix",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  async handler(args) {
    const labels = requireLabels();
    const flag = instanceFlag(args.flag_id as string);
    const render = getRender(args.render_id as string);
    if (
      render.videoIdx !== flag.videoIdx ||
      render.frameIdx !== flag.frameIdx ||
      render.instIdx !== flag.instIdx ||
      // A prediction's render has the same fields; its index counts predictions.
      /:p\d+:/.test(render.flagId)
    ) {
      throw new AutomationError(
        "BAD_INPUT",
        `render_id "${render.renderId}" is a picture of flag "${render.flagId}", not "${flag.id}". Call render_flag for this flag.`,
      );
    }
    const { instance } = flagTarget(labels, flag);
    const names = instance!.skeleton.nodeNames;
    const raw = args.nodes as Record<string, [number, number] | null>;
    if (Object.keys(raw).length === 0) throw new AutomationError("BAD_INPUT", "nodes is empty: list at least one node to change.");
    const edits: NodeEdits = {};
    for (const [name, v] of Object.entries(raw)) {
      const idx = names.indexOf(name);
      if (idx < 0) {
        throw new AutomationError("BAD_INPUT", `Unknown node "${name}". This skeleton's nodes: ${names.join(", ")}.`);
      }
      if (v === null) {
        edits[idx] = null;
        continue;
      }
      const [x, y] = v;
      if (x < 0 || y < 0 || x > render.width || y > render.height) {
        throw new AutomationError(
          "BAD_INPUT",
          `"${name}" at [${x}, ${y}] is outside the picture (${render.width}×${render.height}). Positions are pixels in the render_flag picture.`,
        );
      }
      edits[idx] = renderToFrame(render.transform, x, y);
    }
    const p = useProposalStore.getState().addFix(
      { flagId: flag.id, videoIdx: flag.videoIdx, frameIdx: flag.frameIdx, instIdx: flag.instIdx, reason: args.reason as string },
      edits,
      { pose: render.pose },
    );
    if (isOutdated(p)) {
      return textResult({
        proposal_id: p.id,
        status: "outdated",
        message:
          "The pose changed after your render_flag, so this proposal can't be accepted. Call render_flag again and propose from the new picture.",
      });
    }
    return textResult({
      proposal_id: p.id,
      status: "pending",
      message: "Proposed. The user sees it in the QC Review window; it is not applied until they accept it.",
    });
  },
};

export const proposeIgnoreTool: Tool = {
  name: "propose_ignore",
  description:
    "Propose ignoring a flag because the pose is actually right (a false alarm, e.g. an unusual but real posture). If the user accepts, the instance is marked OK and its flags stop showing — the same as pressing 3 in the Review window. Nothing changes until the user accepts.",
  inputSchema: {
    type: "object",
    properties: { flag_id: FLAG_ID, reason: REASON },
    required: ["flag_id", "reason"],
    additionalProperties: false,
  },
  annotations: {
    title: "Propose ignoring a flag",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  async handler(args) {
    const flag = instanceFlag(args.flag_id as string);
    const p = useProposalStore.getState().addIgnore({
      flagId: flag.id,
      videoIdx: flag.videoIdx,
      frameIdx: flag.frameIdx,
      instIdx: flag.instIdx,
      reason: args.reason as string,
    });
    return textResult({
      proposal_id: p.id,
      status: "pending",
      message: "Proposed. The user sees it in the QC Review window; nothing changes until they accept it.",
    });
  },
};

const PREDICTION_ID = {
  type: "string",
  description: 'A prediction id from list_predictions_to_review, e.g. "v0:f120:p1:3fa2c1".',
};

export const listPredictionsTool: Tool = {
  name: "list_predictions_to_review",
  description:
    "Predicted instances (the model's poses) worth a second look, least confident first: those whose instance score or some node's score is below a threshold, and — when two or more models are shown in Compare Model Predictions — those whose nodes the models place far apart. Predictions the user already turned into user instances, or that overlap a user instance, are left out. Each has an id to pass to render_prediction and propose_correction, why it is listed, and the status of Claude's latest correction for it, if any. score_summary gives the spread of scores in the project, to pick thresholds by. On a long video the model-disagreement check runs a few seconds per call and continues on the next call (compare_models.disagreement_scan says how far it got). Errors if the project has no predictions.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 500, description: "Most predictions to return (default 50)." },
      offset: { type: "integer", minimum: 0, description: "Skip this many first (default 0)." },
      order: {
        type: "string",
        enum: ["score", "disagreement", "frame"],
        description: '"score" (default): least confident first; "disagreement": widest model disagreement first; "frame": in frame order.',
      },
      max_instance_score: {
        type: "number",
        minimum: 0,
        description: `List predictions whose instance score is below this (default ${DEFAULT_MAX_INSTANCE_SCORE}).`,
      },
      max_node_score: {
        type: "number",
        minimum: 0,
        description: `List predictions with a node scored below this (default ${DEFAULT_MAX_NODE_SCORE}).`,
      },
      include_disagreement: {
        type: "boolean",
        description: "Also list predictions the Compare Models models disagree on (default true; needs two or more models shown).",
      },
      video: { type: "integer", minimum: 0, description: "Only this video (index from get_session)." },
    },
    additionalProperties: false,
  },
  annotations: { title: "List predictions to review", readOnlyHint: true, openWorldHint: false },
  async handler(args) {
    const labels = requireLabels();
    if (!labels.labeledFrames.some((lf) => lf.predictedInstances.length > 0)) {
      throw new AutomationError(
        "NO_PREDICTIONS",
        "This project has no predicted instances. Ask the user to run inference (Predict → Run Inference) or open a project with predictions.",
      );
    }
    const maxInstanceScore = (args.max_instance_score as number | undefined) ?? DEFAULT_MAX_INSTANCE_SCORE;
    const maxNodeScore = (args.max_node_score as number | undefined) ?? DEFAULT_MAX_NODE_SCORE;
    const videoIdx = args.video as number | undefined;
    const withDisagreement = args.include_disagreement !== false;
    const videos = labels.videos.filter((v, i) => (videoIdx === undefined || videoIdx === i) && comparedModels(v).length >= 2);
    // Check more frames for model disagreement, a few seconds at most, without freezing the app.
    const scans = [];
    for (const v of withDisagreement ? videos : []) {
      scans.push(await scanDisagreements(v, DEFAULT_SCAN_BUDGET_MS / videos.length));
    }
    const scanned = scans.reduce((a, p) => a + p.checked, 0);
    const toScan = scans.reduce((a, p) => a + p.total, 0);
    const scanComplete = scans.every((p) => p.complete);
    const { list, sorted } = cachedCandidates(
      { maxInstanceScore, maxNodeScore, disagreement: withDisagreement, videoIdx },
      (args.order as CandidateOrder | undefined) ?? "score",
    );
    const offset = (args.offset as number | undefined) ?? 0;
    const limit = (args.limit as number | undefined) ?? 50;
    const latest = latestCorrections();
    const comparing = labels.videos.flatMap((v) => comparedModels(v));
    return textResult({
      total: sorted.length,
      offset,
      reviewed_predictions: list.reviewed,
      thresholds: {
        instance_score: maxInstanceScore,
        node_score: maxNodeScore,
        disagreement_px: comparing.length >= 2 && args.include_disagreement !== false ? useModelOverlayStore.getState().threshold : null,
      },
      compare_models:
        comparing.length >= 2
          ? {
              models: [...new Set(comparing.map((m) => m.name))],
              unmatched_disagreements: list.unmatchedDisagreements,
              disagreement_scan: withDisagreement
                ? {
                    frames_checked: scanned,
                    frames_to_check: toScan,
                    complete: scanComplete,
                    note: scanComplete
                      ? undefined
                      : "Only part of the video has been checked for model disagreement so far; call again to check more. Low-score results are complete.",
                  }
                : undefined,
            }
          : null,
      score_summary: list.scoreSummary,
      predictions: sorted.slice(offset, offset + limit).map((c) => {
        const names = c.instance.skeleton.nodeNames;
        const name = (i: number) => names[i] ?? `node ${i + 1}`;
        const p = latest.get(`${c.videoIdx}:${c.frameIdx}:${poseFingerprint(c.instance)}`);
        return {
          id: c.id,
          video: c.videoIdx,
          frame: c.frameIdx,
          track: c.track,
          instance_score: c.instanceScore === null ? null : round3(c.instanceScore),
          low_instance_score: c.lowInstance,
          low_nodes: c.lowNodes.map((n) => ({ node: name(n.node), score: round3(n.score) })),
          unplaced_nodes: c.unplaced.map(name),
          disagreement: c.disagreement
            ? {
                models: c.disagreement.models.length,
                nodes: c.disagreement.nodes.map((n) => ({ node: name(n.node), spread_px: round1(n.spreadPx) })),
              }
            : null,
          proposal: p ? proposalState(p) : null,
        };
      }),
    });
  },
};

export const renderPredictionTool: Tool = {
  name: "render_prediction",
  description:
    "A picture of one predicted instance: the video frame cropped around it and enlarged, every pose drawn, this prediction at full strength with node names and the others dimmed. Also returns a render_id, the prediction's node positions IN THIS PICTURE'S PIXELS (origin top-left, x right, y down; null = not placed) with the model's score for each node, and — when the Compare Models models disagree on this animal — where each model put each node, in the same pixels. Always call this before propose_correction and give propose_correction positions in the picture's pixels with this render_id. The user's view doesn't move.",
  inputSchema: {
    type: "object",
    properties: {
      prediction_id: PREDICTION_ID,
      max_edge: {
        type: "integer",
        minimum: 256,
        maximum: 1568,
        description: `Longest side of the picture in pixels (default ${DEFAULT_MAX_EDGE}).`,
      },
    },
    required: ["prediction_id"],
    additionalProperties: false,
  },
  annotations: { title: "Render a prediction", readOnlyHint: true, openWorldHint: false },
  async handler(args) {
    const r = await renderPrediction(args.prediction_id as string, { maxEdge: args.max_edge as number | undefined });
    const inst = r.target.instance;
    const names = inst.skeleton.nodeNames;
    const dis = predictionDisagreement(r.target.lf, inst);
    const inPicture = (xy: Float64Array, i: number) => {
      const x = xy[2 * i];
      const y = xy[2 * i + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      const [rx, ry] = frameToRender(r.transform, x, y);
      return [round1(rx), round1(ry)];
    };
    return {
      content: [
        { type: "image", data: bytesToBase64(r.png), mimeType: "image/png" },
        {
          type: "text",
          text: JSON.stringify(
            {
              render_id: r.renderId,
              prediction: {
                id: r.target.id,
                video: r.target.videoIdx,
                frame: r.target.frameIdx,
                track: inst.track?.name ?? null,
                instance_score: Number.isFinite(inst.score) ? round3(inst.score) : null,
              },
              width: r.width,
              height: r.height,
              scale: round3(r.transform.scale),
              nodes: r.nodes,
              models: dis
                ? dis.models.map((m) => ({
                    model: m.model,
                    nodes: Object.fromEntries(names.map((n, i) => [n, inPicture(m.xy, i)])),
                  }))
                : undefined,
              models_disagree_on: dis
                ? dis.nodes.map((n) => ({ node: names[n.node] ?? `node ${n.node + 1}`, spread_px: round1(n.spreadPx) }))
                : undefined,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};

/** The render a correction is proposed from must be of this prediction. */
function predictionRender(renderId: string, predictionId: string): RenderRecord {
  const render = getRender(renderId);
  const want = parsePredictionId(predictionId);
  let same = false;
  try {
    const got = parsePredictionId(render.flagId);
    same = got.videoIdx === want.videoIdx && got.frameIdx === want.frameIdx && got.hash === want.hash;
  } catch {
    same = false;
  }
  if (!same || !render.pose) {
    throw new AutomationError(
      "BAD_INPUT",
      `render_id "${render.renderId}" is a picture of "${render.flagId}", not prediction "${predictionId}". Call render_prediction for this prediction.`,
    );
  }
  return render;
}

export const proposeCorrectionTool: Tool = {
  name: "propose_correction",
  description:
    "Propose a corrected pose for a prediction: if the user accepts, the prediction becomes a user instance with your changes (one undo step). Positions are pixels in the picture render_prediction returned for this prediction (pass its render_id); the app converts them to frame coordinates. Map node names to [x, y], or to null to mark a node not visible (occluded or out of view). Only list nodes you want to change; the rest keep the model's positions. An empty nodes object proposes accepting the prediction as it is (it is right). Nothing changes until the user accepts it in SLEAP's Review disagreements window — never tell the user a correction is applied. A new proposal for the same prediction replaces a pending one.",
  inputSchema: {
    type: "object",
    properties: {
      prediction_id: PREDICTION_ID,
      render_id: { type: "string", description: "The render_id from render_prediction for this prediction." },
      nodes: {
        type: "object",
        description:
          'Node name → [x, y] in the picture\'s pixels, or null for "not visible". E.g. {"nose": [412, 233]}. {} = accept the prediction as is.',
        additionalProperties: { type: ["array", "null"], items: { type: "number" }, minItems: 2, maxItems: 2 },
      },
      reason: REASON,
    },
    required: ["prediction_id", "render_id", "nodes", "reason"],
    additionalProperties: false,
  },
  annotations: {
    title: "Propose a corrected prediction",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  async handler(args) {
    const labels = requireLabels();
    const predictionId = args.prediction_id as string;
    const render = predictionRender(args.render_id as string, predictionId);
    const target = findPrediction(labels, predictionId);
    const names = target.instance.skeleton.nodeNames;
    const raw = args.nodes as Record<string, [number, number] | null>;
    const edits: NodeEdits = {};
    for (const [name, v] of Object.entries(raw)) {
      const idx = names.indexOf(name);
      if (idx < 0) {
        throw new AutomationError("BAD_INPUT", `Unknown node "${name}". This skeleton's nodes: ${names.join(", ")}.`);
      }
      if (v === null) {
        edits[idx] = null;
        continue;
      }
      const [x, y] = v;
      if (x < 0 || y < 0 || x > render.width || y > render.height) {
        throw new AutomationError(
          "BAD_INPUT",
          `"${name}" at [${x}, ${y}] is outside the picture (${render.width}×${render.height}). Positions are pixels in the render_prediction picture.`,
        );
      }
      edits[idx] = renderToFrame(render.transform, x, y);
    }
    const p = useProposalStore.getState().addCorrection(
      {
        flagId: target.id,
        videoIdx: target.videoIdx,
        frameIdx: target.frameIdx,
        instIdx: target.predIdx,
        reason: args.reason as string,
      },
      edits,
      { pose: render.pose! },
    );
    if (isOutdated(p)) {
      return textResult({
        proposal_id: p.id,
        status: "outdated",
        message:
          "The prediction changed after your render_prediction, or the user has labeled that animal, so this proposal can't be accepted. Call list_predictions_to_review again for the current list.",
      });
    }
    return textResult({
      proposal_id: p.id,
      prediction_id: target.id,
      status: "pending",
      message:
        Object.keys(edits).length === 0
          ? "Proposed accepting the prediction as is. The user sees it in SLEAP's Review disagreements window; nothing changes until they accept it."
          : "Proposed. The user sees it in SLEAP's Review disagreements window; it is not applied until they accept it.",
    });
  },
};

export const listProposalsTool: Tool = {
  name: "list_proposals",
  description:
    "Claude's proposals in this session and where each stands: pending; accepted; rejected; 'outdated' (the instance changed after it was made — or, for a correction, the prediction is gone or changed, or the user labeled that animal — so it can't be accepted: look again); or 'undone' (accepted, then the user undid it). kind is fix or ignore (QC flags) or correct (predictions). Fix and correction positions are in frame coordinates, by node name.",
  inputSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["pending", "accepted", "rejected", "outdated", "undone"],
        description: "Only proposals in this state.",
      },
    },
    additionalProperties: false,
  },
  annotations: { title: "List proposals", readOnlyHint: true, openWorldHint: false },
  async handler(args) {
    const status = args.status as string | undefined;
    const proposals = useProposalStore
      .getState()
      .proposals.filter((p) => !status || proposalState(p) === status)
      .map(describeProposal);
    return textResult({ proposals });
  },
};

export const TOOLS: Tool[] = [
  getSession,
  listQcFlagsTool,
  renderFlagTool,
  proposeFixTool,
  proposeIgnoreTool,
  listPredictionsTool,
  renderPredictionTool,
  proposeCorrectionTool,
  listProposalsTool,
];

/** The app's tool registry (window.sleap.automation and the MCP server use this). */
export const registry = new ToolRegistry(TOOLS);
