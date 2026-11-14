/**
 * Label QC results, shared by the Label Quality Check dialog and the Label QC
 * side panel so a run started in either shows up in both.
 *
 * One run does both analyses: the rule checks (labelQc.ts, instant) and then
 * the statistical anomaly + GMM scores (qc/anomaly.ts, chunked-async with
 * progress and cancel). Results belong to the `Labels` they were computed
 * from and are dropped when a different project loads.
 *
 * Instances marked OK (key 3, qcReviewed.ts) hide their flags. Those marks
 * belong to the project, not the run: they survive Rerun and reopening it.
 *
 * The Review window (QcReviewFrame) is a mode, not a second canvas: it frames
 * the main canvas while `reviewOpen`, and ← / → step through the flags in
 * `reviewOrder`, which also orders the panel's list and F / Shift+F.
 */
import { create } from "zustand";
import type { LabeledFrame, Labels } from "@/types";
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
import { resolveProjectKey } from "@/lib/trackColorOverrides";
import { addQcMarks, loadQcMarks, qcMarkKey, removeQcMark } from "@/lib/qcReviewed";

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
  /**
   * User instances on this frame marked OK. Their flags stay in `rules` and
   * `anomalies` (after the others) but don't count toward `definite`/`worst`;
   * `hideOkFlags` drops them.
   */
  ok: number[];
}

/**
 * How flagged frames are ordered: "severity" = definite rule errors first,
 * then worst single score; "detectors" = most checks agreeing on the worst
 * instance first; "frame" = by video, then frame.
 */
export type QcReviewOrder = "severity" | "detectors" | "frame";

/** Whether a user instance is marked OK with its current pose. */
export type QcIsOk = (videoIdx: number, frameIdx: number, userInstIdx: number) => boolean;

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
  /** The project's OK marks (qcMarkKey), and the project key they belong to. */
  dismissed: ReadonlySet<string>;
  dismissedProject: string | null;
  /** Show instances marked OK (greyed, with Undo) instead of hiding them. */
  showDismissed: boolean;
  /** The Review window is open (the main canvas, framed, over the dimmed app). */
  reviewOpen: boolean;
  reviewOrder: QcReviewOrder;
  run: (labels: Labels) => Promise<void>;
  cancel: () => void;
  setThreshold: (t: number) => void;
  setShowDismissed: (show: boolean) => void;
  setReviewOpen: (open: boolean) => void;
  setReviewOrder: (order: QcReviewOrder) => void;
  /** Mark a user instance OK with its current pose, or take that back. */
  markOk: (videoIdx: number, frameIdx: number, userInstIdx: number) => void;
  unmarkOk: (videoIdx: number, frameIdx: number, userInstIdx: number) => void;
  /** Load a project's marks (on project load). */
  loadDismissed: (projectKey: string | null) => Promise<void>;
  /** Drop results (project changed). */
  reset: () => void;
}

/** The current user instance at a QC position, or null. */
function userInstanceAt(videoIdx: number, frameIdx: number, userInstIdx: number) {
  const labels = useAppStore.getState().labels;
  const video = labels?.videos[videoIdx];
  if (!labels || !video) return null;
  const lf = labels.find({ video, frameIdx })[0];
  return lf?.userInstances[userInstIdx] ?? null;
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
  dismissed: new Set(),
  dismissedProject: null,
  showDismissed: false,
  reviewOpen: false,
  reviewOrder: "severity",

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

  setShowDismissed: (showDismissed) => set({ showDismissed }),

  setReviewOpen: (reviewOpen) => set({ reviewOpen }),

  setReviewOrder: (reviewOrder) => set({ reviewOrder }),

  markOk: (videoIdx, frameIdx, userInstIdx) => {
    const inst = userInstanceAt(videoIdx, frameIdx, userInstIdx);
    const project = get().dismissedProject;
    if (!inst || project === null) return;
    const key = qcMarkKey(videoIdx, frameIdx, userInstIdx, inst);
    if (get().dismissed.has(key)) return;
    set({ dismissed: new Set(get().dismissed).add(key) });
    void addQcMarks(project, [key]);
  },

  unmarkOk: (videoIdx, frameIdx, userInstIdx) => {
    const inst = userInstanceAt(videoIdx, frameIdx, userInstIdx);
    const project = get().dismissedProject;
    if (!inst || project === null) return;
    const key = qcMarkKey(videoIdx, frameIdx, userInstIdx, inst);
    if (!get().dismissed.has(key)) return;
    const dismissed = new Set(get().dismissed);
    dismissed.delete(key);
    set({ dismissed });
    void removeQcMark(project, key);
  },

  loadDismissed: async (projectKey) => {
    set({ dismissed: new Set(), dismissedProject: projectKey });
    if (projectKey === null) return;
    const keys = await loadQcMarks(projectKey);
    // A different project may have loaded meanwhile.
    if (keys.length === 0 || get().dismissedProject !== projectKey) return;
    // Keep anything marked while loading.
    set({ dismissed: new Set([...keys, ...get().dismissed]) });
  },

  reset: () => {
    abort?.abort();
    abort = null;
    if (get().labels === null && get().state === "idle" && !get().reviewOpen) return;
    set({
      reviewOpen: false,
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
 * such as chain order) by worst statistical score. Instances `isOk` accepts
 * are listed in `ok` and count for nothing, so a frame with only those sorts
 * last.
 */
export function buildQcQueue(
  findings: QcFinding[],
  anomaly: AnomalyResult | null,
  threshold: number,
  isOk?: QcIsOk,
): QcQueueEntry[] {
  const byFrame = new Map<string, QcQueueEntry>();
  const entry = (videoIdx: number, frameIdx: number): QcQueueEntry => {
    const key = `${videoIdx}:${frameIdx}`;
    let e = byFrame.get(key);
    if (!e) {
      e = { videoIdx, frameIdx, rules: [], definite: false, anomalies: [], worst: 0, ok: [] };
      byFrame.set(key, e);
    }
    return e;
  };
  const okHere = (e: QcQueueEntry, instIdx: number | undefined) => {
    if (instIdx === undefined || !isOk) return false;
    if (e.ok.includes(instIdx)) return true;
    if (!isOk(e.videoIdx, e.frameIdx, instIdx)) return false;
    e.ok.push(instIdx);
    return true;
  };
  for (const f of findings) {
    const e = entry(f.videoIdx, f.frameIdx);
    e.rules.push(f);
    if (!SOFT_QC_KINDS.has(f.kind) && !okHere(e, f.instanceIdx)) e.definite = true;
  }
  for (const a of anomaly?.instances ?? []) {
    const v = anomalyVerdict(a, threshold, anomaly?.gmmThreshold ?? null);
    if (!v.flagged) continue;
    const e = entry(a.videoIdx, a.frameIdx);
    e.anomalies.push({ a, v });
    if (!okHere(e, a.instIdx)) e.worst = Math.max(e.worst, v.score);
  }
  const out = [...byFrame.values()];
  const soft = (f: QcFinding) => Number(SOFT_QC_KINDS.has(f.kind));
  for (const e of out) {
    const ok = (i: number | undefined) => Number(i !== undefined && e.ok.includes(i));
    // Soft rules don't set `definite`, so okHere may not have seen them yet.
    for (const r of e.rules) okHere(e, r.instanceIdx);
    e.rules.sort((x, y) => ok(x.instanceIdx) - ok(y.instanceIdx) || soft(x) - soft(y));
    e.anomalies.sort((x, y) => ok(x.a.instIdx) - ok(y.a.instIdx) || y.v.score - x.v.score);
  }
  return out.sort(
    (x, y) =>
      Number(y.definite) - Number(x.definite) ||
      y.worst - x.worst ||
      x.videoIdx - y.videoIdx ||
      x.frameIdx - y.frameIdx,
  );
}

/** Whether a frame still has a flag not marked OK. */
export const hasOpenFlags = (e: QcQueueEntry) =>
  e.rules.some((r) => r.instanceIdx === undefined || !e.ok.includes(r.instanceIdx)) ||
  e.anomalies.some(({ a }) => !e.ok.includes(a.instIdx));

/** The queue without flags on OK instances, and without frames left with none. */
export function hideOkFlags(queue: QcQueueEntry[]): QcQueueEntry[] {
  const out: QcQueueEntry[] = [];
  for (const e of queue) {
    if (e.ok.length === 0) out.push(e);
    else if (hasOpenFlags(e))
      out.push({
        ...e,
        rules: e.rules.filter((r) => r.instanceIdx === undefined || !e.ok.includes(r.instanceIdx)),
        anomalies: e.anomalies.filter(({ a }) => !e.ok.includes(a.instIdx)),
        ok: [],
      });
  }
  return out;
}

/**
 * The user instance a frame's flags are mostly about: its worst open
 * instance flag, else its worst flag. OK instances' flags sort last.
 */
export function qcFocusInstance(e: QcQueueEntry): number | undefined {
  return (
    e.anomalies.find(({ a }) => !e.ok.includes(a.instIdx))?.a.instIdx ??
    e.rules.find((r) => r.instanceIdx !== undefined && !e.ok.includes(r.instanceIdx))
      ?.instanceIdx ??
    e.anomalies[0]?.a.instIdx ??
    e.rules.find((r) => r.instanceIdx !== undefined)?.instanceIdx
  );
}

/**
 * How many checks flag the frame's worst instance: the anomaly score, the
 * GMM score, and each kind of rule finding on it (or on the whole frame).
 */
export function qcDetectorCount(e: QcQueueEntry): number {
  const inst = qcFocusInstance(e);
  const v = e.anomalies.find(({ a }) => a.instIdx === inst)?.v;
  const rules = new Set(
    e.rules.filter((r) => r.instanceIdx === undefined || r.instanceIdx === inst).map((r) => r.kind),
  );
  return (
    Number(v?.by === "anomaly" || v?.by === "both") +
    Number(v?.by === "gmm" || v?.by === "both") +
    rules.size
  );
}

/** A queue (as buildQcQueue orders it, by severity) in `order`. */
export function sortQcQueue(queue: QcQueueEntry[], order: QcReviewOrder): QcQueueEntry[] {
  if (order === "severity") return queue;
  const byFrame = (x: QcQueueEntry, y: QcQueueEntry) =>
    x.videoIdx - y.videoIdx || x.frameIdx - y.frameIdx;
  if (order === "frame") return [...queue].sort(byFrame);
  const count = new Map(queue.map((e) => [e, qcDetectorCount(e)]));
  return [...queue].sort(
    (x, y) => count.get(y)! - count.get(x)! || y.worst - x.worst || byFrame(x, y),
  );
}

/**
 * `isOk` for buildQcQueue: an instance is OK when a mark matches its position
 * and current pose (so an edited pose is flagged again). Undefined when there
 * are no marks. Fingerprints only instances at a marked position.
 */
export function qcIsOk(labels: Labels | null, dismissed: ReadonlySet<string>): QcIsOk | undefined {
  if (!labels || dismissed.size === 0) return undefined;
  const positions = new Set<string>();
  for (const k of dismissed) positions.add(k.slice(0, k.lastIndexOf(":")));
  let frames: Map<string, LabeledFrame> | null = null;
  return (videoIdx, frameIdx, userInstIdx) => {
    if (!positions.has(`${videoIdx}:${frameIdx}:${userInstIdx}`)) return false;
    if (!frames) {
      frames = new Map();
      const videoIdxOf = new Map(labels.videos.map((v, i) => [v, i]));
      for (const lf of labels.labeledFrames)
        frames.set(qcFrameKey(videoIdxOf.get(lf.video) ?? -1, lf.frameIdx), lf);
    }
    const inst = frames.get(qcFrameKey(videoIdx, frameIdx))?.userInstances[userInstIdx];
    return !!inst && dismissed.has(qcMarkKey(videoIdx, frameIdx, userInstIdx, inst));
  };
}

/**
 * The review queue as the panel shows it: OK instances' flags hidden unless
 * "show dismissed" is on, in the review order. Edits change fingerprints, so
 * rebuild after them.
 */
export function liveQcQueue(): QcQueueEntry[] {
  const qc = useQcStore.getState();
  const full = buildQcQueue(
    qc.findings,
    qc.anomaly,
    qc.threshold,
    qcIsOk(useAppStore.getState().labels, qc.dismissed),
  );
  return sortQcQueue(qc.showDismissed ? full : hideOkFlags(full), qc.reviewOrder);
}

/** Jump to a flagged frame, select its worst flagged instance and zoom to it. */
export function goToQcEntry(labels: Labels, e: QcQueueEntry): void {
  const app = useAppStore.getState();
  const video = labels.videos[e.videoIdx];
  if (!video) return;
  app.setVideo(video);
  app.setFrameIdx(e.frameIdx);
  const lf = labels.find({ video }).find((x) => x.frameIdx === e.frameIdx);
  // Indices are relative to userInstances (QC scores labels, not predictions).
  const instIdx = qcFocusInstance(e);
  const inst = instIdx !== undefined ? (lf?.userInstances[instIdx] ?? null) : null;
  app.setInstance(inst);
  // Zoom to it (the canvas waits for the new frame to render first).
  if (inst) app.set("fitSelection", true);
}

/**
 * Go to the next (dir 1) or previous (-1) flagged frame and show the Label QC
 * panel (F / Shift+F, and ← / → in the Review window, which needs no panel).
 * From a flagged frame this is its neighbor in the queue; from any other
 * frame, the start (or end) of the queue.
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
  const queue = liveQcQueue();
  if (queue.length === 0) {
    toast.info("Label QC flagged no frames.");
    return;
  }
  const videoIdx = app.video ? labels.videos.indexOf(app.video) : -1;
  const pos = queue.findIndex((e) => e.videoIdx === videoIdx && e.frameIdx === app.frameIdx);
  const i =
    pos < 0 ? (dir === 1 ? 0 : queue.length - 1) : (pos + dir + queue.length) % queue.length;
  goToQcEntry(labels, queue[i]);
  if (!qc.reviewOpen && !app.sidebarOpenPanels.includes("qc")) app.openPanel("qc");
}

/**
 * Open the Review window at the current flagged frame, or the first one.
 * Returns false (with a hint) when there is nothing to review.
 */
export function openQcReview(): boolean {
  const app = useAppStore.getState();
  const qc = useQcStore.getState();
  const labels = app.labels;
  if (!labels || qc.state !== "done" || qc.labels !== labels) {
    toast.info("Run Label QC first (Analyze → Label Quality Check, or the Label QC panel).");
    return false;
  }
  const queue = liveQcQueue();
  if (queue.length === 0) {
    toast.info("Label QC flagged no frames.");
    return false;
  }
  const videoIdx = app.video ? labels.videos.indexOf(app.video) : -1;
  const here = queue.find((e) => e.videoIdx === videoIdx && e.frameIdx === app.frameIdx);
  useQcStore.getState().setReviewOpen(true);
  goToQcEntry(labels, here ?? queue[0]);
  return true;
}

/**
 * Keys the Review window takes over while it is open: ← / → step through the
 * flags instead of frames, Esc closes it. Returns whether it took the key.
 */
export function handleQcReviewKey(
  shortcut: "frame next" | "frame prev" | "clear selection",
): boolean {
  if (!useQcStore.getState().reviewOpen) return false;
  if (shortcut === "clear selection") useQcStore.getState().setReviewOpen(false);
  else stepQcQueue(shortcut === "frame next" ? 1 : -1);
  return true;
}

/**
 * Mark a flagged instance OK (key 3 / the card's Mark OK), then move on: to
 * the next open instance flag on this frame, else to the next flagged frame.
 */
export function markQcOkAndAdvance(videoIdx: number, frameIdx: number, userInstIdx: number): void {
  const labels = useAppStore.getState().labels;
  if (!labels) return;
  const before = liveQcQueue();
  const pos = before.findIndex((e) => e.videoIdx === videoIdx && e.frameIdx === frameIdx);
  useQcStore.getState().markOk(videoIdx, frameIdx, userInstIdx);
  const after = liveQcQueue();
  const here = after.find((e) => e.videoIdx === videoIdx && e.frameIdx === frameIdx);
  const openInstance = (e: QcQueueEntry) =>
    e.anomalies.some(({ a }) => !e.ok.includes(a.instIdx)) ||
    e.rules.some((r) => r.instanceIdx !== undefined && !e.ok.includes(r.instanceIdx));
  if (here && openInstance(here)) {
    goToQcEntry(labels, here);
    return;
  }
  // The frame that followed this one, if it is still flagged.
  for (let i = 1; i <= before.length; i++) {
    const b = before[(pos + i) % before.length];
    const next = after.find(
      (e) => e.videoIdx === b.videoIdx && e.frameIdx === b.frameIdx && hasOpenFlags(e),
    );
    if (next && next !== here) {
      goToQcEntry(labels, next);
      return;
    }
  }
  toast.info("All Label QC flags reviewed.");
}

/**
 * Key 3: mark the selected instance OK if it is flagged on this frame, then
 * go to the next flag.
 */
export function markSelectedQcOk(): void {
  const app = useAppStore.getState();
  const qc = useQcStore.getState();
  const labels = app.labels;
  if (!labels) return;
  if (qc.state !== "done" || qc.labels !== labels) {
    toast.info("Run Label QC first (Analyze → Label Quality Check, or the Label QC panel).");
    return;
  }
  const videoIdx = app.video ? labels.videos.indexOf(app.video) : -1;
  const lf = app.video ? labels.find({ video: app.video, frameIdx: app.frameIdx })[0] : undefined;
  const instIdx = app.instance && lf ? lf.userInstances.indexOf(app.instance) : -1;
  const e = liveQcQueue().find((x) => x.videoIdx === videoIdx && x.frameIdx === app.frameIdx);
  const flagged =
    !!e &&
    instIdx >= 0 &&
    !e.ok.includes(instIdx) &&
    (e.anomalies.some(({ a }) => a.instIdx === instIdx) ||
      e.rules.some((r) => r.instanceIdx === instIdx));
  if (!flagged) {
    toast.info("Select a flagged instance on this frame to ignore it.");
    return;
  }
  markQcOkAndAdvance(videoIdx, app.frameIdx, instIdx);
}

const projectKeyOf = (s: ReturnType<typeof useAppStore.getState>) =>
  s.labels ? resolveProjectKey(s.projectPath, s.filename) : null;

// Results belong to the labels they were computed from: drop them when a
// different project loads. OK marks belong to the project: load its marks,
// or after Save As (same labels, new path) copy them to the new key.
useAppStore.subscribe((s, prev) => {
  if (s.labels !== prev.labels) useQcStore.getState().reset();
  const key = projectKeyOf(s);
  const qc = useQcStore.getState();
  if (key === qc.dismissedProject) return;
  if (s.labels === prev.labels && key !== null && qc.dismissedProject !== null) {
    useQcStore.setState({ dismissedProject: key });
    void addQcMarks(key, [...qc.dismissed]);
  } else {
    void qc.loadDismissed(key);
  }
});

// A frame edited since the run is stale: its flags may already be fixed.
dirtyFrameTracker.onFrameEdit(({ video, frameIdx }) => {
  const qc = useQcStore.getState();
  if (qc.state === "idle" || !qc.labels) return;
  const key = qcFrameKey(qc.labels.videos.indexOf(video), frameIdx);
  if (qc.editedFrames.has(key)) return;
  useQcStore.setState({ editedFrames: new Set(qc.editedFrames).add(key) });
});
