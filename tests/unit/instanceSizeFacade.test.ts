import { describe, it, expect } from "../bun-test";
import { collectSizedInstances } from "@/lib/analyze/instanceSize";

const inst = (points: number[][]) => ({ numpy: () => points });
const frame = (frameIdx: number, instances: ReturnType<typeof inst>[]) => ({ frameIdx, instances });

// Duck-typed Labels: only .videos + .find({video}) are used by the facade.
function mockLabels(videos: object[], framesByVideo: Map<object, unknown[]>) {
  return { videos, find: ({ video }: { video: object }) => framesByVideo.get(video) ?? [] };
}

describe("collectSizedInstances", () => {
  it("collects size + video/frame/instance refs across videos", () => {
    const vA = { name: "A" };
    const vB = { name: "B" };
    const framesByVideo = new Map<object, unknown[]>([
      [vA, [frame(3, [inst([[0, 0], [40, 10]]), inst([[0, 0], [5, 5]])])]], // sizes 40, 5
      [vB, [frame(7, [inst([[0, 0], [0, 20]])])]], // size 20
    ]);
    const out = collectSizedInstances(mockLabels([vA, vB], framesByVideo) as never);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ size: 40, rawWidth: 40, rawHeight: 10, videoIdx: 0, frameIdx: 3, instanceIdx: 0 });
    expect(out[1]).toMatchObject({ size: 5, videoIdx: 0, frameIdx: 3, instanceIdx: 1 });
    expect(out[2]).toMatchObject({ size: 20, videoIdx: 1, frameIdx: 7, instanceIdx: 0 });
    expect(out[0].video as unknown).toBe(vA);
  });

  it("skips instances with no visible points, keeping the original instance index", () => {
    const v = {};
    const framesByVideo = new Map<object, unknown[]>([
      [v, [frame(0, [inst([[Number.NaN, Number.NaN]]), inst([[1, 1], [2, 3]])])]],
    ]);
    const out = collectSizedInstances(mockLabels([v], framesByVideo) as never);
    expect(out).toHaveLength(1);
    expect(out[0].instanceIdx).toBe(1);
  });
});
