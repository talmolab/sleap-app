/**
 * Canvas draw helpers for the seekbar header stat graph.
 * Ports the downsample-bucketing and autoscaling math from
 * sleap/gui/widgets/slider.py:_draw_header (852-894).
 */

/** Result of downsampling a frame->value series to a target pixel width. */
export interface DownsampledSeries {
  step: number;
  buckets: Map<number, number>; // keyed by (bucketIndex * step)
  min: number;
  max: number;
}

/**
 * Downsample a {frameIdx: value} series to roughly `width` buckets,
 * taking the max value in each bucket (slider.py:860-870).
 */
export function downsampleSeries(
  series: Map<number, number>,
  width: number,
): DownsampledSeries {
  let seriesFrameMax = 0;
  for (const k of series.keys()) if (k > seriesFrameMax) seriesFrameMax = k;

  // numFrames = highest index + 1 so the final frame is covered (slider.py uses
  // max(keys) but then drops the last frame; we keep it — see plan Task 5).
  const numFrames = seriesFrameMax + 1;
  const step = Math.max(1, Math.ceil(numFrames / Math.max(1, Math.floor(width))));

  const buckets = new Map<number, number>();
  let min = Infinity;
  let max = -Infinity;
  for (let start = 0; start <= seriesFrameMax; start += step) {
    let bucketMax = 0;
    for (let f = start; f < start + step; f++) {
      const v = series.get(f);
      if (v !== undefined && v > bucketMax) bucketMax = v;
    }
    buckets.set(start, bucketMax);
    if (bucketMax < min) min = bucketMax;
    if (bucketMax > max) max = bucketMax;
  }
  if (!isFinite(min)) min = 0;
  if (!isFinite(max)) max = 0;
  return { step, buckets, min, max };
}

/**
 * Build the value->Y mapping. Ports slider.py toYPos (877-878):
 * seriesMin = min - 1; scale = height / (max - seriesMin).
 * Larger values sit higher (smaller Y).
 */
export function makeToYPos(
  min: number,
  max: number,
  height: number,
): (val: number) => number {
  const seriesMin = min - 1;
  const denom = max - seriesMin;
  const scale = denom === 0 ? 0 : height / denom;
  return (val: number) => height - (val - seriesMin) * scale;
}
