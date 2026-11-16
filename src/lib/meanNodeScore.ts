/**
 * View ▸ Show Mean Node Score: the average per-node confidence of an
 * instance, shown as a column in the Instances panel.
 *
 * Matches PyQt SLEAP's Instances dock (`dataviews.py`): the mean of the
 * point scores over nodes that have a position (non-NaN x/y), ignoring
 * NaN scores. Unlike the instance score (the model's whole-instance
 * confidence), this says how sure the model was about the nodes it placed.
 */
export function meanNodeScore(
  points: ReadonlyArray<{ xy: [number, number]; score?: number }>,
): number | null {
  let sum = 0;
  let n = 0;
  for (const p of points) {
    const s = p.score;
    if (s === undefined || Number.isNaN(s)) continue;
    if (Number.isNaN(p.xy[0]) || Number.isNaN(p.xy[1])) continue;
    sum += s;
    n++;
  }
  return n > 0 ? sum / n : null;
}
