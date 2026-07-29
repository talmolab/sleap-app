/**
 * Tiny deterministic PRNG (mulberry32) — no dependency.
 *
 * The image-features suggestion pipeline is seeded end-to-end so a given seed
 * reproduces the same suggestions (PyQt's pipeline is non-deterministic — it
 * has no seed anywhere). A single `mulberry32(seed)` generator threads through
 * frame sampling, k-means++ initialization, and the per-cluster frame pick.
 *
 * Returns a function producing uniformly-distributed floats in `[0, 1)`,
 * drop-in compatible with `Math.random` (the sampling helpers already accept an
 * injectable `rng: () => number`).
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
