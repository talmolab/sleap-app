/**
 * Label QC flags as the Claude connector sees them: one flag per (instance,
 * check), with a stable id Claude passes back to later tools.
 *
 * Id format: `v{videoIdx}:f{frameIdx}:i{instIdx}:{kind}`, where `instIdx`
 * indexes the frame's USER instances (as QC does) or is `-` for a frame-level
 * finding, and `kind` is the rule kind (`duplicate`, `chirality`, …) or
 * `anomaly` for the statistical/GMM score. A repeat of the same kind on the
 * same instance gets a `#2`, `#3`… suffix. Flags on instances the user
 * ignored (#470) are left out, as is anything an edit has since cleared.
 */
import { useAppStore } from "@/stores/appStore";
import {
  buildQcQueue,
  hideOkFlags,
  liveQcEntry,
  qcIsOk,
  useQcStore,
} from "@/stores/qcStore";
import { qcIssueText } from "@/lib/qcReview";
import { AutomationError } from "./errors";
import type { Instance, LabeledFrame, Labels } from "@/types";

export interface QcFlag {
  id: string;
  videoIdx: number;
  frameIdx: number;
  /** Index into the frame's user instances; null for a frame-level finding. */
  instIdx: number | null;
  /** Rule kind, or "anomaly" for the statistical/GMM score. */
  kind: string;
  message: string;
  /** Anomaly/GMM score in [0,1]; null for rule findings. */
  score: number | null;
  /** Node names the flag is about (may be empty). */
  nodes: string[];
}

export interface ParsedFlagId {
  videoIdx: number;
  frameIdx: number;
  instIdx: number | null;
  kind: string;
}

const FLAG_ID = /^v(\d+):f(\d+):i(\d+|-):([a-z_]+)(?:#\d+)?$/;

export function makeFlagId(videoIdx: number, frameIdx: number, instIdx: number | null, kind: string) {
  return `v${videoIdx}:f${frameIdx}:i${instIdx ?? "-"}:${kind}`;
}

export function parseFlagId(id: string): ParsedFlagId {
  const m = FLAG_ID.exec(id);
  if (!m) {
    throw new AutomationError(
      "BAD_INPUT",
      `"${id}" is not a flag id. Flag ids look like "v0:f120:i1:anomaly"; get them from list_qc_flags.`,
    );
  }
  return {
    videoIdx: Number(m[1]),
    frameIdx: Number(m[2]),
    instIdx: m[3] === "-" ? null : Number(m[3]),
    kind: m[4],
  };
}

/** The open project, or a NO_PROJECT error. */
export function requireLabels(): Labels {
  const labels = useAppStore.getState().labels;
  if (!labels) throw new AutomationError("NO_PROJECT", "No project is open in SLEAP. Open one first.");
  return labels;
}

/** Throws unless a finished Label QC run for the open project is in the store. */
export function requireQcRun(): Labels {
  const labels = requireLabels();
  const qc = useQcStore.getState();
  if (qc.state === "running") {
    throw new AutomationError("QC_RUNNING", "Label QC is still running. Try again when it finishes.");
  }
  if (qc.state !== "done" || qc.labels !== labels) {
    throw new AutomationError(
      "NO_QC_RUN",
      "Label QC hasn't been run on this project. Ask the user to run Analyze → Label Quality Check (or the Label QC panel) first.",
    );
  }
  return labels;
}

/** Every open Label QC flag on the open project, most severe frames first. */
export function listQcFlags(): QcFlag[] {
  const labels = requireQcRun();
  const qc = useQcStore.getState();
  const gmmThreshold = qc.anomaly?.gmmThreshold ?? null;
  const queue = hideOkFlags(
    buildQcQueue(qc.findings, qc.anomaly, qc.threshold, qcIsOk(labels, qc.dismissed)),
  );
  const skeleton = useAppStore.getState().skeleton ?? labels.skeletons[0];
  const nodeNames = skeleton?.nodeNames ?? [];
  const name = (i: number) => nodeNames[i] ?? `node ${i + 1}`;

  const out: QcFlag[] = [];
  const seen = new Map<string, number>();
  const push = (flag: Omit<QcFlag, "id">) => {
    const base = makeFlagId(flag.videoIdx, flag.frameIdx, flag.instIdx, flag.kind);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.push({ id: n === 1 ? base : `${base}#${n}`, ...flag });
  };

  for (const raw of queue) {
    const e = liveQcEntry(raw, qc.rescored, qc.threshold, gmmThreshold);
    for (const { a, v } of e.anomalies) {
      if (!v.flagged) continue; // an edit since the run cleared it
      const nodeIdx =
        v.by === "gmm" ? (a.gmmNode != null && a.gmmNode >= 0 ? [a.gmmNode] : []) : a.issueNodes;
      push({
        videoIdx: e.videoIdx,
        frameIdx: e.frameIdx,
        instIdx: a.instIdx,
        kind: "anomaly",
        message: qcIssueText(a, v, nodeNames),
        score: Math.round(v.score * 1000) / 1000,
        nodes: nodeIdx.map(name),
      });
    }
    for (const r of e.rules) {
      push({
        videoIdx: e.videoIdx,
        frameIdx: e.frameIdx,
        instIdx: r.instanceIdx ?? null,
        kind: r.kind,
        message: r.message,
        score: null,
        nodes: [],
      });
    }
  }
  return out;
}

/** The open flag with this id, or UNKNOWN_FLAG. */
export function findQcFlag(id: string): QcFlag {
  parseFlagId(id); // readable error for a malformed id
  const flag = listQcFlags().find((f) => f.id === id);
  if (!flag) {
    throw new AutomationError(
      "UNKNOWN_FLAG",
      `No open flag "${id}". It may have been fixed or ignored; call list_qc_flags for the current list.`,
    );
  }
  return flag;
}

/** The labeled frame and user instance a flag points at (instance null for frame-level flags). */
export function flagTarget(
  labels: Labels,
  flag: Pick<QcFlag, "videoIdx" | "frameIdx" | "instIdx" | "id">,
): { lf: LabeledFrame; instance: Instance | null } {
  const video = labels.videos[flag.videoIdx];
  const lf = video ? labels.find({ video, frameIdx: flag.frameIdx })[0] : undefined;
  if (!lf) throw new AutomationError("UNKNOWN_FLAG", `Flag "${flag.id}" points at a frame that no longer exists.`);
  if (flag.instIdx === null) return { lf, instance: null };
  const instance = lf.userInstances[flag.instIdx];
  if (!instance) {
    throw new AutomationError("UNKNOWN_FLAG", `Flag "${flag.id}" points at an instance that no longer exists.`);
  }
  return { lf, instance };
}
