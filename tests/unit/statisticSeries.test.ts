import { describe, it, expect } from "../bun-test";
import { GRAPH_SPECS, getGraphSpec } from "@/lib/statisticSeries";

describe("GRAPH_SPECS", () => {
  it("includes none, instance-count, and 12 legacy stats", () => {
    const types = GRAPH_SPECS.map((s) => s.type);
    expect(types).toContain("none");
    expect(types).toContain("instance-count");
    expect(types).toContain("point-displacement");
    expect(types).toContain("min-centroid-proximity");
    expect(types).toContain("tracking-score");
  });
  it("getGraphSpec returns the spec for a type", () => {
    expect(getGraphSpec("tracking-score")?.reductions).toContain("mean");
    expect(getGraphSpec("tracking-score")?.reductions).toContain("min");
  });
  it("instance-count and point-count have no reductions; min-centroid-proximity none", () => {
    expect(getGraphSpec("instance-count")?.reductions).toEqual([]);
    expect(getGraphSpec("point-count")?.reductions).toEqual([]);
    expect(getGraphSpec("min-centroid-proximity")?.reductions).toEqual([]);
  });
});
