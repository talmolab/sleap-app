/**
 * Label QC triage (the Grid window) and review progress: one tile per flagged
 * instance, and how many are still open, overall, by issue type and by video.
 *
 * Pure: works on the review queue (`buildQcQueue`, with OK marks), so it
 * agrees with the panel, Review and F / Shift+F.
 */
import { QC_KIND_LABEL, SOFT_QC_KINDS } from "@/lib/analyze/labelQc";
import type { QcQueueEntry } from "@/stores/qcStore";

export type QcTileStatus = "open" | "ignored" | "edited";

/** One flagged instance. */
export interface QcTile {
  videoIdx: number;
  frameIdx: number;
  /** Index into the frame's `userInstances`. */
  instIdx: number;
  /** What flagged it: rule labels ("Duplicate"…), then "Anomaly" and/or "GMM". */
  kinds: string[];
  /** A rule flagged a definite error (not a soft rule or a score). */
  definite: boolean;
  /** Worst score that flagged it; null when only rules did. */
  score: number | null;
  /** Nodes to ring on the thumbnail (the anomaly's issue nodes, or the GMM's node). */
  nodes: number[];
  status: QcTileStatus;
}

export const qcTileKey = (t: Pick<QcTile, "videoIdx" | "frameIdx" | "instIdx">) =>
  `${t.videoIdx}:${t.frameIdx}:${t.instIdx}`;

/**
 * The flagged instances in `queue`, in its order (worst first within a frame).
 * Frame-level findings (incomplete frame, negative frame) have no instance,
 * so they aren't tiles; {@link qcFrameFlagCount} counts them.
 */
export function qcTiles(queue: readonly QcQueueEntry[], editedFrames: ReadonlySet<string>): QcTile[] {
  const out: QcTile[] = [];
  for (const e of queue) {
    const edited = editedFrames.has(`${e.videoIdx}:${e.frameIdx}`);
    const byInst = new Map<number, QcTile>();
    const tile = (instIdx: number): QcTile => {
      let t = byInst.get(instIdx);
      if (!t) {
        const status: QcTileStatus = e.ok.includes(instIdx) ? "ignored" : edited ? "edited" : "open";
        t = { videoIdx: e.videoIdx, frameIdx: e.frameIdx, instIdx, kinds: [], definite: false, score: null, nodes: [], status };
        byInst.set(instIdx, t);
      }
      return t;
    };
    for (const { a, v } of e.anomalies) {
      if (!v.flagged) continue;
      const t = tile(a.instIdx);
      if (v.by === "anomaly" || v.by === "both") t.kinds.push("Anomaly");
      if (v.by === "gmm" || v.by === "both") t.kinds.push("GMM");
      t.score = Math.max(t.score ?? 0, v.score);
      t.nodes = v.by === "gmm" ? (a.gmmNode != null && a.gmmNode >= 0 ? [a.gmmNode] : []) : a.issueNodes;
    }
    for (const r of e.rules) {
      if (r.instanceIdx === undefined) continue;
      const t = tile(r.instanceIdx);
      const label = QC_KIND_LABEL[r.kind];
      if (!t.kinds.includes(label)) t.kinds.unshift(label);
      if (!SOFT_QC_KINDS.has(r.kind)) t.definite = true;
    }
    out.push(...byInst.values());
  }
  return out;
}

/** Frame-level findings (no instance to show), still open. */
export function qcFrameFlagCount(queue: readonly QcQueueEntry[], editedFrames: ReadonlySet<string>): number {
  let n = 0;
  for (const e of queue) {
    if (editedFrames.has(`${e.videoIdx}:${e.frameIdx}`)) continue;
    n += e.rules.filter((r) => r.instanceIdx === undefined).length;
  }
  return n;
}

export interface QcProgressRow {
  label: string;
  total: number;
  /** Still open: not ignored, and its frame not edited since the run. */
  left: number;
}

export interface QcProgress {
  total: number;
  ignored: number;
  edited: number;
  left: number;
  byKind: QcProgressRow[];
  byVideo: (QcProgressRow & { videoIdx: number })[];
}

/** How far the review has got, over the flagged instances. */
export function qcProgress(tiles: readonly QcTile[], videoName: (videoIdx: number) => string): QcProgress {
  const kinds = new Map<string, QcProgressRow>();
  const videos = new Map<number, QcProgressRow & { videoIdx: number }>();
  let ignored = 0;
  let edited = 0;
  for (const t of tiles) {
    if (t.status === "ignored") ignored++;
    else if (t.status === "edited") edited++;
    const open = t.status === "open" ? 1 : 0;
    for (const k of t.kinds) {
      const row = kinds.get(k) ?? { label: k, total: 0, left: 0 };
      row.total++;
      row.left += open;
      kinds.set(k, row);
    }
    const v = videos.get(t.videoIdx) ?? { videoIdx: t.videoIdx, label: videoName(t.videoIdx), total: 0, left: 0 };
    v.total++;
    v.left += open;
    videos.set(t.videoIdx, v);
  }
  const byCount = (a: QcProgressRow, b: QcProgressRow) => b.total - a.total || a.label.localeCompare(b.label);
  return {
    total: tiles.length,
    ignored,
    edited,
    left: tiles.length - ignored - edited,
    byKind: [...kinds.values()].sort(byCount),
    byVideo: [...videos.values()].sort((a, b) => a.videoIdx - b.videoIdx),
  };
}

/** Flagged instances plus frame-level findings in a run's results (OK marks ignored), for "last run vs this run". */
export function qcFlagTotal(queue: readonly QcQueueEntry[]): number {
  return qcTiles(queue, new Set()).length + qcFrameFlagCount(queue, new Set());
}
