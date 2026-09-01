import { describe, it, expect } from "../bun-test";
import { runLabelQc, type QcFinding } from "@/lib/analyze/labelQc";

const inst = (points: number[][]) => ({ numpy: () => points });
const clean = (ox: number, oy: number) => inst([[ox, oy], [ox + 5, oy + 5]]);
const frame = (frameIdx: number, instances: unknown[], isNegative = false) => ({
  frameIdx,
  instances,
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

  it("returns nothing for a clean project", () => {
    const fs = runLabelQc(
      mockLabels([10, 100, 100, 1], [
        frame(0, [clean(0, 0), clean(50, 50)]),
        frame(1, [clean(0, 0), clean(50, 50)]),
      ]),
    );
    expect(fs).toEqual([]);
  });
});
