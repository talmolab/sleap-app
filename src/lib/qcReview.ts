/**
 * Text and one-click fixes for the Label QC Review window (QcReviewFrame).
 */
import type { AnomalyInstance, AnomalyVerdict } from "@/lib/analyze/qc/anomaly";
import { withDirection } from "@/lib/analyze/qc/explain";
import type { QcFinding } from "@/lib/analyze/labelQc";

/**
 * One flagged instance's issue, with the node(s) it is about: the joint of an
 * unusual angle, both ends of an edge, or the node the GMM blames, e.g.
 * "Unusual joint angle (decreased) · thorax".
 */
export function qcIssueText(a: AnomalyInstance, v: AnomalyVerdict, nodeNames: string[]): string {
  const name = (i: number) => nodeNames[i] ?? `node ${i + 1}`;
  if (v.by === "gmm") {
    return a.gmmNode != null && a.gmmNode >= 0 ? `${v.issue} · ${name(a.gmmNode)}` : v.issue;
  }
  const n = a.issueNodes;
  const where =
    n.length === 0
      ? ""
      : a.issueKind === "angle"
        ? name(n[0])
        : a.issueKind === "edge"
          ? `${name(n[0])} – ${name(n[1])}`
          : n.map(name).join(", ");
  const issue = withDirection(v.issue, a.issueDir);
  return where ? `${issue} · ${where}` : issue;
}

/** The Review window's keys, for the Keyboard Shortcuts dialog. */
export const QC_REVIEW_KEYS: { action: string; keys: string }[] = [
  { action: "Previous / next flag", keys: "← / →" },
  { action: "Ignore the flag and go to the next", keys: "3" },
  { action: "Zoom back to the flagged instance", keys: "0" },
  { action: "Accept Claude's suggestion", keys: "A" },
  { action: "Reject Claude's suggestion", keys: "X" },
  { action: "Close the Review window", keys: "Esc" },
];

/** A one-click fix the Review footer offers for what's flagged. */
export type QcFix =
  | { kind: "swap" }
  | { kind: "merge"; otherInstIdx: number }
  | { kind: "hideOutside" }
  | { kind: "addInstance" };

/**
 * The fixes for the flags on screen, in footer order. `instIdx` is the
 * selected instance's `userInstances` index (-1 for none); `rules` are the
 * frame's rule findings still open; `anomaly` is the selected instance's
 * anomaly flag, if any.
 *  - Swap L/R: a chirality finding, or an anomaly whose top issue is an L/R swap.
 *  - Merge: a duplicate pair the selected instance is either side of.
 *  - Hide outside points: points outside the frame.
 *  - Add instance: the frame has fewer instances than usual.
 */
export function qcFixes(
  rules: readonly Pick<QcFinding, "kind" | "instanceIdx" | "otherInstanceIdx">[],
  instIdx: number,
  anomaly: Pick<AnomalyInstance, "topIssue"> | null,
): QcFix[] {
  const fixes: QcFix[] = [];
  const mine = rules.filter((r) => instIdx >= 0 && r.instanceIdx === instIdx);
  if (mine.some((r) => r.kind === "chirality") || anomaly?.topIssue === L_R_SWAP_ISSUE) {
    fixes.push({ kind: "swap" });
  }
  if (instIdx >= 0) {
    const dup = rules.find(
      (r) => r.kind === "duplicate" && (r.instanceIdx === instIdx || r.otherInstanceIdx === instIdx),
    );
    const other = dup && (dup.instanceIdx === instIdx ? dup.otherInstanceIdx : dup.instanceIdx);
    if (other !== undefined && other !== instIdx) fixes.push({ kind: "merge", otherInstIdx: other });
  }
  if (mine.some((r) => r.kind === "out_of_range")) fixes.push({ kind: "hideOutside" });
  if (rules.some((r) => r.kind === "incomplete_frame")) fixes.push({ kind: "addInstance" });
  return fixes;
}

/** The anomaly engine's issue for a likely left/right swap (`qc/explain.ts`). */
export const L_R_SWAP_ISSUE = "Likely L/R swap";
