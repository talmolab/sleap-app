import { describe, it, expect } from "../bun-test";
import { runLabelQc, type QcFinding } from "@/lib/analyze/labelQc";

const inst = (points: number[][]) => ({ numpy: () => points });
const clean = (ox: number, oy: number) => inst([[ox, oy], [ox + 5, oy + 5]]);
/** A predicted (non-user) instance — excluded from `userInstances`, as in io. */
const predInst = (points: number[][]) => ({ numpy: () => points, predicted: true });
const frame = (frameIdx: number, instances: unknown[], isNegative = false) => ({
  frameIdx,
  instances,
  // Mirror io's LabeledFrame.userInstances: user (non-predicted) instances only.
  userInstances: (instances as { predicted?: boolean }[]).filter((i) => !i?.predicted),
  isNegative,
});

function mockLabels(shape: number[] | null, frames: unknown[]) {
  const video = { shape };
  return { videos: [video], find: () => frames } as never;
}

const kinds = (fs: QcFinding[]) => fs.map((f) => f.kind);

describe("runLabelQc", () => {
  it("flags a duplicate pair (anchored to the first index)", () => {
    const fs = runLabelQc(mockLabels(null, [frame(0, [clean(0, 0), clean(0, 0), clean(80, 80)])]));
    const dup = fs.find((f) => f.kind === "duplicate");
    expect(dup).toBeTruthy();
    expect(dup).toMatchObject({ frameIdx: 0, instanceIdx: 0 });
  });

  it("flags an empty (all-NaN) instance", () => {
    const fs = runLabelQc(
      mockLabels(null, [frame(2, [inst([[Number.NaN, Number.NaN]]), clean(0, 0)])]),
    );
    const empty = fs.find((f) => f.kind === "empty_instance");
    expect(empty).toMatchObject({ frameIdx: 2, instanceIdx: 0 });
    // an empty instance is not ALSO reported as sparse
    expect(kinds(fs)).not.toContain("sparse_instance");
  });

  it("flags a sparse instance (fewer than minVisible nodes)", () => {
    const fs = runLabelQc(mockLabels(null, [frame(0, [inst([[1, 1]]), clean(50, 50)])]));
    expect(fs.find((f) => f.kind === "sparse_instance")).toMatchObject({ instanceIdx: 0 });
  });

  it("flags a negative frame that still has instances", () => {
    const fs = runLabelQc(mockLabels(null, [frame(5, [clean(0, 0)], true)]));
    expect(fs.find((f) => f.kind === "negative_frame")).toMatchObject({ frameIdx: 5 });
  });

  it("flags an incomplete frame (fewer instances than the per-video median)", () => {
    const fs = runLabelQc(
      mockLabels(null, [
        frame(0, [clean(0, 0), clean(50, 50)]),
        frame(1, [clean(0, 0), clean(50, 50)]),
        frame(2, [clean(0, 0)]),
      ]),
    );
    const inc = fs.filter((f) => f.kind === "incomplete_frame");
    expect(inc).toHaveLength(1);
    expect(inc[0]).toMatchObject({ frameIdx: 2 });
  });

  it("flags out-of-range points using the video's shape [_, h, w, _]", () => {
    const fs = runLabelQc(mockLabels([10, 100, 100, 1], [frame(0, [inst([[5, 5], [200, 5]])])]));
    expect(fs.find((f) => f.kind === "out_of_range")).toMatchObject({ frameIdx: 0, instanceIdx: 0 });
  });

  it("checks only user (labeled) instances, ignoring predictions", () => {
    // A frame with one clean USER instance plus a PREDICTED instance that would
    // otherwise be flagged (sparse: a single visible node). QC targets labels,
    // not predictions (matching PyQt's user_instances), so nothing is flagged.
    const fs = runLabelQc(
      mockLabels(null, [frame(0, [clean(0, 0), predInst([[1, 1]])])]),
    );
    expect(kinds(fs)).not.toContain("sparse_instance");
    expect(fs).toEqual([]);
  });

  it("instanceIdx is relative to userInstances (predictions don't shift it)", () => {
    // Predicted instance FIRST, then a sparse user instance: the user instance
    // is index 0 among userInstances even though it's index 1 in `instances`.
    const fs = runLabelQc(
      mockLabels(null, [frame(0, [predInst([[9, 9], [9, 9]]), inst([[1, 1]])])]),
    );
    expect(fs.find((f) => f.kind === "sparse_instance")).toMatchObject({
      frameIdx: 0,
      instanceIdx: 0,
    });
  });

  it("returns nothing for a clean project", () => {
    const fs = runLabelQc(
      mockLabels([10, 100, 100, 1], [
        frame(0, [clean(0, 0), clean(50, 50)]),
        frame(1, [clean(0, 0), clean(50, 50)]),
      ]),
    );
    expect(fs).toEqual([]);
  });
  describe("nodes not labeled (SLP format 3.0)", () => {
    const N = Number.NaN;
    /**
     * A user instance with `points` as sleap-io gives them. A node is
     * `[x, y]` (visible), "hidden" (labeled, not visible) or "unlabeled"
     * (`labeled: false`). `flag` controls whether labeled points carry an
     * explicit `labeled: true` (sleap-io.js 0.6.0) or no flag (older pins).
     */
    const withPoints = (nodes: (number[] | "hidden" | "unlabeled")[], flag = true) => {
      const points = nodes.map((n) =>
        n === "unlabeled"
          ? { xy: [N, N], visible: false, complete: false, labeled: false }
          : n === "hidden"
            ? { xy: [N, N], visible: false, complete: false, ...(flag ? { labeled: true } : {}) }
            : { xy: n, visible: true, complete: true, ...(flag ? { labeled: true } : {}) },
      );
      return { numpy: () => points.map((p) => (p.visible ? [...p.xy] : [N, N])), points };
    };
    const instFindings = (fs: QcFinding[]) =>
      fs.filter((f) => f.kind === "sparse_instance" || f.kind === "empty_instance");

    it("a partly annotated instance is not sparse", () => {
      const fs = runLabelQc(
        mockLabels(null, [
          frame(0, [withPoints([[1, 1], "unlabeled", "unlabeled", "unlabeled"]), clean(50, 50)]),
        ]),
      );
      expect(instFindings(fs)).toEqual([]);
    });

    it("hidden labeled nodes still count, and the message says of how many", () => {
      const fs = runLabelQc(
        mockLabels(null, [frame(0, [withPoints([[1, 1], "hidden", "unlabeled", "unlabeled"])])]),
      );
      expect(instFindings(fs)).toHaveLength(1);
      expect(fs.find((f) => f.kind === "sparse_instance")).toMatchObject({
        instanceIdx: 0,
        message: "Only 1 of 2 labeled node(s) visible",
      });
    });

    it("an instance with no labeled node is reported empty, not sparse", () => {
      const fs = runLabelQc(
        mockLabels(null, [frame(3, [withPoints(["unlabeled", "unlabeled"]), clean(50, 50)])]),
      );
      expect(instFindings(fs)).toHaveLength(1);
      expect(fs.find((f) => f.kind === "empty_instance")).toMatchObject({
        frameIdx: 3,
        instanceIdx: 0,
        message: "Instance has no labeled nodes",
      });
    });

    it("with every node labeled, results match the plain arrays", () => {
      const cases: (number[] | "hidden")[][] = [
        [[1, 1]],
        [[1, 1], "hidden", "hidden"],
        ["hidden", "hidden"],
        [[1, 1], [5, 5]],
      ];
      for (const flag of [true, false]) {
        for (const nodes of cases) {
          const plain = inst(nodes.map((n) => (n === "hidden" ? [N, N] : n)));
          const before = runLabelQc(mockLabels(null, [frame(0, [plain, clean(50, 50)])]));
          const after = runLabelQc(
            mockLabels(null, [frame(0, [withPoints(nodes, flag), clean(50, 50)])]),
          );
          expect(after).toEqual(before);
        }
      }
      const sparse = runLabelQc(mockLabels(null, [frame(0, [withPoints([[1, 1], "hidden"])])]));
      expect(sparse.find((f) => f.kind === "sparse_instance")?.message).toBe(
        "Only 1 visible node(s)",
      );
      const empty = runLabelQc(mockLabels(null, [frame(0, [withPoints(["hidden"])])]));
      expect(empty.find((f) => f.kind === "empty_instance")?.message).toBe(
        "Instance has no visible nodes",
      );
    });
  });
});
