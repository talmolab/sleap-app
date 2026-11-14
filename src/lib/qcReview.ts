/**
 * Text for the Label QC Review window (QcReviewFrame).
 */
import type { AnomalyInstance, AnomalyVerdict } from "@/lib/analyze/qc/anomaly";
import { withDirection } from "@/lib/analyze/qc/explain";

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
  { action: "Close the Review window", keys: "Esc" },
];
