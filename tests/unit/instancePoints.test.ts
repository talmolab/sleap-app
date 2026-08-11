import { describe, it, expect } from "../bun-test";
import { Instance, Skeleton } from "@talmolab/sleap-io.js";
import { instanceNamedPoints } from "@/lib/instancePoints";

function makeSkeleton(): Skeleton {
  return new Skeleton({ nodes: ["head", "thorax", "abdomen"] });
}

describe("instanceNamedPoints", () => {
  it("pairs each point with its skeleton node name in point order", () => {
    const skeleton = makeSkeleton();
    const inst = Instance.fromArray(
      [
        [10, 20],
        [30, 40],
        [50, 60],
      ],
      skeleton,
    );
    const named = instanceNamedPoints(inst);
    expect(named.map((p) => p.name)).toEqual(["head", "thorax", "abdomen"]);
    expect(named[0]).toMatchObject({ name: "head", x: 10, y: 20, visible: true });
    expect(named[2]).toMatchObject({ name: "abdomen", x: 50, y: 60 });
  });

  it("marks non-visible points as not visible (matches np.nan copy handling)", () => {
    const skeleton = makeSkeleton();
    const inst = Instance.fromArray(
      [
        [10, 20],
        [30, 40],
        [50, 60],
      ],
      skeleton,
    );
    // Mutate the middle point to invisible via the live PointView setter.
    inst.points[1].visible = false;
    const named = instanceNamedPoints(inst);
    expect(named[0].visible).toBe(true);
    expect(named[1].visible).toBe(false);
    expect(named[1].name).toBe("thorax");
    expect(named[2].visible).toBe(true);
  });
});
