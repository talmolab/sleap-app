/**
 * Claude's proposals: a node fix or "ignore this flag" for one flagged user
 * instance (QC review), or a corrected pose for one predicted instance
 * (prediction review). Claude only proposes; nothing changes until the user
 * accepts in the Review window. Accepting a fix runs `SetNodes` — one undo
 * step labeled "Claude: <reason>" — accepting an ignore marks the instance OK
 * (#470), as key 3 would, and accepting a correction runs
 * `AcceptCorrectedPrediction`, which turns the prediction into a user instance
 * with Claude's changes (one undo step, like double-clicking it).
 *
 * A proposal remembers the instance's pose when it was made; if the pose has
 * changed since (the user edited it, or undid something), the proposal is
 * outdated and can't be accepted. A correction is outdated once its prediction
 * is gone (accepted by hand, deleted, or replaced by a new inference run).
 * Proposals live in memory only and are dropped when another project loads.
 */
import { create } from "zustand";
import { useAppStore } from "@/stores/appStore";
import { useQcStore } from "@/stores/qcStore";
import { SetNodes } from "@/commands/editCommands";
import { AcceptCorrectedPrediction } from "@/commands/proposalCommands";
import type { CommandContext } from "@/commands/CommandContext";
import { AutomationError } from "@/automation/errors";
import { qcMarkKey } from "@/lib/qcReviewed";
import { handledPredictions } from "@/lib/handledPredictions";
import type { Instance, LabeledFrame, PredictedInstance } from "@/types";

/** Node index → source-frame position, or null = not visible. */
export type NodeEdits = Record<number, [number, number] | null>;

export type ProposalStatus = "pending" | "accepted" | "rejected";

export type ProposalKind = "fix" | "ignore" | "correct";

export interface Proposal {
  id: string;
  /** The flag id (fix, ignore) or prediction id (correct) it is about. */
  flagId: string;
  kind: ProposalKind;
  videoIdx: number;
  frameIdx: number;
  /**
   * Index into the frame's user instances (fix, ignore), or into its
   * predicted instances when proposed (correct: the prediction itself is
   * found again by its pose, since accepting another one shifts the indices).
   */
  instIdx: number;
  /** The proposed nodes' positions when proposed (fix, correct). */
  before: NodeEdits;
  /** The proposed positions (fix, correct). Empty for a correction = accept the prediction as is. */
  after: NodeEdits;
  reason: string;
  /** The instance's whole pose when proposed; a change makes the proposal outdated. */
  fingerprint: string;
  status: ProposalStatus;
}

export interface ProposalTarget {
  flagId: string;
  videoIdx: number;
  frameIdx: number;
  instIdx: number;
  reason: string;
}

interface ProposalState {
  proposals: Proposal[];
  /**
   * `pose` is the pose Claude looked at (taken by render_flag). The proposal
   * is judged against it, so a node moved between the render and the
   * proposal makes the proposal outdated. Defaults to the pose now.
   */
  addFix: (target: ProposalTarget, nodes: NodeEdits, opts?: { pose?: PoseSnapshot }) => Proposal;
  addIgnore: (target: ProposalTarget) => Proposal;
  /**
   * A corrected pose for a predicted instance. `pose` is the prediction's
   * pose Claude looked at (render_prediction); the proposal follows that
   * prediction, and is outdated once no prediction on the frame has it.
   */
  addCorrection: (target: ProposalTarget, nodes: NodeEdits, opts: { pose: PoseSnapshot }) => Proposal;
  /** Apply a pending proposal. `ctx` defaults to the app's command context. */
  accept: (id: string, ctx?: CommandContext) => Promise<void>;
  reject: (id: string) => void;
  clear: () => void;
  /**
   * The Review window steps through Claude's suggestions (← / →, Prev /
   * Next) instead of Label QC flags. Off whenever the window closes.
   */
  claudeReview: boolean;
  setClaudeReview: (on: boolean) => void;
  /**
   * In that mode, the proposal stepped to (← / →). Kept here rather than
   * worked out from the selection: one instance can have several proposals
   * (a rejected one and its replacement, two QC flags), and the selection
   * can't tell them apart.
   */
  claudeShown: string | null;
  setClaudeShown: (id: string | null) => void;
}

/** Longest reason shown in the undo label. */
const UNDO_REASON_MAX = 60;

let seq = 0;

type ProposalWhere = Pick<Proposal, "videoIdx" | "frameIdx" | "instIdx"> &
  Partial<Pick<Proposal, "kind" | "fingerprint">>;

function proposalFrame(p: Pick<Proposal, "videoIdx" | "frameIdx">): LabeledFrame | null {
  const labels = useAppStore.getState().labels;
  const video = labels?.videos[p.videoIdx];
  if (!labels || !video) return null;
  return labels.find({ video, frameIdx: p.frameIdx })[0] ?? null;
}

/** The prediction on `lf` with this pose fingerprint (the one at `hint` first, when two match). */
export function findPredictionByPose(lf: LabeledFrame | null, fingerprint: string, hint = -1): PredictedInstance | null {
  if (!lf) return null;
  const preds = lf.predictedInstances;
  const at = preds[hint];
  if (at && poseFingerprint(at) === fingerprint) return at;
  return preds.find((pi) => poseFingerprint(pi) === fingerprint) ?? null;
}

/**
 * The instance a proposal is about, if it still exists: the user instance for
 * a fix or ignore; for a correction, the prediction with the pose Claude saw —
 * unless the user has labeled that animal since (a user instance was made
 * from it or overlaps it), when accepting would label it twice.
 */
export function proposalInstance(p: ProposalWhere): Instance | null {
  const lf = proposalFrame(p);
  if (p.kind === "correct") {
    const pred = findPredictionByPose(lf, p.fingerprint ?? "", p.instIdx);
    return pred && lf && !handledPredictions(lf).has(pred) ? pred : null;
  }
  return lf?.userInstances[p.instIdx] ?? null;
}

/**
 * The user instance an accepted correction made: the one whose prediction
 * (fromPredicted) has the pose Claude saw. Null if there is none (yet).
 */
export function correctionResult(p: Proposal): Instance | null {
  if (p.kind !== "correct") return null;
  const lf = proposalFrame(p);
  return (
    lf?.userInstances.find((u) => u.fromPredicted && poseFingerprint(u.fromPredicted) === p.fingerprint) ?? null
  );
}

/** An instance's pose as [x, y, visible] per node, as seen at one moment. */
export type PoseSnapshot = [number, number, boolean][];

export function poseOf(inst: Instance): PoseSnapshot {
  return inst.points.map((p) => [p.xy[0], p.xy[1], p.visible]);
}

/** An instance's whole pose as a string, to tell whether it changed. */
export function poseFingerprint(inst: Instance): string {
  return JSON.stringify(poseOf(inst));
}

/** Whether the instance changed (or went away) since the proposal was made. */
export function isOutdated(p: Proposal): boolean {
  const inst = proposalInstance(p);
  return !inst || poseFingerprint(inst) !== p.fingerprint;
}

/** Identifies what a proposal is about, so a newer one replaces a pending one. */
function targetKey(p: Proposal): string {
  // A prediction id holds an index that shifts once another prediction on the
  // frame is accepted: go by the prediction's pose instead.
  return p.kind === "correct" ? `c:${p.videoIdx}:${p.frameIdx}:${p.fingerprint}` : p.flagId;
}

/**
 * Where a proposal stands now: its status, or "outdated" (pending, but the
 * instance changed since), or "undone" (an accepted fix or correction the
 * user took back with ⌘Z, so the pose — or the prediction — is as it was when
 * proposed; it can be accepted again).
 */
export type ProposalStanding = ProposalStatus | "outdated" | "undone";

export function proposalState(p: Proposal): ProposalStanding {
  if (p.status === "pending") return isOutdated(p) ? "outdated" : "pending";
  if (p.status === "accepted" && p.kind !== "ignore" && !isOutdated(p)) return "undone";
  return p.status;
}

/** Whether the user can accept it now (pending or undone; not outdated). */
export const canAccept = (p: Proposal) => {
  const st = proposalState(p);
  return st === "pending" || st === "undone";
};

function requireInstance(t: ProposalTarget): Instance {
  const inst = proposalInstance({ ...t, kind: "fix" });
  if (!inst) {
    throw new AutomationError("UNKNOWN_FLAG", `Flag "${t.flagId}" points at an instance that no longer exists.`);
  }
  return inst;
}

function undoLabel(reason: string): string {
  const r = reason.trim().replace(/\s+/g, " ");
  return `Claude: ${r.length > UNDO_REASON_MAX ? `${r.slice(0, UNDO_REASON_MAX - 1)}…` : r}`;
}

export const useProposalStore = create<ProposalState>((set, get) => {
  /**
   * Add a proposal, replacing any for the same target the user can still
   * accept: a pending one, or an accepted one they undid. Otherwise both
   * would show (two ghosts) and both could be accepted.
   */
  const add = (p: Proposal) => {
    const superseded = (x: Proposal) =>
      targetKey(x) === targetKey(p) && (x.status === "pending" || proposalState(x) === "undone");
    set({ proposals: [...get().proposals.filter((x) => !superseded(x)), p] });
    return p;
  };
  const setStatus = (id: string, status: ProposalStatus) =>
    set({ proposals: get().proposals.map((p) => (p.id === id ? { ...p, status } : p)) });
  const find = (id: string): Proposal => {
    const p = get().proposals.find((x) => x.id === id);
    if (!p) throw new AutomationError("UNKNOWN_PROPOSAL", `No proposal "${id}".`);
    return p;
  };
  const pending = (id: string): Proposal => {
    const p = find(id);
    if (p.status !== "pending") throw new AutomationError("NOT_PENDING", `Proposal "${id}" was already ${p.status}.`);
    return p;
  };

  return {
    proposals: [],

    addFix: (t, nodes, opts) => {
      const inst = requireInstance(t);
      const pose = opts?.pose ?? poseOf(inst);
      const before: NodeEdits = {};
      for (const k of Object.keys(nodes)) {
        const p = pose[Number(k)];
        before[Number(k)] = p && p[2] && Number.isFinite(p[0]) ? [p[0], p[1]] : null;
      }
      return add({
        ...t,
        id: `p${++seq}`,
        kind: "fix",
        before,
        after: { ...nodes },
        fingerprint: JSON.stringify(pose),
        status: "pending",
      });
    },

    addCorrection: (t, nodes, opts) => {
      const pose = opts.pose;
      const before: NodeEdits = {};
      for (const k of Object.keys(nodes)) {
        const p = pose[Number(k)];
        before[Number(k)] = p && p[2] && Number.isFinite(p[0]) ? [p[0], p[1]] : null;
      }
      return add({
        ...t,
        id: `p${++seq}`,
        kind: "correct",
        before,
        after: { ...nodes },
        fingerprint: JSON.stringify(pose),
        status: "pending",
      });
    },

    addIgnore: (t) => {
      const inst = requireInstance(t);
      return add({
        ...t,
        id: `p${++seq}`,
        kind: "ignore",
        before: {},
        after: {},
        fingerprint: poseFingerprint(inst),
        status: "pending",
      });
    },

    accept: async (id, ctx) => {
      const p = find(id);
      const st = proposalState(p);
      if (st === "accepted" || st === "rejected") {
        throw new AutomationError("NOT_PENDING", `Proposal "${id}" was already ${st}.`);
      }
      if (st === "outdated") {
        throw new AutomationError(
          "OUTDATED",
          p.kind === "correct"
            ? "This prediction changed, or that animal was labeled, after Claude's suggestion, so it can't be applied. Ask Claude to look again."
            : "This instance changed after Claude's suggestion, so it can't be applied. Ask Claude to look again.",
        );
      }
      if (p.kind === "ignore") {
        const inst = proposalInstance(p)!;
        useQcStore.getState().markOk(p.videoIdx, p.frameIdx, p.instIdx);
        // markOk does nothing when the project's marks aren't loaded (no
        // project key yet): don't claim the flag was ignored.
        if (!useQcStore.getState().dismissed.has(qcMarkKey(p.videoIdx, p.frameIdx, p.instIdx, inst))) {
          throw new AutomationError(
            "IGNORE_FAILED",
            "SLEAP couldn't mark this instance OK because the project's Label QC marks aren't loaded yet. Try again in a moment.",
          );
        }
        setStatus(id, "accepted");
        return;
      }
      // Resolve the command context first: no await may fall between going to
      // the instance and running the command, or the selection could change.
      const cc = ctx ?? (await import("@/commands/CommandContext")).commandContext;
      // Re-check after the await: a second Accept, or an edit, may have landed.
      const now = get().proposals.find((x) => x.id === id);
      if (!now || !canAccept(now)) {
        throw new AutomationError(
          now && proposalState(now) === "outdated" ? "OUTDATED" : "NOT_PENDING",
          `Proposal "${id}" can't be applied any more (it was decided, or the instance changed).`,
        );
      }
      // Looked up again: an undo or redo replaces instances with copies.
      const inst = proposalInstance(now)!;
      const app = useAppStore.getState();
      const video = app.labels!.videos[p.videoIdx];
      // The undo snapshot is of the frame on screen: go there first. setVideo
      // jumps frames and setFrameIdx clears the selection, so this order matters.
      // setFrameIdx also sets the frame on screen (labeledFrame), which setVideo clears.
      if (app.video !== video) app.setVideo(video);
      useAppStore.getState().setFrameIdx(p.frameIdx);
      useAppStore.getState().setInstance(inst);
      // The instance is passed explicitly, so the command edits it whatever is selected.
      const done = cc.execute(
        p.kind === "correct" ? AcceptCorrectedPrediction : SetNodes,
        { nodes: p.after, instance: inst },
        { undoLabel: undoLabel(p.reason) },
      );
      setStatus(id, "accepted");
      await done;
    },

    reject: (id) => {
      pending(id);
      setStatus(id, "rejected");
    },

    clear: () => {
      if (get().proposals.length > 0 || get().claudeShown !== null) set({ proposals: [], claudeShown: null });
    },

    claudeReview: false,
    setClaudeReview: (on) => {
      if (get().claudeReview !== on) set(on ? { claudeReview: true } : { claudeReview: false, claudeShown: null });
    },

    claudeShown: null,
    setClaudeShown: (id) => {
      if (get().claudeShown !== id) set({ claudeShown: id });
    },
  };
});

// Claude's-suggestions mode belongs to one opening of the Review window.
useQcStore.subscribe((s, prev) => {
  if (prev.reviewOpen && !s.reviewOpen) useProposalStore.getState().setClaudeReview(false);
});

// Proposals point at instances by position in one project: drop them when
// another project loads.
useAppStore.subscribe((s, prev) => {
  if (s.labels !== prev.labels) useProposalStore.getState().clear();
});
