import type { Labels } from "../types";

// ── Receptive Field ─────────────────────────────────────────────────

export function computeReceptiveField(
  maxStride: number,
  stemStride: number | null = null,
  kernelSize = 3,
  convsPerBlock = 2,
): number {
  const stemBlocks = stemStride ? Math.log2(stemStride) : 0;
  const downBlocks = Math.log2(maxStride) - stemBlocks;
  if (downBlocks < 1) return 1;

  let rf = 1;
  let cumulativeStride = 1;

  for (let block = 0; block < downBlocks; block++) {
    for (let conv = 0; conv < convsPerBlock; conv++) {
      rf += (kernelSize - 1) * cumulativeStride;
    }
    rf += (2 - 1) * cumulativeStride;
    cumulativeStride *= 2;
  }

  return rf;
}

// ── Instance Size Stats ──────────────────────────────────────────────
// Ported from sleap-nn's config-picker / config_generator (avgAnimalSize
// as mean bbox diagonal over visible-point extents; see
// sleap_nn/config_generator/analyzer.py::_compute_bbox_stats).

export interface InstanceSizeStats {
  /** Mean bbox diagonal (sqrt(width² + height²)) over user instances with
   *  ≥2 valid/visible points. Matches sleap-nn's `avgAnimalSize`. */
  avgAnimalSize: number;
  /** Mean bbox side (max(width, height)) over the same instance set —
   *  matches the ratio TrainingPanel's recommendPipeline already uses for
   *  "how big is the typical animal relative to the frame". */
  avgBboxDim: number;
  /** Max bbox side (max(width, height)) over the same instance set —
   *  the worst-case animal size that crop size must cover. */
  maxBboxDim: number;
  /** Max frame dimension (height or width) across all loaded videos. */
  maxFrameDim: number;
}

/** Single shared scan of a project's labeled user instances for size
 *  stats, backing computeCropSize, recommendMaxStride, and
 *  recommendBackboneProfile below. */
export function computeInstanceSizeStats(labels: Labels | null): InstanceSizeStats | null {
  if (!labels) return null;

  let maxBboxDim = 0;
  let bboxDimSum = 0;
  let diagonalSum = 0;
  let diagonalCount = 0;

  for (const lf of labels.labeledFrames) {
    for (const inst of lf.userInstances) {
      let xMin = Infinity, xMax = -Infinity;
      let yMin = Infinity, yMax = -Infinity;
      let validCount = 0;

      for (const pt of inst.points) {
        if (!pt.visible || isNaN(pt.xy[0]) || isNaN(pt.xy[1])) continue;
        validCount++;
        if (pt.xy[0] < xMin) xMin = pt.xy[0];
        if (pt.xy[0] > xMax) xMax = pt.xy[0];
        if (pt.xy[1] < yMin) yMin = pt.xy[1];
        if (pt.xy[1] > yMax) yMax = pt.xy[1];
      }
      if (validCount < 2) continue;

      const width = xMax - xMin;
      const height = yMax - yMin;
      const side = Math.max(width, height);
      if (side > maxBboxDim) maxBboxDim = side;
      bboxDimSum += side;
      diagonalSum += Math.sqrt(width * width + height * height);
      diagonalCount++;
    }
  }

  if (diagonalCount === 0) return null;

  let maxFrameDim = 0;
  for (const v of labels.videos) {
    if (v.shape) {
      const d = Math.max(v.shape[1], v.shape[2]);
      if (d > maxFrameDim) maxFrameDim = d;
    }
  }

  return {
    avgAnimalSize: diagonalSum / diagonalCount,
    avgBboxDim: bboxDimSum / diagonalCount,
    maxBboxDim,
    maxFrameDim,
  };
}

/** The channel count of the project's video(s) (e.g. 3 for RGB, 1 for
 *  grayscale), read directly from the first video with a known shape.
 *  `null` if no project/video is loaded yet. */
export function detectVideoChannels(labels: Labels | null): number | null {
  if (!labels) return null;
  for (const v of labels.videos) {
    if (v.shape && v.shape[3] != null) return v.shape[3];
  }
  return null;
}

/** The frame height/width of the project's video(s), read directly from the
 *  first video with a known shape. `null` if no project/video is loaded. */
export function detectVideoDimensions(labels: Labels | null): { height: number; width: number } | null {
  if (!labels) return null;
  for (const v of labels.videos) {
    if (v.shape) return { height: v.shape[1], width: v.shape[2] };
  }
  return null;
}

/** The number of channels the model will actually see: an explicit
 *  rgb/grayscale choice always wins; "auto" passes through the project's
 *  real video channel count (falling back to 1 if unknown). */
export function resolveInputChannels(
  colorMode: "auto" | "rgb" | "grayscale",
  detectedChannels: number | null,
): number {
  if (colorMode === "rgb") return 3;
  if (colorMode === "grayscale") return 1;
  return detectedChannels ?? 1;
}

// ── Augmentation Padding ─────────────────────────────────────────────
// Verbatim port of sleap-nn's compute_augmentation_padding: worst-case
// rotation/scale expansion of a square bbox, so a rotated/scaled instance
// isn't clipped by the crop window. See sleap_nn/data/instance_cropping.py.
// For a square bbox rotated by angle θ, the new bbox side is
// L' = L * (|cos θ| + |sin θ|), which maxes out at θ=45° where L' = L*√2 —
// used directly once the configured rotation range reaches or exceeds 45°.

export function computeAugmentationPadding(
  bboxSize: number,
  rotationMaxDeg: number,
  scaleMax: number,
): number {
  const rotationRad = (Math.min(Math.abs(rotationMaxDeg), 90) * Math.PI) / 180;
  let rotationFactor = Math.abs(Math.cos(rotationRad)) + Math.abs(Math.sin(rotationRad));
  if (Math.abs(rotationMaxDeg) >= 45) rotationFactor = Math.SQRT2;
  const expansionFactor = rotationFactor * Math.max(scaleMax, 1.0);
  return Math.ceil(bboxSize * expansionFactor - bboxSize);
}

// ── max_stride Recommendation ────────────────────────────────────────
// Ported from sleap-nn's recommend_default_max_stride (animal-size bucket)
// combined with a receptive-field-coverage floor, mirroring
// sleap_nn/config_generator/architecture_estimates.py.

const MAX_STRIDE_CANDIDATES = [8, 16, 32, 64, 128];

export function recommendMaxStride(
  avgAnimalSize: number,
  maxBboxDim: number,
  scale: number = 1.0,
  backbone: string = "unet",
): number {
  // ConvNeXt/SwinT are pretrained backbones with a fixed architecture — their
  // downsampling depth isn't adjustable the way UNet's is, so max_stride is
  // always 32 for them regardless of animal/frame size (matches sleap-nn's
  // ConvNextConfig/SwinTConfig, both hardcoded to max_stride=32).
  if (backbone && backbone !== "unet") return 32;

  const effectiveSize = avgAnimalSize * scale;
  let bucketStride: number;
  if (effectiveSize < 40) bucketStride = 8;
  else if (effectiveSize > 100) bucketStride = 32;
  else bucketStride = 16;

  const target = maxBboxDim * scale;
  let coverageStride = MAX_STRIDE_CANDIDATES[MAX_STRIDE_CANDIDATES.length - 1];
  for (const stride of MAX_STRIDE_CANDIDATES) {
    if (computeReceptiveField(stride) >= target) {
      coverageStride = stride;
      break;
    }
  }

  return Math.max(bucketStride, coverageStride);
}

// ── Backbone/RF-preset Recommendation ────────────────────────────────
// Distinct from recommendMaxStride above: this picks between the app's two
// baseline UNet profiles (Medium/Large RF), mirroring sleap-nn's coarser
// recommend_backbone rule. The two intentionally use different thresholds
// and may disagree — one drives the preset dropdown, the other drives the
// max_stride field's own Auto value.

export interface BackboneProfileRecommendation {
  tier: "medium" | "large";
  maxStride: number;
  filtersRate: number;
  reason: string;
}

export function recommendBackboneProfile(
  maxBboxDim: number,
  maxFrameDim: number,
): BackboneProfileRecommendation {
  if (maxBboxDim > 200 || maxFrameDim > 1024) {
    return {
      tier: "large",
      maxStride: 32,
      filtersRate: 1.5,
      reason:
        maxBboxDim > 200
          ? `Large animals (~${Math.round(maxBboxDim)}px bbox) need a larger receptive field`
          : `Large frames (~${Math.round(maxFrameDim)}px) need a larger receptive field`,
    };
  }
  return {
    tier: "medium",
    maxStride: 16,
    filtersRate: 2.0,
    reason: "Standard receptive field is sufficient for this data",
  };
}

// ── Centroid Input Scale Recommendation ──────────────────────────────
// Not a sleap-nn rule — a project-specific heuristic (0.5 is the standard
// centroid downsampling default; below this frame-ratio, less downsampling
// preserves enough detail for the centroid model to still localize the
// animal reliably). Calibrated against a real case needing the 0.75 bump
// at a ~3.3% frame ratio — kept comfortably above that, below the old 10%.
const CENTROID_SMALL_ANIMAL_RATIO = 0.05;

export interface CentroidScaleRecommendation {
  scale: number;
  reason: string;
}

export function recommendCentroidScale(
  avgBboxDim: number | null,
  maxFrameDim: number,
): CentroidScaleRecommendation {
  if (avgBboxDim == null || maxFrameDim <= 0) {
    return {
      scale: 0.5,
      reason: "Can't measure animal size (e.g. a single-keypoint skeleton has no bounding box) — using standard centroid downsampling",
    };
  }
  const ratio = avgBboxDim / maxFrameDim;
  if (ratio > 0 && ratio < CENTROID_SMALL_ANIMAL_RATIO) {
    return {
      scale: 0.75,
      reason: `Small animals (~${Math.round(ratio * 100)}% of frame) — less downsampling preserves detail for centroid detection`,
    };
  }
  return {
    scale: 0.5,
    reason: "Standard centroid downsampling — full resolution isn't needed just to find the animal's center",
  };
}

// ── Crop Size ───────────────────────────────────────────────────────
// Matches sleap-nn's find_instance_crop_size default floor.
const MIN_CROP_SIZE = 100;

export function computeCropSize(
  labels: Labels | null,
  maxStride: number,
  scale: number = 1.0,
  padding: number = 0,
): number | null {
  const stats = computeInstanceSizeStats(labels);
  if (!stats || stats.maxBboxDim === 0) return null;

  const padded = (stats.maxBboxDim + padding) * scale;
  const sized = Math.ceil(padded / maxStride) * maxStride;
  return Math.max(sized, MIN_CROP_SIZE);
}

/** Duck-typed subset of `ConfigHyperparams` needed to resolve the real crop
 *  size for a head — kept separate from the store's type to avoid a
 *  modelStats.ts <-> trainingStore.ts import cycle. `ConfigHyperparams`
 *  satisfies this structurally, so callers can pass `hp` directly. */
export interface CropSizeHyperparamsLike {
  cropSize: number | null;
  maxStride: number | null;
  scale: number;
  rotationPreset: "off" | "15" | "180" | "custom";
  rotationCustomAngle: number;
  scaleEnabled: boolean;
  scaleMax: number;
  /** Optional — defaults to "unet". ConvNeXt/SwinT force max_stride=32; see
   *  recommendMaxStride. */
  backbone?: string;
}

export interface EffectiveCropSize {
  /** The crop size that will actually be used (manual override, or the
   *  augmentation-padded Auto value) — `null` only if there's no usable
   *  instance data to compute an Auto value from. */
  cropSize: number | null;
  /** The max_stride that was used to align `cropSize` (manual override, or
   *  the size-derived recommendation). */
  maxStride: number;
}

/** Single source of truth for "what crop size will this head actually use"
 *  — shared by ModelStatsPreview's diagram and the Training panel's
 *  on-canvas crop preview, so both viewers always agree. */
export function resolveEffectiveCropSize(
  labels: Labels | null,
  hp: CropSizeHyperparamsLike,
): EffectiveCropSize {
  const stats = computeInstanceSizeStats(labels);
  const isPretrainedBackbone = !!hp.backbone && hp.backbone !== "unet";
  const maxStride =
    hp.maxStride ??
    (isPretrainedBackbone
      ? 32
      : stats
        ? recommendMaxStride(stats.avgAnimalSize, stats.maxBboxDim, hp.scale, hp.backbone)
        : 16);
  if (hp.cropSize != null) return { cropSize: hp.cropSize, maxStride };

  const rotationMaxDeg =
    hp.rotationPreset === "off" ? 0
    : hp.rotationPreset === "custom" ? hp.rotationCustomAngle
    : Number(hp.rotationPreset);
  const scaleMaxForPadding = hp.scaleEnabled ? hp.scaleMax : 1.0;
  const padding = stats ? computeAugmentationPadding(stats.maxBboxDim, rotationMaxDeg, scaleMaxForPadding) : 0;
  return { cropSize: computeCropSize(labels, maxStride, hp.scale, padding), maxStride };
}

// ── Parameter Count (UNet) ──────────────────────────────────────────
// Ported from sleap/gui/learning/unet_utils.py compute_unet_params()

function conv2dParams(inChannels: number, outChannels: number, kernelSize: number): number {
  return inChannels * outChannels * kernelSize * kernelSize + outChannels;
}

export function computeUNetParamCount(
  maxStride: number,
  filters: number,
  filtersRate: number,
  convsPerBlock = 2,
  kernelSize = 3,
  middleBlock = true,
  inputChannels = 1,
  outputStride = 1,
  stemStride: number | null = null,
  upInterpolate = true,
): number {
  const stemBlocks = stemStride ? Math.log2(stemStride) : 0;
  const downBlocks = Math.log2(maxStride) - stemBlocks;
  const upBlocks = Math.log2(maxStride / outputStride) + stemBlocks;
  const blockContraction = false;
  let totalParams = 0;

  // Encoder — track channels at each stride level
  const encoderChannelsAtStride: Record<number, number> = {};
  let currentStride = stemStride ?? 1;
  for (let blockIdx = 0; blockIdx < downBlocks; blockIdx++) {
    const blockFilters = Math.floor(filters * Math.pow(filtersRate, blockIdx + stemBlocks));
    const hasPool = (blockIdx + stemBlocks) > 0;
    if (hasPool) currentStride *= 2;

    let blockPrevFilters: number;
    if (blockIdx === 0) {
      blockPrevFilters = stemBlocks > 0
        ? Math.floor(filters * Math.pow(filtersRate, stemBlocks - 1))
        : inputChannels;
    } else {
      blockPrevFilters = Math.floor(filters * Math.pow(filtersRate, blockIdx + stemBlocks - 1));
    }

    for (let j = 0; j < convsPerBlock; j++) {
      const convIn = j === 0 ? blockPrevFilters : blockFilters;
      totalParams += conv2dParams(convIn, blockFilters, kernelSize);
    }
    encoderChannelsAtStride[currentStride] = blockFilters;
  }

  const lastEncoderFilters = Math.floor(filters * Math.pow(filtersRate, downBlocks + stemBlocks - 1));
  currentStride *= 2;

  // Middle block
  let prevBlockOut = lastEncoderFilters;
  if (middleBlock) {
    const expandFilters = Math.floor(filters * Math.pow(filtersRate, downBlocks + stemBlocks));
    if (convsPerBlock > 1) {
      for (let j = 0; j < convsPerBlock - 1; j++) {
        const convIn = j === 0 ? lastEncoderFilters : expandFilters;
        totalParams += conv2dParams(convIn, expandFilters, kernelSize);
      }
      const contractFilters = blockContraction
        ? Math.floor(filters * Math.pow(filtersRate, downBlocks + stemBlocks - 1))
        : expandFilters;
      totalParams += conv2dParams(expandFilters, contractFilters, kernelSize);
      prevBlockOut = contractFilters;
    } else {
      totalParams += conv2dParams(lastEncoderFilters, lastEncoderFilters, kernelSize);
      prevBlockOut = lastEncoderFilters;
    }
  }

  // Decoder — set initial prev_block_out from contraction result
  if (blockContraction) {
    prevBlockOut = Math.floor(filters * Math.pow(filtersRate, downBlocks + stemBlocks - 1));
  } else {
    prevBlockOut = Math.floor(filters * Math.pow(filtersRate, downBlocks + stemBlocks));
  }

  for (let blockIdx = 0; blockIdx < upBlocks; blockIdx++) {
    let blockFiltersOut: number;
    if (blockContraction) {
      blockFiltersOut = Math.floor(filters * Math.pow(filtersRate, Math.max(0, downBlocks + stemBlocks - 2 - blockIdx)));
    } else {
      blockFiltersOut = Math.floor(filters * Math.pow(filtersRate, Math.max(0, downBlocks + stemBlocks - 1 - blockIdx)));
    }

    const nextStride = currentStride / 2;
    const hasSkip = blockIdx < downBlocks + stemBlocks;

    // Transposed conv (if not using bilinear interpolation)
    let upsampledChannels: number;
    if (!upInterpolate) {
      totalParams += conv2dParams(prevBlockOut, blockFiltersOut, kernelSize);
      upsampledChannels = blockFiltersOut;
    } else {
      upsampledChannels = prevBlockOut;
    }

    // Skip connection
    let refineInChannels: number;
    if (hasSkip) {
      let skipChannels = encoderChannelsAtStride[nextStride];
      if (skipChannels == null) {
        skipChannels = Math.floor(filters * Math.pow(filtersRate, Math.max(0, downBlocks + stemBlocks - 1 - blockIdx)));
      }
      refineInChannels = upsampledChannels + skipChannels;
    } else {
      refineInChannels = upsampledChannels;
    }

    // Refinement convolutions
    for (let j = 0; j < convsPerBlock; j++) {
      const convIn = j === 0 ? refineInChannels : blockFiltersOut;
      totalParams += conv2dParams(convIn, blockFiltersOut, kernelSize);
    }

    prevBlockOut = blockFiltersOut;
    currentStride = nextStride;
  }

  return totalParams;
}

const CONVNEXT_PARAMS: Record<string, number> = {
  tiny: 28_600_000,
  small: 50_200_000,
  base: 88_500_000,
  large: 197_800_000,
};

const SWINT_PARAMS: Record<string, number> = {
  tiny: 28_300_000,
  small: 49_600_000,
  base: 87_800_000,
};

/** Raw parameter count (not formatted) — shared by computeParamCount's
 *  display string and the GPU memory estimate, which needs the actual
 *  number to size the weights tensor. */
export function computeRawParamCount(
  backbone: string,
  maxStride: number,
  filters: number,
  filtersRate: number,
  modelType?: string,
  outputStride = 1,
  stemStride: number | null = null,
  inputChannels = 1,
): number | null {
  if (backbone === "unet") {
    return computeUNetParamCount(maxStride, filters, filtersRate, 2, 3, true, inputChannels, outputStride, stemStride);
  }
  if (backbone === "convnext") {
    return CONVNEXT_PARAMS[modelType ?? "tiny"] ?? CONVNEXT_PARAMS.tiny;
  }
  if (backbone === "swint") {
    return SWINT_PARAMS[modelType ?? "tiny"] ?? SWINT_PARAMS.tiny;
  }
  return null;
}

export function computeParamCount(
  backbone: string,
  maxStride: number,
  filters: number,
  filtersRate: number,
  modelType?: string,
  outputStride = 1,
  stemStride: number | null = null,
  inputChannels = 1,
): string {
  const count = computeRawParamCount(backbone, maxStride, filters, filtersRate, modelType, outputStride, stemStride, inputChannels);
  return count == null ? "Unknown" : formatParamCount(count);
}

export function formatParamCount(count: number): string {
  if (count >= 1_000_000) return `~${(count / 1_000_000).toFixed(2)}M`;
  if (count >= 1_000) return `~${(count / 1_000).toFixed(1)}K`;
  return `${count}`;
}

// ── GPU Memory Estimate ───────────────────────────────────────────────
// Ported from sleap-nn's config_generator/memory.py::estimate_memory (the
// Python surface — used as ground truth over the web picker's JS twin,
// which has a bug: it omits input channels from the batch-image term).
// fp32 (4 bytes/value) throughout; no mixed-precision variant.

export type GpuMemoryLevel = "ok" | "warning" | "danger";

export interface GpuMemoryEstimate {
  totalBytes: number;
  level: GpuMemoryLevel;
  message: string;
  /** Full term-by-term breakdown, matching sleap-nn's config-picker display
   *  (params/weights/batch images/activations/confmaps/gradients, plus the
   *  scaled and stride-padded input size). */
  numParams: number;
  weightsBytes: number;
  batchImgBytes: number;
  activationBytes: number;
  confmapBytes: number;
  gradientBytes: number;
  scaledHeight: number;
  scaledWidth: number;
  paddedHeight: number;
  paddedWidth: number;
}

export function estimateGpuMemory(opts: {
  numParams: number;
  batchSize: number;
  /** Height/width actually fed to the model, i.e. after Input Scaling —
   *  the full (scaled) frame for centroid/single-instance/bottom-up heads,
   *  or crop size (already in scaled-image pixels) for centered-instance. */
  scaledHeight: number;
  scaledWidth: number;
  inChannels: number;
  maxStride: number;
  outputStride: number;
  numKeypoints: number;
  filters: number;
  filtersRate: number;
}): GpuMemoryEstimate {
  const { numParams, batchSize, scaledHeight, scaledWidth, inChannels, maxStride, outputStride, numKeypoints, filters, filtersRate } = opts;

  const hPadded = Math.ceil(scaledHeight / maxStride) * maxStride;
  const wPadded = Math.ceil(scaledWidth / maxStride) * maxStride;

  const BYTES_PER_VALUE = 4; // fp32
  const weightsBytes = numParams * BYTES_PER_VALUE;
  const batchImgBytes = batchSize * hPadded * wPadded * inChannels * BYTES_PER_VALUE;

  const confmapH = hPadded / outputStride;
  const confmapW = wPadded / outputStride;
  const confmapBytes = batchSize * confmapH * confmapW * numKeypoints * BYTES_PER_VALUE;

  // Sum of encoder feature-map activations across every down-block (0
  // through down_blocks inclusive — the input-resolution block through the
  // bottleneck), then doubled to account for the decoder's mirrored
  // activations; gradients during backprop are approximated as equal to
  // the activations they were computed from.
  const downBlocks = Math.log2(maxStride);
  let activationBytes = 0;
  let h = hPadded, w = wPadded, f = filters;
  for (let i = 0; i <= downBlocks; i++) {
    activationBytes += batchSize * h * w * f * BYTES_PER_VALUE;
    h = Math.ceil(h / 2);
    w = Math.ceil(w / 2);
    f = Math.floor(f * filtersRate);
  }
  activationBytes *= 2; // encoder + decoder
  const gradientBytes = activationBytes;

  const totalBytes = weightsBytes + batchImgBytes + confmapBytes + activationBytes + gradientBytes;
  const totalMB = totalBytes / (1024 * 1024);

  let level: GpuMemoryLevel;
  let message: string;
  if (totalMB < 4000) {
    level = "ok";
    message = "Should fit on most GPUs (8GB+)";
  } else if (totalMB < 8000) {
    level = "warning";
    message = "May require 12GB+ GPU";
  } else {
    level = "danger";
    message = "Requires 16GB+ GPU or reduce batch_size/scale";
  }

  return {
    totalBytes,
    level,
    message,
    numParams,
    weightsBytes,
    batchImgBytes,
    activationBytes,
    confmapBytes,
    gradientBytes,
    scaledHeight,
    scaledWidth,
    paddedHeight: hPadded,
    paddedWidth: wPadded,
  };
}

/** Formats a byte count as a human-readable size (e.g. "1.3 GB"). */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** Duck-typed subset of `ConfigHyperparams` needed for a per-head GPU
 *  memory estimate — see estimateHeadGpuMemory. */
export interface GpuMemoryHyperparamsLike extends CropSizeHyperparamsLike {
  batchSize: number;
  outputStride: number;
  stemStride: number | null;
  filters: number;
  filtersRate: number;
  colorMode: "auto" | "rgb" | "grayscale";
}

/** Estimates GPU memory for one head config, resolving the same effective
 *  max_stride/crop_size/input-channels every other viewer (ModelStatsPreview,
 *  the on-canvas preview) already agrees on. `slot === "centered_instance"`
 *  is the only head type that actually trains on a crop rather than the
 *  full (scaled) frame. Returns `null` if there isn't enough project data
 *  to size the input (no video, or no skeleton to count keypoints from). */
/** Resolves the actual (scaled) input height/width and max_stride a head
 *  trains on — the full scaled frame for every head except
 *  centered_instance, which trains on a (square) crop. Shared by the GPU
 *  and cache memory estimates so both agree with everything else
 *  (ModelStatsPreview, the on-canvas preview) on these values. */
function resolveHeadInputSize(
  labels: Labels | null,
  slot: string,
  hp: CropSizeHyperparamsLike,
): { scaledHeight: number; scaledWidth: number; maxStride: number } | null {
  if (slot === "centered_instance") {
    const resolved = resolveEffectiveCropSize(labels, hp);
    if (resolved.cropSize == null) return null;
    return { scaledHeight: resolved.cropSize, scaledWidth: resolved.cropSize, maxStride: resolved.maxStride };
  }
  const dims = detectVideoDimensions(labels);
  if (!dims) return null;
  const stats = computeInstanceSizeStats(labels);
  const isPretrainedBackbone = !!hp.backbone && hp.backbone !== "unet";
  const maxStride =
    hp.maxStride ??
    (isPretrainedBackbone
      ? 32
      : stats
        ? recommendMaxStride(stats.avgAnimalSize, stats.maxBboxDim, hp.scale, hp.backbone)
        : 16);
  return { scaledHeight: dims.height * hp.scale, scaledWidth: dims.width * hp.scale, maxStride };
}

export function estimateHeadGpuMemory(
  labels: Labels | null,
  slot: string,
  hp: GpuMemoryHyperparamsLike,
): GpuMemoryEstimate | null {
  const numKeypoints = labels?.skeletons?.[0]?.nodes?.length ?? 0;
  if (numKeypoints === 0) return null;

  const inChannels = resolveInputChannels(hp.colorMode, detectVideoChannels(labels));

  const resolved = resolveHeadInputSize(labels, slot, hp);
  if (!resolved) return null;
  const { scaledHeight, scaledWidth, maxStride } = resolved;

  const numParams = computeRawParamCount(
    hp.backbone || "unet",
    maxStride,
    hp.filters,
    hp.filtersRate,
    undefined,
    hp.outputStride,
    hp.stemStride,
    inChannels,
  );
  if (numParams == null) return null;

  return estimateGpuMemory({
    numParams,
    batchSize: hp.batchSize,
    scaledHeight,
    scaledWidth,
    inChannels,
    maxStride,
    outputStride: hp.outputStride,
    numKeypoints,
    filters: hp.filters,
    filtersRate: hp.filtersRate,
  });
}

// ── Image Cache Memory Estimate ──────────────────────────────────────
// A SEPARATE estimate from GPU memory above — this is CPU/system RAM (or
// disk, for the disk-cache pipeline), not VRAM. Ported from sleap-nn's
// config-picker updateCacheMemoryEstimate/updateCICacheMemoryEstimate
// (app.html) — only the memory-cache pipeline replicates the cache across
// dataloader workers; disk-cache doesn't, and the streaming pipeline
// ("stream") doesn't cache at all, so this returns null for it.

export interface CacheMemoryEstimate {
  totalBytes: number;
  /** Disk-cache is reported as disk space, not RAM, and doesn't get a
   *  ok/warning/danger RAM judgment — sleap-nn always shows it as a plain,
   *  neutral "X disk" figure. */
  isDisk: boolean;
  level: GpuMemoryLevel;
  message: string;
}

export function estimateCacheMemory(opts: {
  height: number;
  width: number;
  channels: number;
  numFrames: number;
  dataPipeline: "stream" | "memory" | "disk";
  numWorkers: number;
}): CacheMemoryEstimate | null {
  if (opts.dataPipeline === "stream") return null; // no caching — nothing to estimate

  const bytesPerFrame = opts.height * opts.width * opts.channels;
  const rawBytes = bytesPerFrame * opts.numFrames;
  const CACHE_OVERHEAD_FACTOR = 1.2; // matches sleap-nn's flat 20% overhead allowance
  const withOverhead = rawBytes * CACHE_OVERHEAD_FACTOR;

  if (opts.dataPipeline === "disk") {
    return { totalBytes: withOverhead, isDisk: true, level: "ok", message: "disk" };
  }

  // Memory-cache: each dataloader worker process gets its own copy of the cache.
  const totalBytes = opts.numWorkers > 0 ? withOverhead * (1 + opts.numWorkers) : withOverhead;
  const totalGB = totalBytes / 1024 ** 3;
  let level: GpuMemoryLevel;
  let message: string;
  if (totalGB < 4) {
    level = "ok";
    message = "RAM";
  } else if (totalGB < 8) {
    level = "warning";
    message = "RAM — consider disk cache or fewer workers";
  } else {
    level = "danger";
    message = "RAM — consider disk cache or fewer workers";
  }
  return { totalBytes, isDisk: false, level, message };
}

/** Duck-typed subset of `ConfigHyperparams` needed for a per-head cache
 *  memory estimate — see estimateHeadCacheMemory. Deliberately does NOT
 *  extend CropSizeHyperparamsLike: unlike GPU memory, the cache doesn't
 *  care about crop size, max_stride, or scale at all (see below). It also
 *  deliberately excludes `colorMode` — see estimateHeadCacheMemory. */
export interface CacheMemoryHyperparamsLike {
  dataPipeline: "stream" | "memory" | "disk";
  dataloaderWorkers: number;
}

/** Estimates image-cache memory for one head config. Unlike GPU memory,
 *  this is IDENTICAL for every head type (centroid, centered_instance,
 *  single_instance, bottomup): sleap-nn's image cache always stores the
 *  raw, native-resolution, unscaled, uncropped decoded frame — cropping
 *  and `Input Scaling` are separate transforms applied per-sample AFTER
 *  the cache is read, not before it's written. (Verified directly against
 *  sleap-nn's `BaseDataset._fill_cache*`, shared by every dataset subclass,
 *  and cross-checked against the web picker's own CI-vs-centroid cache
 *  formula, which uses the same project-level frame dimensions for both.)
 *  For the same reason, the cache always uses the video's NATIVE channel
 *  count — never `hp.colorMode` — because `ensure_rgb`/`ensure_grayscale`
 *  conversion also happens per-sample, after the cache is read (see
 *  `__getitem__` in every `BaseDataset` subclass); the "Convert Colors"
 *  setting cannot change what's cached. The number of frames actually
 *  cached is the number of LABELED frames, not every frame in the video —
 *  `_get_lf_idx_list`/`_fill_cache` only ever touch `labels.labeled_frames`,
 *  matching sleap-nn's own reference estimator
 *  (`config_generator/memory.py::estimate_memory`, which sizes the cache
 *  from `stats.num_labeled_frames = len(labels.labeled_frames)`). Returns
 *  `null` if there isn't enough project data, or the pipeline doesn't
 *  cache at all ("stream"). */
export function estimateHeadCacheMemory(
  labels: Labels | null,
  hp: CacheMemoryHyperparamsLike,
): CacheMemoryEstimate | null {
  if (hp.dataPipeline === "stream") return null;
  if (!labels) return null;

  const dims = detectVideoDimensions(labels);
  if (!dims) return null;
  const inChannels = detectVideoChannels(labels) ?? 1;

  return estimateCacheMemory({
    height: dims.height,
    width: dims.width,
    channels: inChannels,
    numFrames: labels.labeledFrames.length,
    dataPipeline: hp.dataPipeline,
    numWorkers: hp.dataloaderWorkers,
  });
}
