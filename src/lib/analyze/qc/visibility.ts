/**
 * Co-visibility QC model (V3 feature `visibility_pattern_score`).
 *
 * Ported from github.com/alexwu-z/sleap-qc-webapp
 * (`src/lib/qc/checks/features/visibility.js`, itself a port of
 * `sleap/qc/features/visibility.py`), a lab JS port of Python `sleap.qc`
 * intended for integration into sleap-app.
 *
 * Learns P(node_j visible | node_i visible) over a reference set of visibility
 * masks, then scores how unusual a pose's visibility pattern is.
 */

/** `score()` result: normalized pattern score in [0,1] + raw violation count. */
export interface VisibilityScore {
  patternScore: number;
  nViolations: number;
}

/** Which node most violates the model, and whether it is wrongly absent or present. */
export interface WorstNodeDetail {
  node: number;
  kind: "absent" | "present" | null;
  blame: number;
}

/** Learns P(node_j visible | node_i visible) and scores unusual visibility patterns. */
export class VisibilityModel {
  nNodes: number;
  coVisibility: number[][] | null; // nNodes x nNodes
  visibilityRates: number[] | null;
  nInstances: number;

  constructor() {
    this.nNodes = 0;
    this.coVisibility = null;
    this.visibilityRates = null;
    this.nInstances = 0;
  }

  /** masks: boolean[N_instances][N_nodes]. */
  fit(masks: boolean[][]): this {
    this.nInstances = masks.length;
    this.nNodes = masks.length ? masks[0].length : 0;
    this.visibilityRates = Array.from({ length: this.nNodes }, (_, j) =>
      masks.length
        ? masks.reduce((s, m) => s + (m[j] ? 1 : 0), 0) / masks.length
        : 0,
    );
    this.coVisibility = Array.from({ length: this.nNodes }, () =>
      new Array<number>(this.nNodes).fill(0),
    );
    for (let i = 0; i < this.nNodes; i++) {
      const withI = masks.filter((m) => m[i]);
      if (withI.length === 0) continue;
      for (let j = 0; j < this.nNodes; j++) {
        this.coVisibility[i][j] =
          withI.reduce((s, m) => s + (m[j] ? 1 : 0), 0) / withI.length;
      }
    }
    return this;
  }

  /** mask: boolean[N_nodes] -> { patternScore (0..1), nViolations }. */
  score(mask: boolean[]): VisibilityScore {
    if (!this.coVisibility) throw new Error("Model not fitted. Call fit() first.");
    let nViolations = 0;
    for (let i = 0; i < this.nNodes; i++) {
      if (!mask[i]) continue;
      for (let j = 0; j < this.nNodes; j++) {
        if (i === j) continue;
        const p = this.coVisibility[i][j];
        if (!mask[j] && p > 0.9) nViolations++; // expected visible, but invisible
        else if (mask[j] && p < 0.1) nViolations++; // rarely co-visible, yet visible
      }
    }
    return {
      patternScore: Math.min(1, nViolations / Math.max(1, this.nNodes)),
      nViolations,
    };
  }

  /**
   * The node whose visibility state most violates the co-visibility model — for
   * naming *which* node drives a `visibility_pattern_score` anomaly. Blame
   * accrues to the surprising node `j`; returns the most-blamed node, or -1 if
   * the pose has no violations.
   */
  worstNode(mask: boolean[]): number {
    return this.worstNodeDetail(mask).node;
  }

  /**
   * The most-blamed node AND which of the two ways it is anomalous:
   *   "absent"  — peers almost always co-visible with it are here, and it is not
   *   "present" — it is here, and it almost never co-occurs with the peers that are
   * A node the model cannot blame either way returns { node: -1, kind: null }.
   */
  worstNodeDetail(mask: boolean[]): WorstNodeDetail {
    if (!this.coVisibility) throw new Error("Model not fitted. Call fit() first.");
    const blame = new Array<number>(this.nNodes).fill(0);
    for (let i = 0; i < this.nNodes; i++) {
      if (!mask[i]) continue;
      for (let j = 0; j < this.nNodes; j++) {
        if (i === j) continue;
        const p = this.coVisibility[i][j];
        if (!mask[j] && p > 0.9) blame[j]++; // j expected visible, but absent
        else if (mask[j] && p < 0.1) blame[j]++; // j rarely co-visible, yet present
      }
    }
    let best = -1,
      bestC = 0;
    for (let j = 0; j < this.nNodes; j++)
      if (blame[j] > bestC) {
        bestC = blame[j];
        best = j;
      }
    // The blame rule is mutually exclusive per node, so the mask itself names the case.
    return {
      node: best,
      kind: best < 0 ? null : mask[best] ? "present" : "absent",
      blame: bestC,
    };
  }
}
