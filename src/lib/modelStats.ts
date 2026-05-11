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

// ── Crop Size ───────────────────────────────────────────────────────

export function computeCropSize(
  labels: Labels | null,
  maxStride: number,
  scale: number = 1.0,
  padding: number = 0,
): number | null {
  if (!labels) return null;

  let maxLength = 0;

  for (const lf of labels.labeledFrames) {
    for (const inst of lf.instances) {
      const pts = inst.points;
      if (!pts || pts.length === 0) continue;

      let xMin = Infinity, xMax = -Infinity;
      let yMin = Infinity, yMax = -Infinity;
      let hasValid = false;

      for (const pt of pts) {
        const x = pt.xy[0];
        const y = pt.xy[1];
        if (isNaN(x) || isNaN(y)) continue;
        hasValid = true;
        if (x < xMin) xMin = x;
        if (x > xMax) xMax = x;
        if (y < yMin) yMin = y;
        if (y > yMax) yMax = y;
      }

      if (!hasValid) continue;

      const diffX = xMax - xMin;
      const diffY = yMax - yMin;
      const length = Math.max(diffX, diffY);
      if (length > maxLength) maxLength = length;
    }
  }

  if (maxLength === 0) return null;

  maxLength += padding;
  maxLength *= scale;
  return Math.ceil(maxLength / maxStride) * maxStride;
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
  if (backbone === "unet") {
    const count = computeUNetParamCount(maxStride, filters, filtersRate, 2, 3, true, inputChannels, outputStride, stemStride);
    return formatParamCount(count);
  }
  if (backbone === "convnext") {
    const count = CONVNEXT_PARAMS[modelType ?? "tiny"] ?? CONVNEXT_PARAMS.tiny;
    return formatParamCount(count);
  }
  if (backbone === "swint") {
    const count = SWINT_PARAMS[modelType ?? "tiny"] ?? SWINT_PARAMS.tiny;
    return formatParamCount(count);
  }
  return "Unknown";
}

function formatParamCount(count: number): string {
  if (count >= 1_000_000) return `~${(count / 1_000_000).toFixed(2)}M`;
  if (count >= 1_000) return `~${(count / 1_000).toFixed(1)}K`;
  return `${count}`;
}
