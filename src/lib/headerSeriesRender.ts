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
  // Degenerate / flat series (no variation, e.g. an all-zero series): sit on
  // the baseline instead of pinning every point to the top edge. Without this,
  // min === max maps to y=0 (top), reading as a misleading full-height line.
  if (max <= min) {
    return () => height - 1;
  }
  const seriesMin = min - 1;
  const denom = max - seriesMin;
  const scale = denom === 0 ? 0 : height / denom;
  return (val: number) => height - (val - seriesMin) * scale;
}

/**
 * Draw an auto-scaled polyline of the series onto the header canvas.
 * X maps frameIdx across width; Y via makeToYPos. Mirrors the QPainterPath
 * polyline in slider.py:882-894 (smooth line, step_chart=False).
 */
export function drawHeaderSeries(
  ctx: CanvasRenderingContext2D,
  series: Map<number, number>,
  totalFrames: number,
  width: number,
  height: number,
): void {
  if (series.size === 0 || totalFrames <= 1) return;
  const { buckets, min, max } = downsampleSeries(series, width);
  const toY = makeToYPos(min, max, height);
  const frameToX = (f: number) => (f / (totalFrames - 1)) * width;

  ctx.strokeStyle = "rgba(100, 149, 237, 0.8)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  let started = false;
  for (const [frame, val] of buckets) {
    const x = frameToX(frame);
    const y = toY(val);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();
}
