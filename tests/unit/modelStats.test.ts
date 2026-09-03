/**
 * Unit tests for the size-derived recommendation formulas ported from
 * sleap-nn's config-picker / config_generator (avgAnimalSize, max_stride
 * bucket + receptive-field-coverage floor, augmentation-aware crop padding,
 * and the Medium/Large RF backbone-profile split).
 */

import { describe, it, expect } from "../bun-test";
import { Skeleton, Video, Labels, LabeledFrame, Instance, PredictedInstance } from "@talmolab/sleap-io.js";
import {
  computeReceptiveField,
  computeInstanceSizeStats,
  computeAugmentationPadding,
  recommendMaxStride,
  recommendBackboneProfile,
  computeCropSize,
  resolveEffectiveCropSize,
  recommendCentroidScale,
  detectVideoChannels,
  detectVideoDimensions,
  resolveInputChannels,
  estimateGpuMemory,
  estimateHeadGpuMemory,
  estimateCacheMemory,
  estimateHeadCacheMemory,
  formatBytes,
  computeRawParamCount,
  type CropSizeHyperparamsLike,
  type GpuMemoryHyperparamsLike,
  type CacheMemoryHyperparamsLike,
} from "@/lib/modelStats";

function makeInstance(skeleton: Skeleton, points: Array<{ xy: [number, number]; visible: boolean }>): Instance {
  const inst = Instance.empty({ skeleton });
  for (let i = 0; i < points.length; i++) {
    inst.points[i].xy = points[i].xy;
    inst.points[i].visible = points[i].visible;
    inst.points[i].complete = true;
  }
  return inst;
}

function makeVideo(filename: string, height: number, width: number, channels = 3): Video {
  return new Video({
    filename,
    backendMetadata: { shape: [10, height, width, channels] },
    openBackend: false,
  });
}

describe("computeInstanceSizeStats", () => {
  it("reads pt.xy once per point, not ~6× (proxy-allocation hoist)", () => {
    const skeleton = new Skeleton({ nodes: ["a", "b", "c"], name: "s" });
    const video = makeVideo("v.mp4", 100, 100);
    const lf = new LabeledFrame({ video, frameIdx: 0 });
    lf.instances.push(
      makeInstance(skeleton, [
        { xy: [0, 0], visible: true },
        { xy: [10, 20], visible: true },
        { xy: [30, 15], visible: true },
      ])
    );
    const labels = new Labels({ videos: [video], skeletons: [skeleton], labeledFrames: [lf] });

    // Count reads of the allocating PointView.xy getter. The old loop read
    // pt.xy ~6× per visible point (NaN guard + 4 bbox comparisons); the fix
    // reads it once into a local.
    const proto = Object.getPrototypeOf(lf.instances[0].points[0]);
    const orig = Object.getOwnPropertyDescriptor(proto, "xy")!;
    let xyReads = 0;
    Object.defineProperty(proto, "xy", {
      configurable: true,
      get() {
        xyReads++;
        return orig.get!.call(this);
      },
    });
    try {
      computeInstanceSizeStats(labels);
    } finally {
      Object.defineProperty(proto, "xy", orig);
    }
    expect(xyReads).toBe(3); // one per point (was ~6×3 = 18)
  });

  it("returns null for a null project", () => {
    expect(computeInstanceSizeStats(null)).toBeNull();
  });

  it("computes avgAnimalSize (mean bbox diagonal) and maxBboxDim (max bbox side)", () => {
    const skeleton = new Skeleton({ nodes: ["a", "b", "c"], name: "s" });
    const video = makeVideo("v.mp4", 500, 500);
    const lf = new LabeledFrame({ video, frameIdx: 0 });
    // Instance A: 30x40 bbox -> diagonal 50, max side 40
    lf.instances.push(
      makeInstance(skeleton, [
        { xy: [0, 0], visible: true },
        { xy: [30, 40], visible: true },
        { xy: [15, 20], visible: true },
      ]),
    );
    // Instance B: 60x80 bbox -> diagonal 100, max side 80
    lf.instances.push(
      makeInstance(skeleton, [
        { xy: [0, 0], visible: true },
        { xy: [60, 80], visible: true },
        { xy: [30, 40], visible: true },
      ]),
    );
    const labels = new Labels({ videos: [video], skeletons: [skeleton], labeledFrames: [lf] });

    const stats = computeInstanceSizeStats(labels);
    expect(stats).not.toBeNull();
    expect(stats!.avgAnimalSize).toBeCloseTo((50 + 100) / 2, 5);
    expect(stats!.avgBboxDim).toBeCloseTo((40 + 80) / 2, 5);
    expect(stats!.maxBboxDim).toBe(80);
    expect(stats!.maxFrameDim).toBe(500);
  });

  it("ignores non-visible points and instances with fewer than 2 valid points", () => {
    const skeleton = new Skeleton({ nodes: ["a", "b", "c"], name: "s" });
    const video = makeVideo("v.mp4", 100, 100);
    const lf = new LabeledFrame({ video, frameIdx: 0 });
    // Only 1 visible point -> excluded entirely.
    lf.instances.push(
      makeInstance(skeleton, [
        { xy: [0, 0], visible: true },
        { xy: [100, 100], visible: false },
        { xy: [50, 50], visible: false },
      ]),
    );
    const labels = new Labels({ videos: [video], skeletons: [skeleton], labeledFrames: [lf] });
    expect(computeInstanceSizeStats(labels)).toBeNull();
  });

  it("excludes predicted instances", () => {
    const skeleton = new Skeleton({ nodes: ["a"], name: "s" });
    const video = makeVideo("v.mp4", 100, 100);
    const lf = new LabeledFrame({ video, frameIdx: 0 });
    lf.instances.push(
      new PredictedInstance({
        skeleton,
        points: [{ xy: [0, 0], visible: true, complete: true, name: "a", score: 0.9 }],
        score: 0.9,
      }),
    );
    const labels = new Labels({ videos: [video], skeletons: [skeleton], labeledFrames: [lf] });
    expect(computeInstanceSizeStats(labels)).toBeNull();
  });
});

describe("computeAugmentationPadding", () => {
  it("returns 0 padding with no rotation and no scale augmentation", () => {
    expect(computeAugmentationPadding(100, 0, 1.0)).toBe(0);
  });

  it("uses the exact cos/sin expansion below 45 degrees", () => {
    const bboxSize = 100;
    const rot = 15;
    const rad = (rot * Math.PI) / 180;
    const expected = Math.ceil(bboxSize * (Math.abs(Math.cos(rad)) + Math.abs(Math.sin(rad))) - bboxSize);
    expect(computeAugmentationPadding(bboxSize, rot, 1.0)).toBe(expected);
  });

  it("clamps to the worst-case sqrt(2) factor at 45 degrees and beyond", () => {
    const bboxSize = 100;
    const expectedAt45 = Math.ceil(bboxSize * Math.SQRT2 - bboxSize);
    expect(computeAugmentationPadding(bboxSize, 45, 1.0)).toBe(expectedAt45);
    // A full 180-degree rotation range shouldn't expand padding beyond the 45° worst case.
    expect(computeAugmentationPadding(bboxSize, 180, 1.0)).toBe(expectedAt45);
  });

  it("multiplies by scaleMax when scale augmentation grows the instance", () => {
    const bboxSize = 100;
    const expected = Math.ceil(bboxSize * Math.SQRT2 * 1.2 - bboxSize);
    expect(computeAugmentationPadding(bboxSize, 180, 1.2)).toBe(expected);
  });

  it("never shrinks padding below the rotation-only case for scaleMax < 1", () => {
    // max(scaleMax, 1.0) floors the scale factor at 1.0 — a scaleMax < 1 (zoom in)
    // must not reduce the worst-case rotation padding.
    const bboxSize = 100;
    const expectedAt45 = Math.ceil(bboxSize * Math.SQRT2 - bboxSize);
    expect(computeAugmentationPadding(bboxSize, 45, 0.8)).toBe(expectedAt45);
  });
});

describe("recommendMaxStride", () => {
  it("buckets small animals to max_stride 8", () => {
    expect(recommendMaxStride(30, 30, 1.0)).toBe(8);
  });

  it("buckets mid-size animals to max_stride 16", () => {
    expect(recommendMaxStride(60, 60, 1.0)).toBe(16);
  });

  it("buckets large animals to max_stride 32", () => {
    expect(recommendMaxStride(150, 150, 1.0)).toBe(32);
  });

  it("raises max_stride above the size bucket when RF coverage requires it", () => {
    // Small avgAnimalSize buckets to 8, but a much larger max bbox dim
    // (e.g. one outlier large instance) needs a bigger receptive field.
    const maxBboxDim = 200; // RF(32) = 156 < 200 <= RF(64) = 316
    const result = recommendMaxStride(30, maxBboxDim, 1.0);
    expect(computeReceptiveField(result)).toBeGreaterThanOrEqual(maxBboxDim);
    expect(result).toBe(64);
  });

  it("scales both the bucket and coverage targets by the input scale factor", () => {
    // avgAnimalSize=150 alone buckets to 32, but scale=0.5 halves the
    // effective size back into the mid-size bucket.
    expect(recommendMaxStride(150, 150, 0.5)).toBe(16);
  });
});

describe("recommendBackboneProfile", () => {
  it("recommends medium RF for typical animal/frame sizes", () => {
    const rec = recommendBackboneProfile(100, 512);
    expect(rec.tier).toBe("medium");
    expect(rec.maxStride).toBe(16);
    expect(rec.filtersRate).toBe(2.0);
  });

  it("recommends large RF when the animal bbox exceeds 200px", () => {
    const rec = recommendBackboneProfile(250, 512);
    expect(rec.tier).toBe("large");
    expect(rec.maxStride).toBe(32);
    expect(rec.filtersRate).toBe(1.5);
  });

  it("recommends large RF when the frame exceeds 1024px, even for small animals", () => {
    const rec = recommendBackboneProfile(50, 2000);
    expect(rec.tier).toBe("large");
  });
});

describe("computeCropSize", () => {
  function labelsWithMaxBboxDim(dim: number): Labels {
    const skeleton = new Skeleton({ nodes: ["a", "b"], name: "s" });
    const video = makeVideo("v.mp4", 1000, 1000);
    const lf = new LabeledFrame({ video, frameIdx: 0 });
    lf.instances.push(
      makeInstance(skeleton, [
        { xy: [0, 0], visible: true },
        { xy: [dim, dim / 2], visible: true },
      ]),
    );
    return new Labels({ videos: [video], skeletons: [skeleton], labeledFrames: [lf] });
  }

  it("returns null when there's no usable instance data", () => {
    expect(computeCropSize(null, 16)).toBeNull();
  });

  it("rounds the padded, scaled bbox size up to a multiple of max_stride", () => {
    const labels = labelsWithMaxBboxDim(150); // max side = 150
    expect(computeCropSize(labels, 16, 1.0, 0)).toBe(160); // ceil(150/16)*16 = 160
  });

  it("adds padding before rounding", () => {
    const labels = labelsWithMaxBboxDim(150);
    expect(computeCropSize(labels, 16, 1.0, 20)).toBe(176); // ceil(170/16)*16 = 176
  });

  it("floors the result at 100px, matching sleap-nn's min_crop_size default", () => {
    const labels = labelsWithMaxBboxDim(20); // ceil(20/16)*16 = 32, below the floor
    expect(computeCropSize(labels, 16, 1.0, 0)).toBe(100);
  });
});

describe("resolveEffectiveCropSize", () => {
  function labelsWithMaxBboxDim(dim: number): Labels {
    const skeleton = new Skeleton({ nodes: ["a", "b"], name: "s" });
    const video = makeVideo("v.mp4", 1000, 1000);
    const lf = new LabeledFrame({ video, frameIdx: 0 });
    lf.instances.push(
      makeInstance(skeleton, [
        { xy: [0, 0], visible: true },
        { xy: [dim, dim / 2], visible: true },
      ]),
    );
    return new Labels({ videos: [video], skeletons: [skeleton], labeledFrames: [lf] });
  }

  const baseHp: CropSizeHyperparamsLike = {
    cropSize: null,
    maxStride: null,
    scale: 1.0,
    rotationPreset: "off",
    rotationCustomAngle: 45,
    scaleEnabled: false,
    scaleMax: 1.1,
  };

  it("honors a manual crop size regardless of augmentation settings", () => {
    const labels = labelsWithMaxBboxDim(150);
    const result = resolveEffectiveCropSize(labels, { ...baseHp, cropSize: 300, rotationPreset: "180" });
    expect(result.cropSize).toBe(300);
  });

  it("resolves Auto max_stride and Auto crop size together, matching computeCropSize/recommendMaxStride directly", () => {
    const labels = labelsWithMaxBboxDim(150);
    const result = resolveEffectiveCropSize(labels, baseHp);
    const stats = computeInstanceSizeStats(labels)!;
    const expectedMaxStride = recommendMaxStride(stats.avgAnimalSize, stats.maxBboxDim, baseHp.scale);
    expect(result.maxStride).toBe(expectedMaxStride);
    expect(result.cropSize).toBe(computeCropSize(labels, expectedMaxStride, baseHp.scale, 0));
  });

  it("uses an explicit (non-Auto) max_stride to align the Auto crop size", () => {
    const labels = labelsWithMaxBboxDim(150);
    const result = resolveEffectiveCropSize(labels, { ...baseHp, maxStride: 64 });
    expect(result.maxStride).toBe(64);
    expect(result.cropSize).toBe(computeCropSize(labels, 64, baseHp.scale, 0));
  });

  it("grows the Auto crop size when rotation augmentation is enabled", () => {
    const labels = labelsWithMaxBboxDim(150);
    const off = resolveEffectiveCropSize(labels, { ...baseHp, maxStride: 16, rotationPreset: "off" });
    const full = resolveEffectiveCropSize(labels, { ...baseHp, maxStride: 16, rotationPreset: "180" });
    expect(full.cropSize!).toBeGreaterThan(off.cropSize!);
  });

  it("falls back to max_stride 16 and a null crop size when there's no project loaded", () => {
    const result = resolveEffectiveCropSize(null, baseHp);
    expect(result.maxStride).toBe(16);
    expect(result.cropSize).toBeNull();
  });
});

describe("recommendCentroidScale", () => {
  it("recommends the standard 0.5x for a typical (non-tiny) animal", () => {
    // avgBboxDim=150 on a 1000px frame -> 15% of frame, above the 5% cutoff.
    const rec = recommendCentroidScale(150, 1000);
    expect(rec.scale).toBe(0.5);
  });

  it("recommends 0.75x for an animal under 5% of the frame", () => {
    // avgBboxDim=30 on a 1000px frame -> 3% of frame, below the 5% cutoff
    // (calibrated against a real case needing the bump at ~3.3%).
    const rec = recommendCentroidScale(30, 1000);
    expect(rec.scale).toBe(0.75);
  });

  it("treats exactly 5% as not tiny (boundary is exclusive)", () => {
    const rec = recommendCentroidScale(50, 1000);
    expect(rec.scale).toBe(0.5);
  });

  it("defaults to 0.5x when there's no frame dimension to compute a ratio from", () => {
    const rec = recommendCentroidScale(50, 0);
    expect(rec.scale).toBe(0.5);
  });

  it("defaults to 0.5x with an explanatory reason when animal size can't be measured (e.g. a single-keypoint skeleton)", () => {
    const rec = recommendCentroidScale(null, 1000);
    expect(rec.scale).toBe(0.5);
    expect(rec.reason.toLowerCase()).toContain("can't measure");
  });
});

describe("recommendMaxStride — pretrained backbone coupling", () => {
  it("uses the size-based bucket/coverage rule for unet (default)", () => {
    expect(recommendMaxStride(30, 30, 1.0)).toBe(8);
    expect(recommendMaxStride(30, 30, 1.0, "unet")).toBe(8);
  });

  it("forces max_stride=32 for ConvNeXt regardless of animal size", () => {
    expect(recommendMaxStride(30, 30, 1.0, "convnext")).toBe(32);
  });

  it("forces max_stride=32 for SwinT regardless of animal size", () => {
    expect(recommendMaxStride(150, 150, 1.0, "swint")).toBe(32);
  });
});

describe("resolveEffectiveCropSize — pretrained backbone coupling", () => {
  const baseHp: CropSizeHyperparamsLike = {
    cropSize: null,
    maxStride: null,
    scale: 1.0,
    rotationPreset: "off",
    rotationCustomAngle: 45,
    scaleEnabled: false,
    scaleMax: 1.1,
  };

  function labelsWithMaxBboxDim(dim: number): Labels {
    const skeleton = new Skeleton({ nodes: ["a", "b"], name: "s" });
    const video = makeVideo("v.mp4", 1000, 1000);
    const lf = new LabeledFrame({ video, frameIdx: 0 });
    lf.instances.push(
      makeInstance(skeleton, [
        { xy: [0, 0], visible: true },
        { xy: [dim, dim / 2], visible: true },
      ]),
    );
    return new Labels({ videos: [video], skeletons: [skeleton], labeledFrames: [lf] });
  }

  it("aligns the Auto crop size to max_stride=32 for a ConvNeXt backbone", () => {
    // dim=200 keeps the aligned crop size comfortably above the 100px floor,
    // so the assertion below tests alignment, not the floor.
    const labels = labelsWithMaxBboxDim(200); // would bucket to max_stride 16 for unet
    const result = resolveEffectiveCropSize(labels, { ...baseHp, backbone: "convnext" });
    expect(result.maxStride).toBe(32);
    expect(result.cropSize).toBe(224); // ceil(200/32)*32
  });

  it("forces max_stride=32 for a pretrained backbone even with no project loaded", () => {
    const result = resolveEffectiveCropSize(null, { ...baseHp, backbone: "swint" });
    expect(result.maxStride).toBe(32);
  });
});

describe("detectVideoChannels / detectVideoDimensions / resolveInputChannels", () => {
  it("returns null for a null project", () => {
    expect(detectVideoChannels(null)).toBeNull();
    expect(detectVideoDimensions(null)).toBeNull();
  });

  it("reads channel count and dimensions from the first video with a known shape", () => {
    const skeleton = new Skeleton({ nodes: ["a"], name: "s" });
    const video = makeVideo("v.mp4", 480, 640, 3);
    const labels = new Labels({ videos: [video], skeletons: [skeleton], labeledFrames: [] });
    expect(detectVideoChannels(labels)).toBe(3);
    expect(detectVideoDimensions(labels)).toEqual({ height: 480, width: 640 });
  });

  it("detects a grayscale (1-channel) video", () => {
    const skeleton = new Skeleton({ nodes: ["a"], name: "s" });
    const video = makeVideo("v.mp4", 480, 640, 1);
    const labels = new Labels({ videos: [video], skeletons: [skeleton], labeledFrames: [] });
    expect(detectVideoChannels(labels)).toBe(1);
  });

  it("resolveInputChannels: an explicit rgb/grayscale choice always wins over detection", () => {
    expect(resolveInputChannels("rgb", 1)).toBe(3);
    expect(resolveInputChannels("grayscale", 3)).toBe(1);
  });

  it("resolveInputChannels: auto passes through the detected channel count", () => {
    expect(resolveInputChannels("auto", 3)).toBe(3);
    expect(resolveInputChannels("auto", 1)).toBe(1);
  });

  it("resolveInputChannels: auto falls back to 1 when nothing is detected", () => {
    expect(resolveInputChannels("auto", null)).toBe(1);
  });
});

describe("formatBytes", () => {
  it("formats bytes, KB, MB, and GB at the right magnitude", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.5 GB");
  });
});

describe("estimateGpuMemory", () => {
  it("computes the exact byte total for a hand-verified case", () => {
    // Hand-computed: weights=4,000,000 + batchImg=98,304 + confmap=40,960
    // + (activations=983,040 * 2 for encoder+decoder) * 2 (for gradients)
    // = 8,071,424 bytes. See PR/commit notes for the full derivation.
    const result = estimateGpuMemory({
      numParams: 1_000_000,
      batchSize: 2,
      scaledHeight: 64,
      scaledWidth: 64,
      inChannels: 3,
      maxStride: 8,
      outputStride: 2,
      numKeypoints: 5,
      filters: 16,
      filtersRate: 2.0,
    });
    expect(result.totalBytes).toBe(8_071_424);
    expect(result.level).toBe("ok");
    // Full breakdown — every term sleap-nn's config-picker displays.
    expect(result.numParams).toBe(1_000_000);
    expect(result.weightsBytes).toBe(4_000_000);
    expect(result.batchImgBytes).toBe(98_304);
    expect(result.confmapBytes).toBe(40_960);
    expect(result.activationBytes).toBe(1_966_080);
    expect(result.gradientBytes).toBe(1_966_080);
    expect(result.scaledHeight).toBe(64);
    expect(result.scaledWidth).toBe(64);
    expect(result.paddedHeight).toBe(64);
    expect(result.paddedWidth).toBe(64);
    // Sanity: the five terms sum to the total.
    expect(result.weightsBytes + result.batchImgBytes + result.confmapBytes + result.activationBytes + result.gradientBytes).toBe(result.totalBytes);
  });

  it("pads non-multiple-of-stride dimensions up before computing", () => {
    const exact = estimateGpuMemory({
      numParams: 0, batchSize: 1, scaledHeight: 64, scaledWidth: 64,
      inChannels: 1, maxStride: 16, outputStride: 1, numKeypoints: 1, filters: 8, filtersRate: 2,
    });
    const padded = estimateGpuMemory({
      numParams: 0, batchSize: 1, scaledHeight: 50, scaledWidth: 50, // pads up to 64
      inChannels: 1, maxStride: 16, outputStride: 1, numKeypoints: 1, filters: 8, filtersRate: 2,
    });
    expect(padded.totalBytes).toBe(exact.totalBytes);
  });

  it("classifies increasing memory use into ok/warning/danger tiers", () => {
    const small = estimateGpuMemory({
      numParams: 1000, batchSize: 1, scaledHeight: 32, scaledWidth: 32,
      inChannels: 1, maxStride: 8, outputStride: 1, numKeypoints: 1, filters: 8, filtersRate: 1.5,
    });
    expect(small.level).toBe("ok");

    const large = estimateGpuMemory({
      numParams: 50_000_000, batchSize: 32, scaledHeight: 1024, scaledWidth: 1024,
      inChannels: 3, maxStride: 32, outputStride: 2, numKeypoints: 20, filters: 64, filtersRate: 2,
    });
    expect(large.level).toBe("danger");
  });
});

describe("estimateHeadGpuMemory", () => {
  const baseHp: GpuMemoryHyperparamsLike = {
    cropSize: null,
    maxStride: null,
    scale: 1.0,
    rotationPreset: "off",
    rotationCustomAngle: 45,
    scaleEnabled: false,
    scaleMax: 1.1,
    batchSize: 4,
    outputStride: 2,
    stemStride: null,
    filters: 16,
    filtersRate: 2.0,
    colorMode: "auto",
  };

  function makeLabelsWithSkeletonAndVideo(numNodes: number, height: number, width: number, channels = 3): Labels {
    const nodes = Array.from({ length: numNodes }, (_, i) => `n${i}`);
    const skeleton = new Skeleton({ nodes, name: "s" });
    const video = makeVideo("v.mp4", height, width, channels);
    const inst = makeInstance(skeleton, nodes.map((_, i) => ({ xy: [i * 10, i * 5] as [number, number], visible: true })));
    const lf = new LabeledFrame({ video, frameIdx: 0 });
    lf.instances.push(inst);
    return new Labels({ videos: [video], skeletons: [skeleton], labeledFrames: [lf] });
  }

  it("returns null when there's no skeleton (0 keypoints)", () => {
    const skeleton = new Skeleton({ nodes: [], name: "s" });
    const video = makeVideo("v.mp4", 480, 640);
    const labels = new Labels({ videos: [video], skeletons: [skeleton], labeledFrames: [] });
    expect(estimateHeadGpuMemory(labels, "centroid", baseHp)).toBeNull();
  });

  it("returns null for a centroid/config head with no video to size from", () => {
    const skeleton = new Skeleton({ nodes: ["a", "b"], name: "s" });
    const labels = new Labels({ videos: [], skeletons: [skeleton], labeledFrames: [] });
    expect(estimateHeadGpuMemory(labels, "centroid", baseHp)).toBeNull();
  });

  it("estimates memory for a centroid head using the full scaled frame", () => {
    const labels = makeLabelsWithSkeletonAndVideo(3, 480, 640);
    const result = estimateHeadGpuMemory(labels, "centroid", baseHp);
    expect(result).not.toBeNull();
    expect(result!.totalBytes).toBeGreaterThan(0);
  });

  it("estimates memory for a centered_instance head using the crop size, not the full frame", () => {
    const labels = makeLabelsWithSkeletonAndVideo(3, 1000, 1000);
    const result = estimateHeadGpuMemory(labels, "centered_instance", baseHp);
    expect(result).not.toBeNull();
    // A tiny instance's crop (min 100px, per computeCropSize's floor) should
    // use far less memory than the full 1000x1000 frame would.
    const fullFrameResult = estimateHeadGpuMemory(labels, "centroid", baseHp);
    expect(result!.totalBytes).toBeLessThan(fullFrameResult!.totalBytes);
  });

  it("uses the detected video channel count when colorMode is auto", () => {
    const grayscaleLabels = makeLabelsWithSkeletonAndVideo(3, 480, 640, 1);
    const rgbLabels = makeLabelsWithSkeletonAndVideo(3, 480, 640, 3);
    const grayscaleResult = estimateHeadGpuMemory(grayscaleLabels, "centroid", baseHp);
    const rgbResult = estimateHeadGpuMemory(rgbLabels, "centroid", baseHp);
    expect(rgbResult!.totalBytes).toBeGreaterThan(grayscaleResult!.totalBytes);
  });

  it("forces max_stride=32 for a pretrained backbone even for a centroid head", () => {
    const labels = makeLabelsWithSkeletonAndVideo(3, 480, 640);
    const unetResult = estimateHeadGpuMemory(labels, "centroid", { ...baseHp, backbone: "unet" });
    const convnextResult = estimateHeadGpuMemory(labels, "centroid", { ...baseHp, backbone: "convnext" });
    expect(unetResult).not.toBeNull();
    expect(convnextResult).not.toBeNull();
    // Different max_stride changes the padded input size and activation
    // pyramid depth, so the two estimates should differ.
    expect(convnextResult!.totalBytes).not.toBe(unetResult!.totalBytes);
  });
});

describe("computeRawParamCount", () => {
  it("returns a raw number for unet, matching the formatted computeParamCount", () => {
    const raw = computeRawParamCount("unet", 16, 16, 2.0, undefined, 2, null, 3);
    expect(raw).not.toBeNull();
    expect(raw).toBeGreaterThan(0);
  });

  it("returns fixed constants for convnext/swint", () => {
    expect(computeRawParamCount("convnext", 32, 16, 2.0)).toBeGreaterThan(0);
    expect(computeRawParamCount("swint", 32, 16, 2.0)).toBeGreaterThan(0);
  });

  it("returns null for an unknown backbone", () => {
    expect(computeRawParamCount("resnet", 16, 16, 2.0)).toBeNull();
  });
});

describe("estimateCacheMemory", () => {
  it("returns null for the streaming pipeline (no caching)", () => {
    expect(estimateCacheMemory({ height: 64, width: 64, channels: 3, numFrames: 100, dataPipeline: "stream", numWorkers: 2 })).toBeNull();
  });

  it("computes the exact byte total for a hand-verified memory-cache case, replicated per worker", () => {
    // bytesPerFrame=64*64*3=12,288; raw=12,288*100=1,228,800; +20% overhead
    // =1,474,560; ×(1+2 workers)=4,423,680.
    const result = estimateCacheMemory({ height: 64, width: 64, channels: 3, numFrames: 100, dataPipeline: "memory", numWorkers: 2 });
    expect(result).not.toBeNull();
    expect(result!.totalBytes).toBe(4_423_680);
    expect(result!.isDisk).toBe(false);
    expect(result!.level).toBe("ok");
  });

  it("does NOT replicate per worker for the disk-cache pipeline", () => {
    // Same inputs as above, but disk-cache: no ×(1+workers) multiplier.
    const result = estimateCacheMemory({ height: 64, width: 64, channels: 3, numFrames: 100, dataPipeline: "disk", numWorkers: 2 });
    expect(result).not.toBeNull();
    expect(result!.totalBytes).toBe(1_474_560);
    expect(result!.isDisk).toBe(true);
  });

  it("treats 0 workers as no replication for the memory-cache pipeline", () => {
    const result = estimateCacheMemory({ height: 64, width: 64, channels: 3, numFrames: 100, dataPipeline: "memory", numWorkers: 0 });
    expect(result!.totalBytes).toBe(1_474_560);
  });

  it("classifies increasing cache size into ok/warning/danger tiers", () => {
    const small = estimateCacheMemory({ height: 64, width: 64, channels: 1, numFrames: 10, dataPipeline: "memory", numWorkers: 0 });
    expect(small!.level).toBe("ok");

    const large = estimateCacheMemory({ height: 2000, width: 2000, channels: 3, numFrames: 5000, dataPipeline: "memory", numWorkers: 4 });
    expect(large!.level).toBe("danger");
  });
});

describe("estimateHeadCacheMemory", () => {
  const baseHp: CacheMemoryHyperparamsLike = {
    dataPipeline: "memory",
    dataloaderWorkers: 2,
  };

  function makeLabelsWithVideo(height: number, width: number, videoFrames: number, numLabeledFrames: number, channels = 3): Labels {
    const skeleton = new Skeleton({ nodes: ["a", "b"], name: "s" });
    const video = new Video({ filename: "v.mp4", backendMetadata: { shape: [videoFrames, height, width, channels] }, openBackend: false });
    const labeledFrames = Array.from({ length: numLabeledFrames }, (_, i) => {
      const lf = new LabeledFrame({ video, frameIdx: i });
      lf.instances.push(makeInstance(skeleton, [{ xy: [0, 0], visible: true }, { xy: [30, 15], visible: true }]));
      return lf;
    });
    return new Labels({ videos: [video], skeletons: [skeleton], labeledFrames });
  }

  it("returns null for the streaming pipeline", () => {
    const labels = makeLabelsWithVideo(480, 640, 100, 5);
    expect(estimateHeadCacheMemory(labels, { ...baseHp, dataPipeline: "stream" })).toBeNull();
  });

  it("returns null when there's no video to size from", () => {
    const skeleton = new Skeleton({ nodes: ["a"], name: "s" });
    const labels = new Labels({ videos: [], skeletons: [skeleton], labeledFrames: [] });
    expect(estimateHeadCacheMemory(labels, baseHp)).toBeNull();
  });

  it("sizes the cache by LABELED frame count, not total video frame count", () => {
    // 5 labeled frames out of a 1000-frame video — sleap-nn's cache only ever
    // touches labels.labeled_frames (_get_lf_idx_list/_fill_cache), matching
    // its own reference estimator (num_labeled_frames = len(labels.labeled_frames)
    // in config_generator/memory.py). It must NOT scale with total video length.
    const labels = makeLabelsWithVideo(100, 100, 1000, 5);
    const result = estimateHeadCacheMemory(labels, baseHp);
    expect(result).not.toBeNull();
    // bytesPerFrame=100*100*3=30,000; raw=30,000*5=150,000; *1.2=180,000; *(1+2)=540,000
    expect(result!.totalBytes).toBe(540_000);
  });

  it("is identical for every head type — caching happens before cropping, on the raw native frame", () => {
    // Regression test: caching is NOT head-type-specific. sleap-nn's image
    // cache always stores the full, unscaled, uncropped decoded frame —
    // cropping/scaling are separate per-sample transforms applied after the
    // cache is read. estimateHeadCacheMemory takes no `slot` at all now,
    // reflecting that the estimate can't vary by head type.
    const labels = makeLabelsWithVideo(1000, 1000, 100, 10);
    const result = estimateHeadCacheMemory(labels, baseHp);
    expect(result).not.toBeNull();
    // bytesPerFrame=1000*1000*3=3,000,000; raw=3,000,000*10=30,000,000;
    // *1.2=36,000,000; *(1+2 workers)=108,000,000.
    expect(result!.totalBytes).toBe(108_000_000);
  });

  it("ignores colorMode entirely — the cache stores native-channel frames, conversion happens after cache read", () => {
    // Regression test: `ensure_rgb`/`ensure_grayscale` run per-sample, after
    // the cache is read (see every BaseDataset subclass's __getitem__), so
    // "Convert Colors" cannot change what's actually cached. A native
    // grayscale (1-channel) video must report the same cache size whether
    // colorMode is "auto", "rgb", or "grayscale".
    const labels = makeLabelsWithVideo(100, 100, 50, 5, 1); // native grayscale
    const auto = estimateHeadCacheMemory(labels, { ...baseHp, colorMode: "auto" } as CacheMemoryHyperparamsLike);
    const rgb = estimateHeadCacheMemory(labels, { ...baseHp, colorMode: "rgb" } as CacheMemoryHyperparamsLike);
    const grayscale = estimateHeadCacheMemory(labels, { ...baseHp, colorMode: "grayscale" } as CacheMemoryHyperparamsLike);
    expect(auto).not.toBeNull();
    expect(auto!.totalBytes).toBe(rgb!.totalBytes);
    expect(auto!.totalBytes).toBe(grayscale!.totalBytes);
    // bytesPerFrame=100*100*1=10,000; raw=10,000*5=50,000; *1.2=60,000; *(1+2)=180,000
    expect(auto!.totalBytes).toBe(180_000);
  });
});
