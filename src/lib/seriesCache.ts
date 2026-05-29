/**
 * Per-(video, graph, reduction) result cache for the seekbar header series.
 *
 * Satisfies issue #105 AC2 ("switching graph types is < 100ms after the first
 * compute (cached)"): once a (graph, reduction) series is computed for the
 * current video + label revision, re-selecting it returns the cached result
 * instantly instead of recomputing. The whole cache is invalidated when the
 * video changes or labels are edited (the `overlay` token, bumped via
 * appStore.overlayVersion), so it never serves stale data — preserving AC3.
 *
 * Pure (no React) so it is trivially unit-testable; the component holds one
 * instance in a ref and shares it across the sync and worker compute paths.
 */

export interface SeriesCache {
  /** Identity of the data the cache is valid for. */
  token: { video: unknown; overlay: number };
  /** key = `${graph}|${reduction}` → computed series. */
  map: Map<string, Map<number, number>>;
}

export function createSeriesCache(): SeriesCache {
  return { token: { video: null, overlay: -1 }, map: new Map() };
}

/** Clear the cache if the (video, overlay) it was built for has changed. */
function ensureToken(cache: SeriesCache, video: unknown, overlay: number): void {
  if (cache.token.video !== video || cache.token.overlay !== overlay) {
    cache.token = { video, overlay };
    cache.map.clear();
  }
}

/**
 * Return the cached series for `key`, computing and storing it on a miss.
 * Used by the synchronous (main-thread) compute path.
 */
export function getOrComputeSeries(
  cache: SeriesCache,
  video: unknown,
  overlay: number,
  key: string,
  compute: () => Map<number, number>,
): Map<number, number> {
  ensureToken(cache, video, overlay);
  const hit = cache.map.get(key);
  if (hit) return hit;
  const computed = compute();
  cache.map.set(key, computed);
  return computed;
}

/** Look up a cached series without computing (used by the worker path). */
export function peekSeries(
  cache: SeriesCache,
  video: unknown,
  overlay: number,
  key: string,
): Map<number, number> | undefined {
  ensureToken(cache, video, overlay);
  return cache.map.get(key);
}

/** Store a series computed elsewhere (e.g. a Web Worker response). */
export function putSeries(
  cache: SeriesCache,
  video: unknown,
  overlay: number,
  key: string,
  series: Map<number, number>,
): void {
  ensureToken(cache, video, overlay);
  cache.map.set(key, series);
}
