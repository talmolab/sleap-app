/**
 * The Label QC overlay for the current frame: which instances are flagged and
 * which of their nodes are behind each flag (see renderQcFlags), and which
 * instance to keep at full opacity while the rest dim. Shown only while the
 * Label QC panel is open, so it never clutters ordinary labeling. Instances
 * marked OK are left out, or drawn faded while the panel shows them.
 */
import { useMemo } from "react";
import { useAppStore } from "@/stores/appStore";
import {
  buildQcQueue,
  hideOkFlags,
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
 * through the instance object. Instances marked OK (`entry.ok`) draw faded,
 * like a stale frame.
 */
export function qcCanvasFlags(
  entry: QcQueueEntry,
  lf: LabeledFrame,
  stale: boolean,
): QcCanvasFlag[] {
  const byIdx = new Map<number, { nodes: Set<number>; ok: boolean }>();
  const flag = (userIdx: number | undefined) => {
    if (userIdx === undefined) return null;
    const inst = lf.userInstances[userIdx];
    const idx = inst ? lf.instances.indexOf(inst) : -1;
    if (idx < 0) return null;
    let f = byIdx.get(idx);
    if (!f) byIdx.set(idx, (f = { nodes: new Set(), ok: entry.ok.includes(userIdx) }));
    return f.nodes;
  };
  for (const r of entry.rules) flag(r.instanceIdx);
  for (const { a, v } of entry.anomalies) {
    const nodes = flag(a.instIdx);
    if (!nodes) continue;
    if (v.by === "anomaly" || v.by === "both") for (const n of a.issueNodes) nodes.add(n);
    if ((v.by === "gmm" || v.by === "both") && a.gmmNode != null && a.gmmNode >= 0)
      nodes.add(a.gmmNode);
  }
  return [...byIdx].map(([instanceIdx, { nodes, ok }]) => ({
    instanceIdx,
    nodes: [...nodes],
    stale: stale || ok,
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

/** The QC overlay for the frame on screen; empty when QC hasn't run or the panel is closed. */
export function useQcFrameFlags(): QcFrameOverlay {
  const labels = useAppStore((s) => s.labels);
  const video = useAppStore((s) => s.video);
  const labeledFrame = useAppStore((s) => s.labeledFrame);
  const selected = useAppStore((s) => s.instance);
  const show = useAppStore((s) => !s.sidebarCollapsed && s.sidebarOpenPanels.includes("qc"));
  const qcLabels = useQcStore((s) => s.labels);
  const state = useQcStore((s) => s.state);
  const findings = useQcStore((s) => s.findings);
  const anomaly = useQcStore((s) => s.anomaly);
  const threshold = useQcStore((s) => s.threshold);
  const editedFrames = useQcStore((s) => s.editedFrames);
  const dismissed = useQcStore((s) => s.dismissed);
  const showDismissed = useQcStore((s) => s.showDismissed);
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
    const entry = byFrame.get(key);
    if (!entry) return NONE;
    const flags = qcCanvasFlags(entry, labeledFrame, editedFrames.has(key));
    const sel = selected ? labeledFrame.instances.indexOf(selected) : -1;
    const focusIdx = flags.some((f) => f.instanceIdx === sel) ? sel : null;
    return { flags, focusIdx };
  }, [show, state, labels, qcLabels, video, labeledFrame, selected, byFrame, editedFrames]);
}
