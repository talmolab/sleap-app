/**
 * The Label QC overlay for the current frame: which instances are flagged and
 * which of their nodes are behind each flag (see renderQcFlags), and which
 * instance to keep at full opacity while the rest dim. Shown only while the
 * Label QC panel or the Review window is open, so it never clutters ordinary
 * labeling. Instances
 * marked OK are left out, or drawn faded while the panel shows them.
 */
import { useMemo } from "react";
import { useAppStore } from "@/stores/appStore";
import {
  buildQcQueue,
  hideOkFlags,
  liveQcEntry,
  qcFrameKey,
  qcIsOk,
  useQcStore,
  type QcQueueEntry,
} from "@/stores/qcStore";
import type { QcCanvasFlag } from "@/canvas/SkeletonRenderer";
import type { LabeledFrame } from "@/types";

/**
 * Canvas flags for one frame's QC entry. QC indices are into the frame's
 * `userInstances`; the canvas draws `instances` (user + predicted), so map
 * through the instance object. An anomaly is drawn the way its issue reads
 * (an edge, a joint angle, or nodes), a GMM flag rings the node it blames.
 * Instances marked OK (`entry.ok`) draw faded, like a stale frame. A
 * re-scored instance (Review) is current even on an edited frame, and fades
 * once its new scores no longer flag it.
 */
export function qcCanvasFlags(
  entry: QcQueueEntry,
  lf: LabeledFrame,
  stale: boolean,
): QcCanvasFlag[] {
  interface Marks {
    nodes: Set<number>;
    edges: [number, number][];
    angles: [number, number, number][];
    ok: boolean;
    rescored: boolean;
    /** Re-scored, no longer flagged, and no rule finding on it. */
    fixed: boolean;
  }
  const byIdx = new Map<number, Marks>();
  const flag = (userIdx: number | undefined) => {
    if (userIdx === undefined) return null;
    const inst = lf.userInstances[userIdx];
    const idx = inst ? lf.instances.indexOf(inst) : -1;
    if (idx < 0) return null;
    let f = byIdx.get(idx);
    if (!f) {
      f = {
        nodes: new Set(),
        edges: [],
        angles: [],
        ok: entry.ok.includes(userIdx),
        rescored: false,
        fixed: false,
      };
      byIdx.set(idx, f);
    }
    return f;
  };
  for (const r of entry.rules) flag(r.instanceIdx);
  for (const { a, v } of entry.anomalies) {
    const f = flag(a.instIdx);
    if (!f) continue;
    if (a.rescored) {
      f.rescored = true;
      f.fixed = !v.flagged && !entry.rules.some((r) => r.instanceIdx === a.instIdx);
    }
    if (v.by === "anomaly" || v.by === "both") {
      const n = a.issueNodes;
      if (a.issueKind === "edge" && n.length === 2) f.edges.push([n[0], n[1]]);
      else if (a.issueKind === "angle" && n.length === 3) f.angles.push([n[0], n[1], n[2]]);
      else for (const i of n) f.nodes.add(i);
    }
    if ((v.by === "gmm" || v.by === "both") && a.gmmNode != null && a.gmmNode >= 0)
      f.nodes.add(a.gmmNode);
  }
  return [...byIdx].map(([instanceIdx, { nodes, edges, angles, ok, rescored, fixed }]) => ({
    instanceIdx,
    nodes: [...nodes],
    edges,
    angles,
    stale: (stale && !rescored) || ok || fixed,
  }));
}

export interface QcFrameOverlay {
  flags: QcCanvasFlag[];
  /**
   * The selected instance's index when it is one of the flagged ones (e.g.
   * after F): the canvas dims every other pose around it. Else null.
   */
  focusIdx: number | null;
}

const NONE: QcFrameOverlay = { flags: [], focusIdx: null };

/** The QC overlay for the frame on screen; empty when QC hasn't run or neither the panel nor Review is open. */
export function useQcFrameFlags(): QcFrameOverlay {
  const labels = useAppStore((s) => s.labels);
  const video = useAppStore((s) => s.video);
  const labeledFrame = useAppStore((s) => s.labeledFrame);
  const selected = useAppStore((s) => s.instance);
  const panelOpen = useAppStore((s) => !s.sidebarCollapsed && s.sidebarOpenPanels.includes("qc"));
  const reviewOpen = useQcStore((s) => s.reviewOpen);
  const show = panelOpen || reviewOpen;
  const qcLabels = useQcStore((s) => s.labels);
  const state = useQcStore((s) => s.state);
  const findings = useQcStore((s) => s.findings);
  const anomaly = useQcStore((s) => s.anomaly);
  const threshold = useQcStore((s) => s.threshold);
  const editedFrames = useQcStore((s) => s.editedFrames);
  const dismissed = useQcStore((s) => s.dismissed);
  const showDismissed = useQcStore((s) => s.showDismissed);
  const rescored = useQcStore((s) => s.rescored);
  // Edits change pose fingerprints, so OK marks are re-matched after each.
  const editSeq = useAppStore((s) => s.editSeq);

  const byFrame = useMemo(() => {
    const m = new Map<string, QcQueueEntry>();
    // Built only while shown: matching OK marks can touch every flagged instance.
    if (!show) return m;
    const full = buildQcQueue(findings, anomaly, threshold, qcIsOk(labels, dismissed));
    for (const e of showDismissed ? full : hideOkFlags(full))
      m.set(qcFrameKey(e.videoIdx, e.frameIdx), e);
    return m;
    // editSeq isn't read, but each edit can change a fingerprint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show, findings, anomaly, threshold, labels, dismissed, showDismissed, editSeq]);

  return useMemo(() => {
    if (!show || state !== "done" || !labels || qcLabels !== labels || !video || !labeledFrame)
      return NONE;
    const key = qcFrameKey(labels.videos.indexOf(video), labeledFrame.frameIdx);
    const run = byFrame.get(key);
    if (!run) return NONE;
    const entry = liveQcEntry(run, rescored, threshold, anomaly?.gmmThreshold ?? null);
    const flags = qcCanvasFlags(entry, labeledFrame, editedFrames.has(key));
    const sel = selected ? labeledFrame.instances.indexOf(selected) : -1;
    const focusIdx = flags.some((f) => f.instanceIdx === sel) ? sel : null;
    return { flags, focusIdx };
  }, [show, state, labels, qcLabels, video, labeledFrame, selected, byFrame, editedFrames, rescored, threshold, anomaly]);
}
