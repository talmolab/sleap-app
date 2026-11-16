/**
 * The Claude connector's tools (QC review prototype). Claude looks at Label QC
 * flags and proposes fixes; it can't edit or save anything itself — every
 * change waits for the user to accept it in the QC Review window.
 */
import { useAppStore } from "@/stores/appStore";
import { useQcStore } from "@/stores/qcStore";
import { isOutdated, useProposalStore, type NodeEdits, type Proposal } from "@/stores/proposalStore";
import { AutomationError } from "./errors";
import { findQcFlag, flagTarget, listQcFlags, requireLabels, type QcFlag } from "./qcFlags";
import { DEFAULT_MAX_EDGE, getRender, renderFlag } from "./render";
import { renderToFrame } from "./coords";
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
  return {
    proposal_id: p.id,
    flag_id: p.flagId,
    kind: p.kind,
    status: p.status,
    outdated: p.status === "pending" ? isOutdated(p) : undefined,
    video: p.videoIdx,
    frame: p.frameIdx,
    instance: p.instIdx,
    reason: p.reason,
    before: p.kind === "fix" ? byName(p.before) : undefined,
    after: p.kind === "fix" ? byName(p.after) : undefined,
  };
}

function proposalNodeNames(p: Proposal): string[] {
  const labels = useAppStore.getState().labels;
  const lf = labels?.find({ video: labels.videos[p.videoIdx], frameIdx: p.frameIdx })[0];
  return lf?.userInstances[p.instIdx]?.skeleton.nodeNames ?? labels?.skeletons[0]?.nodeNames ?? [];
}

export const getSession: Tool = {
  name: "get_session",
  description:
    "What is open in SLEAP: the project, its videos, the skeleton's nodes and edges, the frame on screen, whether Label QC has been run (and how many flags are open), and how many proposals are pending. Call this first.",
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
        proposal: latest.get(f.id)?.status ?? null,
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
      render.instIdx !== flag.instIdx
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

export const listProposalsTool: Tool = {
  name: "list_proposals",
  description:
    "Claude's proposals in this session and what the user did with each: pending, accepted or rejected. A pending proposal is 'outdated' when the instance changed after it was made; it can't be accepted, so look at the flag again. Fix positions are in frame coordinates, by node name.",
  inputSchema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["pending", "accepted", "rejected"], description: "Only proposals with this status." },
    },
    additionalProperties: false,
  },
  annotations: { title: "List proposals", readOnlyHint: true, openWorldHint: false },
  async handler(args) {
    const status = args.status as string | undefined;
    const proposals = useProposalStore
      .getState()
      .proposals.filter((p) => !status || p.status === status)
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
  listProposalsTool,
];

/** The app's tool registry (window.sleap.automation and the MCP server use this). */
export const registry = new ToolRegistry(TOOLS);
