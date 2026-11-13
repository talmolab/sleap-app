/**
 * The Label QC flags to draw on the current frame: which instances are flagged
 * and which of their nodes are behind each flag (see renderQcFlags).
 */
import { useMemo } from "react";
import { useAppStore } from "@/stores/appStore";
import { buildQcQueue, qcFrameKey, useQcStore, type QcQueueEntry } from "@/stores/qcStore";
import type { QcCanvasFlag } from "@/canvas/SkeletonRenderer";
import type { LabeledFrame } from "@/types";

/**
 * Canvas flags for one frame's QC entry. QC indices are into the frame's
 * `userInstances`; the canvas draws `instances` (user + predicted), so map
 * through the instance object.
 */
export function qcCanvasFlags(
  entry: QcQueueEntry,
  lf: LabeledFrame,
  stale: boolean,
): QcCanvasFlag[] {
  const byIdx = new Map<number, Set<number>>();
  const flag = (userIdx: number | undefined) => {
    if (userIdx === undefined) return null;
    const inst = lf.userInstances[userIdx];
    const idx = inst ? lf.instances.indexOf(inst) : -1;
    if (idx < 0) return null;
    let nodes = byIdx.get(idx);
    if (!nodes) byIdx.set(idx, (nodes = new Set()));
    return nodes;
  };
  for (const r of entry.rules) flag(r.instanceIdx);
  for (const { a, v } of entry.anomalies) {
    const nodes = flag(a.instIdx);
    if (!nodes) continue;
    if (v.by === "anomaly" || v.by === "both") for (const n of a.issueNodes) nodes.add(n);
    if ((v.by === "gmm" || v.by === "both") && a.gmmNode != null && a.gmmNode >= 0)
      nodes.add(a.gmmNode);
  }
  return [...byIdx].map(([instanceIdx, nodes]) => ({
    instanceIdx,
    nodes: [...nodes],
    stale,
  }));
}

/** QC flags for the frame on screen, or [] when QC hasn't run or is hidden. */
export function useQcFrameFlags(): QcCanvasFlag[] {
  const labels = useAppStore((s) => s.labels);
  const video = useAppStore((s) => s.video);
  const labeledFrame = useAppStore((s) => s.labeledFrame);
  const show = useAppStore((s) => s.showQcFlags);
  const qcLabels = useQcStore((s) => s.labels);
  const state = useQcStore((s) => s.state);
  const findings = useQcStore((s) => s.findings);
  const anomaly = useQcStore((s) => s.anomaly);
  const threshold = useQcStore((s) => s.threshold);
  const editedFrames = useQcStore((s) => s.editedFrames);

  const byFrame = useMemo(() => {
    const m = new Map<string, QcQueueEntry>();
    for (const e of buildQcQueue(findings, anomaly, threshold))
      m.set(qcFrameKey(e.videoIdx, e.frameIdx), e);
    return m;
  }, [findings, anomaly, threshold]);

  return useMemo(() => {
    if (!show || state !== "done" || !labels || qcLabels !== labels || !video || !labeledFrame)
      return [];
    const key = qcFrameKey(labels.videos.indexOf(video), labeledFrame.frameIdx);
    const entry = byFrame.get(key);
    return entry ? qcCanvasFlags(entry, labeledFrame, editedFrames.has(key)) : [];
  }, [show, state, labels, qcLabels, video, labeledFrame, byFrame, editedFrames]);
}
