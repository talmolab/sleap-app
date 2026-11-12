/**
 * Label QC results, shared by the Label Quality Check dialog and the Label QC
 * side panel so a run started in either shows up in both.
 *
 * One run does both analyses: the rule checks (labelQc.ts, instant) and then
 * the statistical anomaly + GMM scores (qc/anomaly.ts, chunked-async with
 * progress and cancel). Results belong to the `Labels` they were computed
 * from and are dropped when a different project loads.
 */
import { create } from "zustand";
import type { Labels } from "@/types";
import { runLabelQc, SOFT_QC_KINDS, type QcFinding } from "@/lib/analyze/labelQc";
import {
  anomalyVerdict,
  scoreLabelsAnomalyAsync,
  type AnomalyInstance,
  type AnomalyResult,
  type AnomalyVerdict,
} from "@/lib/analyze/qc/anomaly";
import { yieldToEvent } from "@/lib/analyze/qc/detector";
import { makeQCConfig } from "@/lib/analyze/qc/config";
import { useAppStore } from "@/stores/appStore";
import { dirtyFrameTracker } from "@/lib/autosaveDirty";
import { toast } from "@/lib/notify";

export type QcRunState = "idle" | "running" | "done";

/** Default anomaly flag threshold on the [0,1] score (PyQt's 0.7). */
export const QC_ANOMALY_THRESHOLD = makeQCConfig().instanceThreshold;

/** One flagged frame: everything QC found on it. */
export interface QcQueueEntry {
  videoIdx: number;
  frameIdx: number;
  /** Rule findings on this frame, definite errors first. */
  rules: QcFinding[];
  /** Whether any rule finding is a definite error (not in SOFT_QC_KINDS). */
  definite: boolean;
  /** Flagged instances on this frame, worst first. */
  anomalies: { a: AnomalyInstance; v: AnomalyVerdict }[];
  /** Worst statistical score on the frame (0 when only rules fired). */
  worst: number;
}

interface QcState {
  /** The labels the current results were computed from. */
  labels: Labels | null;
  state: QcRunState;
  progress: number;
  findings: QcFinding[];
  anomaly: AnomalyResult | null;
  threshold: number;
  /** Frames edited since the run, as `qcFrameKey`s. */
  editedFrames: ReadonlySet<string>;
  run: (labels: Labels) => Promise<void>;
  cancel: () => void;
  setThreshold: (t: number) => void;
  /** Drop results (project changed). */
  reset: () => void;
}

let abort: AbortController | null = null;

export const useQcStore = create<QcState>((set, get) => ({
  labels: null,
  state: "idle",
  progress: 0,
  findings: [],
  anomaly: null,
  threshold: QC_ANOMALY_THRESHOLD,
  editedFrames: new Set(),

  run: async (labels) => {
    abort?.abort();
    const ac = new AbortController();
    abort = ac;
    set({
      labels,
      state: "running",
      progress: 0,
      findings: [],
      anomaly: null,
      editedFrames: new Set(),
    });
    await yieldToEvent(); // paint the progress bar before the sync rule sweep
    let findings: QcFinding[] = [];
    try {
      findings = runLabelQc(labels);
    } catch {
      findings = [];
    }
    if (ac.signal.aborted) return;
    set({ findings });
    try {
      const anomaly = await scoreLabelsAnomalyAsync(labels, {
        onProgress: (progress) => set({ progress }),
        signal: ac.signal,
      });
      set({ anomaly, state: "done" });
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        // Cancelled: back to the Run button (unless a newer run took over).
        if (abort === ac) set({ state: "idle", progress: 0, findings: [] });
      } else {
        set({
          anomaly: { instances: [], featureNames: [], gmmThreshold: null },
          state: "done",
        });
      }
    } finally {
      if (abort === ac) abort = null;
    }
  },

  cancel: () => abort?.abort(),

  setThreshold: (threshold) => set({ threshold }),

  reset: () => {
    abort?.abort();
    abort = null;
    if (get().labels === null && get().state === "idle") return;
    set({
      labels: null,
      state: "idle",
      progress: 0,
      findings: [],
      anomaly: null,
      editedFrames: new Set(),
    });
  },
}));

export const qcFrameKey = (videoIdx: number, frameIdx: number) => `${videoIdx}:${frameIdx}`;

/**
 * Group the results into one entry per flagged frame. Frames with a definite
 * rule error come first; the rest (statistical flags and possible rule errors
 * such as chain order) by worst statistical score.
 */
export function buildQcQueue(
  findings: QcFinding[],
  anomaly: AnomalyResult | null,
  threshold: number,
): QcQueueEntry[] {
  const byFrame = new Map<string, QcQueueEntry>();
  const entry = (videoIdx: number, frameIdx: number): QcQueueEntry => {
    const key = `${videoIdx}:${frameIdx}`;
    let e = byFrame.get(key);
    if (!e) {
      e = { videoIdx, frameIdx, rules: [], definite: false, anomalies: [], worst: 0 };
      byFrame.set(key, e);
    }
    return e;
  };
  for (const f of findings) {
    const e = entry(f.videoIdx, f.frameIdx);
    e.rules.push(f);
    if (!SOFT_QC_KINDS.has(f.kind)) e.definite = true;
  }
  for (const a of anomaly?.instances ?? []) {
    const v = anomalyVerdict(a, threshold, anomaly?.gmmThreshold ?? null);
    if (!v.flagged) continue;
    const e = entry(a.videoIdx, a.frameIdx);
    e.anomalies.push({ a, v });
    e.worst = Math.max(e.worst, v.score);
  }
  const out = [...byFrame.values()];
  const soft = (f: QcFinding) => Number(SOFT_QC_KINDS.has(f.kind));
  for (const e of out) {
    e.rules.sort((x, y) => soft(x) - soft(y));
    e.anomalies.sort((x, y) => y.v.score - x.v.score);
  }
  return out.sort(
    (x, y) =>
      Number(y.definite) - Number(x.definite) ||
      y.worst - x.worst ||
      x.videoIdx - y.videoIdx ||
      x.frameIdx - y.frameIdx,
  );
}

/** Jump to a flagged frame and select its worst flagged instance. */
export function goToQcEntry(labels: Labels, e: QcQueueEntry): void {
  const app = useAppStore.getState();
  const video = labels.videos[e.videoIdx];
  if (!video) return;
  app.setVideo(video);
  app.setFrameIdx(e.frameIdx);
  const lf = labels.find({ video }).find((x) => x.frameIdx === e.frameIdx);
  // Indices are relative to userInstances (QC scores labels, not predictions).
  const instIdx =
    e.anomalies[0]?.a.instIdx ?? e.rules.find((r) => r.instanceIdx !== undefined)?.instanceIdx;
  app.setInstance(instIdx !== undefined ? (lf?.userInstances[instIdx] ?? null) : null);
}

/**
 * Go to the next (dir 1) or previous (-1) flagged frame and show the Label QC
 * panel (F / Shift+F). From a flagged frame this is its neighbor in the queue;
 * from any other frame, the start (or end) of the queue.
 */
export function stepQcQueue(dir: 1 | -1): void {
  const app = useAppStore.getState();
  const qc = useQcStore.getState();
  const labels = app.labels;
  if (!labels) return;
  if (qc.state !== "done" || qc.labels !== labels) {
    toast.info("Run Label QC first (Analyze → Label Quality Check, or the Label QC panel).");
    return;
  }
  const queue = buildQcQueue(qc.findings, qc.anomaly, qc.threshold);
  if (queue.length === 0) {
    toast.info("Label QC flagged no frames.");
    return;
  }
  const videoIdx = app.video ? labels.videos.indexOf(app.video) : -1;
  const pos = queue.findIndex((e) => e.videoIdx === videoIdx && e.frameIdx === app.frameIdx);
  const i =
    pos < 0 ? (dir === 1 ? 0 : queue.length - 1) : (pos + dir + queue.length) % queue.length;
  goToQcEntry(labels, queue[i]);
  if (!app.sidebarOpenPanels.includes("qc")) app.openPanel("qc");
}

// Results belong to the labels they were computed from: drop them when a
// different project loads.
useAppStore.subscribe((s, prev) => {
  if (s.labels !== prev.labels) useQcStore.getState().reset();
});

// A frame edited since the run is stale: its flags may already be fixed.
dirtyFrameTracker.onFrameEdit(({ video, frameIdx }) => {
  const qc = useQcStore.getState();
  if (qc.state === "idle" || !qc.labels) return;
  const key = qcFrameKey(qc.labels.videos.indexOf(video), frameIdx);
  if (qc.editedFrames.has(key)) return;
  useQcStore.setState({ editedFrames: new Set(qc.editedFrames).add(key) });
});
