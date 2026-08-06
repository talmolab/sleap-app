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
  // seriesMin = min - 1 gives a one-unit bottom buffer (headroom) so the lowest
  // value never sits exactly on the baseline — PyQt's slider.py toYPos trick
  // (series_min = min - 1). Consequence: a flat series (min === max, e.g. an
  // all-zero Primary-Point-Displacement over untracked data) maps its value to
  // the TOP = a full bar, exactly matching PyQt, which does NOT special-case
  // flat series. denom = max - (min - 1) = max - min + 1 >= 1, never zero.
  const seriesMin = min - 1;
  const scale = height / (max - seriesMin);
  return (val: number) => height - (val - seriesMin) * scale;
}

/**
 * Frame-index spacing for header tick marks / gridlines. Ports PyQt
 * slider.py:_add_tick_marks (674-689): 10 for short videos, otherwise the
 * smallest of 10/100/1000/… that keeps the tick count at or below `maxTicks`.
 * So a 300-frame video ticks every 100 (markers at 100/200/300).
 */
export function frameTickInterval(totalFrames: number, maxTicks = 24): number {
  if (totalFrames < 20) return 10;
  for (const step of [10, 100, 1000, 10000, 100000]) {
    if (totalFrames / step <= maxTicks) return step;
  }
  return 1000000;
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

  // Top-edge points in frame order.
  const pts: Array<[number, number]> = [];
  for (const [frame, val] of buckets) pts.push([frameToX(frame), toY(val)]);
  if (pts.length === 0) return;

  // Filled area under the curve, anchored down to the baseline — PyQt fills the
  // polygon under the series (slider.py _draw_header), not just a stroked line.
  ctx.fillStyle = "rgba(100, 149, 237, 0.4)";
  ctx.beginPath();
  ctx.moveTo(pts[0][0], height);
  for (const [x, y] of pts) ctx.lineTo(x, y);
  ctx.lineTo(pts[pts.length - 1][0], height);
  ctx.closePath();
  ctx.fill();

  // Stroke the top edge over the fill.
  ctx.strokeStyle = "rgba(100, 149, 237, 0.9)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.stroke();
}
