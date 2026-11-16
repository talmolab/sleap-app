/**
 * Claude's proposals (QC review): a node fix or "ignore this flag" for one
 * flagged user instance. Claude only proposes; nothing changes until the user
 * accepts in the Review window. Accepting a fix runs `SetNodes` — one undo
 * step labeled "Claude: <reason>" — and accepting an ignore marks the
 * instance OK (#470), as key 3 would.
 *
 * A proposal remembers the instance's pose when it was made; if the pose has
 * changed since (the user edited it, or undid something), the proposal is
 * outdated and can't be accepted. Proposals live in memory only and are
 * dropped when another project loads.
 */
import { create } from "zustand";
import { useAppStore } from "@/stores/appStore";
import { useQcStore } from "@/stores/qcStore";
import { SetNodes } from "@/commands/editCommands";
import type { CommandContext } from "@/commands/CommandContext";
import { AutomationError } from "@/automation/errors";
import type { Instance } from "@/types";

/** Node index → source-frame position, or null = not visible. */
export type NodeEdits = Record<number, [number, number] | null>;

export type ProposalStatus = "pending" | "accepted" | "rejected";

export interface Proposal {
  id: string;
  flagId: string;
  kind: "fix" | "ignore";
  videoIdx: number;
  frameIdx: number;
  /** Index into the frame's user instances. */
  instIdx: number;
  /** The proposed nodes' positions when proposed (fix only). */
  before: NodeEdits;
  /** The proposed positions (fix only). */
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
  addFix: (target: ProposalTarget, nodes: NodeEdits) => Proposal;
  addIgnore: (target: ProposalTarget) => Proposal;
  /** Apply a pending proposal. `ctx` defaults to the app's command context. */
  accept: (id: string, ctx?: CommandContext) => Promise<void>;
  reject: (id: string) => void;
  clear: () => void;
}

/** Longest reason shown in the undo label. */
const UNDO_REASON_MAX = 60;

let seq = 0;

/** The user instance a proposal is about, if it still exists. */
export function proposalInstance(p: Pick<Proposal, "videoIdx" | "frameIdx" | "instIdx">): Instance | null {
  const labels = useAppStore.getState().labels;
  const video = labels?.videos[p.videoIdx];
  if (!labels || !video) return null;
  const lf = labels.find({ video, frameIdx: p.frameIdx })[0];
  return lf?.userInstances[p.instIdx] ?? null;
}

/** An instance's whole pose as a string, to tell whether it changed. */
export function poseFingerprint(inst: Instance): string {
  return JSON.stringify(inst.points.map((p) => [p.xy[0], p.xy[1], p.visible]));
}

/** Whether the instance changed (or went away) since the proposal was made. */
export function isOutdated(p: Proposal): boolean {
  const inst = proposalInstance(p);
  return !inst || poseFingerprint(inst) !== p.fingerprint;
}

function requireInstance(t: ProposalTarget): Instance {
  const inst = proposalInstance(t);
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
  /** Add a proposal, replacing any still-pending one for the same flag. */
  const add = (p: Proposal) => {
    set({
      proposals: [
        ...get().proposals.filter((x) => !(x.flagId === p.flagId && x.status === "pending")),
        p,
      ],
    });
    return p;
  };
  const setStatus = (id: string, status: ProposalStatus) =>
    set({ proposals: get().proposals.map((p) => (p.id === id ? { ...p, status } : p)) });
  const pending = (id: string): Proposal => {
    const p = get().proposals.find((x) => x.id === id);
    if (!p) throw new AutomationError("UNKNOWN_PROPOSAL", `No proposal "${id}".`);
    if (p.status !== "pending") throw new AutomationError("NOT_PENDING", `Proposal "${id}" was already ${p.status}.`);
    return p;
  };

  return {
    proposals: [],

    addFix: (t, nodes) => {
      const inst = requireInstance(t);
      const before: NodeEdits = {};
      for (const k of Object.keys(nodes)) {
        const p = inst.points[Number(k)];
        before[Number(k)] = p && p.visible && Number.isFinite(p.xy[0]) ? [p.xy[0], p.xy[1]] : null;
      }
      return add({
        ...t,
        id: `p${++seq}`,
        kind: "fix",
        before,
        after: { ...nodes },
        fingerprint: poseFingerprint(inst),
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
      const p = pending(id);
      if (isOutdated(p)) {
        throw new AutomationError(
          "OUTDATED",
          "This instance changed after Claude's suggestion, so it can't be applied. Ask Claude to look again.",
        );
      }
      if (p.kind === "ignore") {
        useQcStore.getState().markOk(p.videoIdx, p.frameIdx, p.instIdx);
        setStatus(id, "accepted");
        return;
      }
      const inst = proposalInstance(p)!;
      const app = useAppStore.getState();
      const video = app.labels!.videos[p.videoIdx];
      // Commands act on the selection: go there first. setVideo jumps frames,
      // and setFrameIdx clears the selection, so this order matters.
      if (app.video !== video) app.setVideo(video);
      if (useAppStore.getState().frameIdx !== p.frameIdx) useAppStore.getState().setFrameIdx(p.frameIdx);
      useAppStore.getState().setInstance(inst);
      const cc = ctx ?? (await import("@/commands/CommandContext")).commandContext;
      await cc.execute(SetNodes, { nodes: p.after }, { undoLabel: undoLabel(p.reason) });
      setStatus(id, "accepted");
    },

    reject: (id) => {
      pending(id);
      setStatus(id, "rejected");
    },

    clear: () => {
      if (get().proposals.length > 0) set({ proposals: [] });
    },
  };
});

// Proposals point at instances by position in one project: drop them when
// another project loads.
useAppStore.subscribe((s, prev) => {
  if (s.labels !== prev.labels) useProposalStore.getState().clear();
});
