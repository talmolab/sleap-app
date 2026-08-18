import { describe, it, expect } from "../bun-test";
import {
  Instance,
  Labels,
  PredictedInstance,
  Skeleton,
  Video,
  LabeledFrame,
  Track,
} from "@talmolab/sleap-io.js";
import { placeInstance, findNearestPriorFrame } from "@/lib/instancePlacement";

function makeSkeleton(): Skeleton {
  return new Skeleton({ nodes: ["A", "B"], name: "test" });
}

function makeVideo(): Video {
  return new Video({ filename: "test.mp4", openBackend: false });
}

function makeInstance(
  skeleton: Skeleton,
  coords: number[][],
  track?: Track | null
): Instance {
  const inst = Instance.fromArray(coords, skeleton);
  if (track !== undefined) inst.track = track;
  return inst;
}

function makePredicted(
  skeleton: Skeleton,
  coords: number[][],
  track?: Track | null
): PredictedInstance {
  const inst = PredictedInstance.fromArray(coords, skeleton, 0.9);
  if (track !== undefined) inst.track = track;
  return inst;
}

function makeLabeledFrame(
  video: Video,
  frameIdx: number,
  instances: Instance[]
): LabeledFrame {
  const lf = new LabeledFrame({ video, frameIdx });
  lf.instances = instances;
  return lf;
}

describe("placePriorFrame", () => {
  const skeleton = makeSkeleton();
  const video = makeVideo();
  const trackA = new Track("A");
  const trackB = new Track("B");
  const trackC = new Track("C");

  it("copies points and track from the prior frame user instance", () => {
    const priorInst = makeInstance(skeleton, [[100, 200], [300, 400]], trackA);
    const priorFrame = makeLabeledFrame(video, 0, [priorInst]);

    const result = placeInstance("prior_frame", skeleton, video, [], priorFrame);

    expect(result.points[0].xy).toEqual([100, 200]);
    expect(result.points[1].xy).toEqual([300, 400]);
    expect(result.track).toBe(trackA);
  });

  it("skips prior instances whose track is already on the current frame", () => {
    const priorA = makeInstance(skeleton, [[10, 10], [20, 20]], trackA);
    const priorB = makeInstance(skeleton, [[50, 50], [60, 60]], trackB);
    const priorFrame = makeLabeledFrame(video, 0, [priorA, priorB]);

    const existingA = makeInstance(skeleton, [[10, 10], [20, 20]], trackA);

    const result = placeInstance(
      "prior_frame", skeleton, video, [existingA], priorFrame
    );

    expect(result.points[0].xy).toEqual([50, 50]);
    expect(result.points[1].xy).toEqual([60, 60]);
    expect(result.track).toBe(trackB);
  });

  it("falls back to first candidate when all tracks are covered", () => {
    const priorA = makeInstance(skeleton, [[10, 10], [20, 20]], trackA);
    const priorB = makeInstance(skeleton, [[50, 50], [60, 60]], trackB);
    const priorFrame = makeLabeledFrame(video, 0, [priorA, priorB]);

    const existingA = makeInstance(skeleton, [[10, 10], [20, 20]], trackA);
    const existingB = makeInstance(skeleton, [[50, 50], [60, 60]], trackB);

    const result = placeInstance(
      "prior_frame", skeleton, video, [existingA, existingB], priorFrame
    );

    expect(result.points[0].xy).toEqual([10, 10]);
  });

  it("skips multiple covered tracks to find the first unmatched", () => {
    const priorA = makeInstance(skeleton, [[10, 10], [20, 20]], trackA);
    const priorB = makeInstance(skeleton, [[30, 30], [40, 40]], trackB);
    const priorC = makeInstance(skeleton, [[50, 50], [60, 60]], trackC);
    const priorFrame = makeLabeledFrame(video, 0, [priorA, priorB, priorC]);

    const existingA = makeInstance(skeleton, [[10, 10], [20, 20]], trackA);
    const existingB = makeInstance(skeleton, [[30, 30], [40, 40]], trackB);

    const result = placeInstance(
      "prior_frame", skeleton, video, [existingA, existingB], priorFrame
    );

    expect(result.points[0].xy).toEqual([50, 50]);
    expect(result.points[1].xy).toEqual([60, 60]);
  });

  it("prefers user instances over predictions on the prior frame", () => {
    const pred = makePredicted(skeleton, [[10, 10], [20, 20]], trackA);
    const user = makeInstance(skeleton, [[99, 99], [88, 88]], trackA);
    const priorFrame = makeLabeledFrame(video, 0, [pred, user]);

    const result = placeInstance("prior_frame", skeleton, video, [], priorFrame);

    expect(result.points[0].xy).toEqual([99, 99]);
    expect(result.points[1].xy).toEqual([88, 88]);
  });

  it("falls back to predictions when no user instances exist on prior frame", () => {
    const pred = makePredicted(skeleton, [[10, 10], [20, 20]], trackA);
    const priorFrame = makeLabeledFrame(video, 0, [pred]);

    const result = placeInstance("prior_frame", skeleton, video, [], priorFrame);

    expect(result.points[0].xy).toEqual([10, 10]);
  });

  it("handles trackless instances (copies first available, no track assigned)", () => {
    const priorInst = makeInstance(skeleton, [[42, 42], [84, 84]]);
    const priorFrame = makeLabeledFrame(video, 0, [priorInst]);

    const existing = makeInstance(skeleton, [[1, 1], [2, 2]], trackA);

    const result = placeInstance(
      "prior_frame", skeleton, video, [existing], priorFrame
    );

    expect(result.points[0].xy).toEqual([42, 42]);
    expect(result.track).toBeFalsy();
  });

  it("falls back to 'best' when prior frame is null", () => {
    const result = placeInstance("prior_frame", skeleton, video, [], null);

    expect(result).toBeInstanceOf(Instance);
    expect(result.points.length).toBe(2);
  });

  it("falls back to 'best' when prior frame has no placed points", () => {
    const emptyInst = Instance.empty({ skeleton });
    const priorFrame = makeLabeledFrame(video, 0, [emptyInst]);

    const result = placeInstance("prior_frame", skeleton, video, [], priorFrame);

    expect(result).toBeInstanceOf(Instance);
  });
});

describe("template layout seeding (skeleton-builder drawn layout)", () => {
  function makeSkeleton3(): Skeleton {
    return new Skeleton({ nodes: ["A", "B", "C"], name: "t3" });
  }
  // Backend-less video: no shape (→ getFrameDims default [800, 600]) and no
  // cropRect (→ toSourceCoords identity: image coords == source coords).
  const video = makeVideo();

  it("'template' seeds the instance from the drawn layout, not the circle", () => {
    const skeleton = makeSkeleton3();
    const layout = [
      { x: 10, y: 20 },
      { x: 30, y: 40 },
      { x: 50, y: 60 },
    ];

    const result = placeInstance("template", skeleton, video, [], null, null, layout);

    expect(result.points[0].xy).toEqual([10, 20]);
    expect(result.points[1].xy).toEqual([30, 40]);
    expect(result.points[2].xy).toEqual([50, 60]);
    result.points.forEach((p) => {
      expect(p.visible).toBe(true);
      expect(p.complete).toBe(false);
    });
    // NOT the scrambled-circle default (first circle point is [430, 300]).
    expect(result.points[0].xy).not.toEqual([430, 300]);
  });

  it("'template' with no layout keeps the centered-circle default", () => {
    const skeleton = makeSkeleton3();

    const result = placeInstance("template", skeleton, video, [], null, null, null);

    // placeAtCenter: cx=400, cy=300, radius=min(800,600)*0.05=30; i=0 angle 0.
    expect(result.points[0].xy[0]).toBeCloseTo(430, 6);
    expect(result.points[0].xy[1]).toBeCloseTo(300, 6);
    // Distinctly not the drawn layout used above.
    expect(result.points[0].xy).not.toEqual([10, 20]);
  });

  it("'best' seeds from the layout then offsets from existing instances", () => {
    const skeleton = makeSkeleton3();
    const layout = [
      { x: 100, y: 100 },
      { x: 120, y: 100 },
      { x: 110, y: 120 },
    ];
    // An existing instance near the layout centroid so the offset kicks in.
    const existing = makeInstance(skeleton, [[110, 106], [110, 106], [110, 106]]);

    const result = placeInstance("best", skeleton, video, [existing], null, null, layout);

    // Seeded from the layout: the drawn RELATIVE geometry is preserved (each
    // point shares the same uniform offset), so B-A == (20, 0) as drawn — this
    // is the "seeded from the layout, not the circle" check. (The circle's
    // B-A would be ~(-45, 26).)
    const dx = result.points[1].xy[0] - result.points[0].xy[0];
    const dy = result.points[1].xy[1] - result.points[0].xy[1];
    expect(dx).toBeCloseTo(20, 6);
    expect(dy).toBeCloseTo(0, 6);
    // Landed near the drawn location (~100s), not the frame center (~400,300).
    expect(result.points[0].xy[0]).toBeLessThan(300);
  });

  it("'force_directed' seeds from the layout (no existing → layout verbatim)", () => {
    const skeleton = makeSkeleton3();
    const layout = [
      { x: 15, y: 25 },
      { x: 35, y: 45 },
      { x: 55, y: 65 },
    ];

    // With no existing instances, force_directed does no repulsion, so the
    // seeded layout survives unchanged.
    const result = placeInstance("force_directed", skeleton, video, [], null, null, layout);

    expect(result.points[0].xy).toEqual([15, 25]);
    expect(result.points[1].xy).toEqual([35, 45]);
    expect(result.points[2].xy).toEqual([55, 65]);
  });

  it("fills a null layout entry with the center-circle default (no NaN)", () => {
    // Regression (Add Instance dropped into keypoint-placement mode): a template
    // layout with an unplaced (null) entry must NOT leave that point at NaN, or
    // AddInstance would see a NaN point and call enterPlacementMode(). The null
    // slot is filled with the SAME center-circle default placeAtCenter uses.
    const skeleton = makeSkeleton3();
    const layout = [{ x: 10, y: 20 }, null, { x: 50, y: 60 }];

    const result = placeInstance("template", skeleton, video, [], null, null, layout);

    // Drawn entries keep their positions…
    expect(result.points[0].xy).toEqual([10, 20]);
    expect(result.points[2].xy).toEqual([50, 60]);
    // …and the null entry is the center-circle default for index 1
    // (cx=400, cy=300, radius=30; angle = 2π·1/3).
    expect(result.points[1].xy[0]).toBeCloseTo(385, 6);
    expect(result.points[1].xy[1]).toBeCloseTo(325.980762, 5);
    // The whole instance is fully placed (visible, no NaN) — exactly the
    // predicate AddInstance checks before entering placement mode.
    result.points.forEach((p) => {
      expect(p.visible).toBe(true);
      expect(Number.isNaN(p.xy[0])).toBe(false);
      expect(Number.isNaN(p.xy[1])).toBe(false);
    });
    const hasNaN = result.points.some(
      (p) => Number.isNaN(p.xy[0]) || Number.isNaN(p.xy[1])
    );
    expect(hasNaN).toBe(false);
  });

  it("'best' with a null layout entry also yields no NaN points", () => {
    // Copy-Prior-Frame clones the current-frame instance, so a NaN-bearing
    // template-seeded instance would propagate NaN and re-trigger placement mode.
    // Guard the "best" seed path (used by Add Instance ▸ Best) the same way.
    const skeleton = makeSkeleton3();
    const layout = [{ x: 100, y: 100 }, null, { x: 110, y: 120 }];

    const result = placeInstance("best", skeleton, video, [], null, null, layout);

    const hasNaN = result.points.some(
      (p) => Number.isNaN(p.xy[0]) || Number.isNaN(p.xy[1])
    );
    expect(hasNaN).toBe(false);
  });

  it("with a null template layout keeps the plain centered-circle default (no regression)", () => {
    // When there is NO captured layout, behavior is unchanged: placeAtCenter.
    const skeleton = makeSkeleton3();
    const result = placeInstance("template", skeleton, video, [], null, null, null);
    expect(result.points[0].xy[0]).toBeCloseTo(430, 6);
    expect(result.points[0].xy[1]).toBeCloseTo(300, 6);
  });

  it("does not seed 'random' from the layout", () => {
    const skeleton = makeSkeleton3();
    const layout = [
      { x: 10, y: 20 },
      { x: 30, y: 40 },
      { x: 50, y: 60 },
    ];

    const result = placeInstance("random", skeleton, video, [], null, null, layout);

    // random ignores the layout entirely (scatters within the frame).
    expect(result.points[0].xy).not.toEqual([10, 20]);
  });
});

describe("findNearestPriorFrame", () => {
  const video = makeVideo();
  const video2 = makeVideo();

  function makeLabels(frames: LabeledFrame[]): Labels {
    const labels = new Labels({ videos: [video, video2] });
    for (const lf of frames) labels.append(lf);
    return labels;
  }

  it("returns the nearest labeled frame before the given index", () => {
    const lf5 = makeLabeledFrame(video, 5, []);
    const lf20 = makeLabeledFrame(video, 20, []);
    const lf50 = makeLabeledFrame(video, 50, []);
    const labels = makeLabels([lf5, lf20, lf50]);

    expect(findNearestPriorFrame(labels, video, 60)).toBe(lf50);
    expect(findNearestPriorFrame(labels, video, 30)).toBe(lf20);
    expect(findNearestPriorFrame(labels, video, 10)).toBe(lf5);
  });

  it("returns null when no prior labeled frames exist", () => {
    const lf50 = makeLabeledFrame(video, 50, []);
    const labels = makeLabels([lf50]);

    expect(findNearestPriorFrame(labels, video, 50)).toBeNull();
    expect(findNearestPriorFrame(labels, video, 10)).toBeNull();
  });

  it("returns null for frameIdx 0", () => {
    const lf0 = makeLabeledFrame(video, 0, []);
    const labels = makeLabels([lf0]);

    expect(findNearestPriorFrame(labels, video, 0)).toBeNull();
  });

  it("only considers frames from the same video", () => {
    const lfV1 = makeLabeledFrame(video, 10, []);
    const lfV2 = makeLabeledFrame(video2, 40, []);
    const labels = makeLabels([lfV1, lfV2]);

    expect(findNearestPriorFrame(labels, video, 50)).toBe(lfV1);
    expect(findNearestPriorFrame(labels, video2, 50)).toBe(lfV2);
  });

  it("skips frames at or after the target index", () => {
    const lf10 = makeLabeledFrame(video, 10, []);
    const lf20 = makeLabeledFrame(video, 20, []);
    const labels = makeLabels([lf10, lf20]);

    expect(findNearestPriorFrame(labels, video, 20)).toBe(lf10);
  });
});
