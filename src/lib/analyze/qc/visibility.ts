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
 *
 * A node not labelled (mask entry `null`, SLP format 3.0) is neither visible
 * nor missing: it is left out of the rates it would count in, and is never
 * blamed for being absent.
 */
import type { NodeVisibility } from "./util";

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

  /** masks: NodeVisibility[N_instances][N_nodes] (`null` = not labelled). */
  fit(masks: NodeVisibility[][]): this {
    this.nInstances = masks.length;
    this.nNodes = masks.length ? masks[0].length : 0;
    // Rates over the instances that labeled the node (two counters, no
    // intermediate arrays: this runs for every node pair).
    const rate = (ms: NodeVisibility[][], j: number): number => {
      let known = 0;
      let visible = 0;
      for (const m of ms) {
        const v = m[j];
        if (v === null) continue;
        known++;
        if (v) visible++;
      }
      return known ? visible / known : 0;
    };
    this.visibilityRates = Array.from({ length: this.nNodes }, (_, j) => rate(masks, j));
    this.coVisibility = Array.from({ length: this.nNodes }, () =>
      new Array<number>(this.nNodes).fill(0),
    );
    for (let i = 0; i < this.nNodes; i++) {
      const withI = masks.filter((m) => m[i] === true);
      if (withI.length === 0) continue;
      for (let j = 0; j < this.nNodes; j++) {
        this.coVisibility[i][j] = rate(withI, j);
      }
    }
    return this;
  }

  /** mask: boolean[N_nodes] -> { patternScore (0..1), nViolations }. */
  score(mask: NodeVisibility[]): VisibilityScore {
    if (!this.coVisibility) throw new Error("Model not fitted. Call fit() first.");
    let nViolations = 0;
    for (let i = 0; i < this.nNodes; i++) {
      if (!mask[i]) continue;
      for (let j = 0; j < this.nNodes; j++) {
        if (i === j || mask[j] === null) continue; // not labelled: no verdict
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
  worstNode(mask: NodeVisibility[]): number {
    return this.worstNodeDetail(mask).node;
  }

  /**
   * The most-blamed node AND which of the two ways it is anomalous:
   *   "absent"  — peers almost always co-visible with it are here, and it is not
   *   "present" — it is here, and it almost never co-occurs with the peers that are
   * A node the model cannot blame either way returns { node: -1, kind: null }.
   */
  worstNodeDetail(mask: NodeVisibility[]): WorstNodeDetail {
    if (!this.coVisibility) throw new Error("Model not fitted. Call fit() first.");
    const blame = new Array<number>(this.nNodes).fill(0);
    for (let i = 0; i < this.nNodes; i++) {
      if (!mask[i]) continue;
      for (let j = 0; j < this.nNodes; j++) {
        if (i === j || mask[j] === null) continue; // not labelled: never blamed
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
