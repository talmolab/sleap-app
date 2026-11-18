// Why: the Review footer offers a fix only when it matches what's flagged; a wrong button is worse than none.
import { describe, it, expect } from "../bun-test";
import { qcFixes, L_R_SWAP_ISSUE } from "@/lib/qcReview";
import type { QcIssueKind } from "@/lib/analyze/labelQc";
import { outOfRangeNodes } from "@/lib/analyze/labelQcRules";

const rule = (kind: QcIssueKind, instanceIdx?: number, otherInstanceIdx?: number) => ({
  kind,
  instanceIdx,
  otherInstanceIdx,
});
const kinds = (fs: ReturnType<typeof qcFixes>) => fs.map((f) => f.kind);

describe("qcFixes", () => {
  it("offers Swap L/R for a chirality finding on the selected instance", () => {
    expect(kinds(qcFixes([rule("chirality", 0)], 0, null))).toEqual(["swap"]);
    // ...not when another instance is the flipped one
    expect(kinds(qcFixes([rule("chirality", 1)], 0, null))).toEqual([]);
  });

  it("offers Swap L/R when the anomaly's top issue is an L/R swap", () => {
    expect(kinds(qcFixes([], 0, { topIssue: L_R_SWAP_ISSUE }))).toEqual(["swap"]);
    expect(kinds(qcFixes([], 0, { topIssue: "Unusual joint angle" }))).toEqual([]);
  });

  // Why: the duplicate finding is anchored to the first instance, but either side of the pair can be the survivor.
  it("offers Merge from either instance of a duplicate pair, naming the other", () => {
    expect(qcFixes([rule("duplicate", 0, 2)], 0, null)).toEqual([{ kind: "merge", otherInstIdx: 2 }]);
    expect(qcFixes([rule("duplicate", 0, 2)], 2, null)).toEqual([{ kind: "merge", otherInstIdx: 0 }]);
    expect(qcFixes([rule("duplicate", 0, 2)], 1, null)).toEqual([]);
  });

  it("offers Hide outside points for an out-of-range finding", () => {
    expect(kinds(qcFixes([rule("out_of_range", 1)], 1, null))).toEqual(["hideOutside"]);
  });

  // Why: an incomplete frame is about the frame, so Add instance shows with or without a selection.
  it("offers Add instance for an incomplete frame, even with nothing selected", () => {
    expect(kinds(qcFixes([rule("incomplete_frame")], -1, null))).toEqual(["addInstance"]);
  });

  it("offers nothing with no selection for instance-level findings", () => {
    expect(qcFixes([rule("chirality", 0), rule("out_of_range", 0)], -1, null)).toEqual([]);
  });
});

describe("outOfRangeNodes", () => {
  it("lists visible nodes outside the frame and skips hidden ones", () => {
    const pts = [[5, 5], [-1, 5], [5, 120], [NaN, NaN], [100, 100]];
    expect(outOfRangeNodes(pts, 100, 100)).toEqual([1, 2]);
  });
});
