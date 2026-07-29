import { describe, it, expect } from "../bun-test";
import { Matrix, SVD } from "ml-matrix";
import { mulberry32 } from "@/lib/seededRng";
import {
  detectGrayscale,
  flattenFrame,
  gramPCA,
  kmeansPlusPlus,
  pickPerCluster,
  runImageFeaturesJob,
  type WorkerFrameBuffer,
} from "@/lib/imageFeaturesWorkerCore";

/** Build a WorkerFrameBuffer from an array of [r,g,b] pixels (alpha forced 255). */
function frame(
  frameIdx: number,
  width: number,
  height: number,
  pixels: [number, number, number][]
): WorkerFrameBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  pixels.forEach(([r, g, b], i) => {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  });
  return { frameIdx, width, height, data };
}

describe("detectGrayscale", () => {
  it("returns true when every pixel of every frame has R=G=B", () => {
    const frames = [
      frame(0, 2, 1, [
        [10, 10, 10],
        [40, 40, 40],
      ]),
      frame(1, 2, 1, [
        [7, 7, 7],
        [200, 200, 200],
      ]),
    ];
    expect(detectGrayscale(frames)).toBe(true);
  });

  it("returns false if any pixel in any frame is chromatic", () => {
    const frames = [
      frame(0, 2, 1, [
        [10, 10, 10],
        [40, 40, 40],
      ]),
      // second frame, second pixel is colored
      frame(1, 2, 1, [
        [7, 7, 7],
        [40, 50, 60],
      ]),
    ];
    expect(detectGrayscale(frames)).toBe(false);
  });
});

describe("flattenFrame", () => {
  it("keeps 3 channels (drops alpha) when not grayscale, row-major", () => {
    const f = frame(0, 2, 1, [
      [10, 20, 30],
      [40, 50, 60],
    ]);
    expect(flattenFrame(f, false)).toEqual([10, 20, 30, 40, 50, 60]);
  });

  it("collapses to 1 channel (R) when grayscale", () => {
    const f = frame(0, 2, 1, [
      [10, 10, 10],
      [40, 40, 40],
    ]);
    expect(flattenFrame(f, true)).toEqual([10, 40]);
  });
});

/** Naive reference PCA via SVD of centered data: scores = U[:, :k] · diag(S[:k]). */
function naivePCA(X: number[][], k: number): number[][] {
  const M = new Matrix(X);
  const means = M.mean("column");
  const Xc = M.clone().subRowVector(means);
  const svd = new SVD(Xc);
  const U = svd.leftSingularVectors;
  const S = svd.diagonal;
  const scores: number[][] = [];
  for (let i = 0; i < X.length; i++) {
    const row: number[] = [];
    for (let j = 0; j < k; j++) row.push(U.get(i, j) * S[j]);
    scores.push(row);
  }
  return scores;
}

/** Align each column of `got` to `ref` by flipping its sign when they anti-correlate. */
function alignSigns(got: number[][], ref: number[][]): number[][] {
  const n = got.length;
  const k = got[0]?.length ?? 0;
  const out = got.map((r) => [...r]);
  for (let j = 0; j < k; j++) {
    let dot = 0;
    for (let i = 0; i < n; i++) dot += got[i][j] * ref[i][j];
    if (dot < 0) for (let i = 0; i < n; i++) out[i][j] = -out[i][j];
  }
  return out;
}

describe("gramPCA", () => {
  it("projects collinear points onto their principal axis (1 component)", () => {
    const X = [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ];
    const scores = gramPCA(X, 1);
    expect(scores.length).toBe(4);
    expect(scores[0].length).toBe(1);
    // Sign-normalize (eigenvector sign is arbitrary), then compare to the
    // hand-computed projection onto [1,1]/sqrt(2): (x + y - 3) / sqrt(2).
    const sign = scores[3][0] >= 0 ? 1 : -1;
    const norm = scores.map((r) => r[0] * sign);
    const expected = [-3, -1, 1, 3].map((v) => v / Math.SQRT2);
    norm.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 6));
  });

  it("gives a ~0 second component for collinear points (no off-axis spread)", () => {
    const X = [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ];
    const scores = gramPCA(X, 2);
    scores.forEach((r) => expect(r[1]).toBeCloseTo(0, 6));
  });

  it("matches a naive SVD-based PCA on arbitrary data (up to per-axis sign)", () => {
    const X = [
      [2, 1, 0, 5],
      [3, 7, 1, 2],
      [1, 0, 4, 3],
      [6, 2, 2, 1],
      [0, 5, 3, 4],
    ];
    const k = 3;
    const ref = naivePCA(X, k);
    const got = alignSigns(gramPCA(X, k), ref);
    for (let i = 0; i < X.length; i++) {
      for (let j = 0; j < k; j++) {
        expect(got[i][j]).toBeCloseTo(ref[i][j], 6);
      }
    }
  });
});

/** Two tight, well-separated blobs in 2D (indices 0-2 near origin, 3-5 far). */
const TWO_BLOBS = [
  [0, 0],
  [0, 1],
  [1, 0],
  [100, 100],
  [101, 100],
  [100, 101],
];

describe("kmeansPlusPlus", () => {
  it("assigns well-separated blobs to distinct clusters", () => {
    const a = kmeansPlusPlus(TWO_BLOBS, 2, mulberry32(1));
    // The two blobs must be internally consistent and mutually distinct.
    expect(a[0]).toBe(a[1]);
    expect(a[1]).toBe(a[2]);
    expect(a[3]).toBe(a[4]);
    expect(a[4]).toBe(a[5]);
    expect(a[0]).not.toBe(a[3]);
  });

  it("is deterministic for a given seed", () => {
    const a = kmeansPlusPlus(TWO_BLOBS, 2, mulberry32(42));
    const b = kmeansPlusPlus(TWO_BLOBS, 2, mulberry32(42));
    expect(a).toEqual(b);
  });

  it("puts every point in cluster 0 when k=1", () => {
    const a = kmeansPlusPlus(TWO_BLOBS, 1, mulberry32(7));
    expect(a).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe("pickPerCluster", () => {
  it("caps each cluster's picks at perCluster and returns valid member indices", () => {
    // cluster 0 = indices {0,1,2,3}, cluster 1 = indices {4,5}
    const assignments = [0, 0, 0, 0, 1, 1];
    const picks = pickPerCluster(assignments, 2, 3, mulberry32(3));
    const c0 = picks.filter((i) => assignments[i] === 0);
    const c1 = picks.filter((i) => assignments[i] === 1);
    expect(c0.length).toBe(3); // 3 of 4
    expect(c1.length).toBe(2); // all 2
    c0.forEach((i) => expect([0, 1, 2, 3]).toContain(i));
    c1.forEach((i) => expect([4, 5]).toContain(i));
    // No duplicates.
    expect(new Set(picks).size).toBe(picks.length);
  });

  it("returns all members when perCluster exceeds cluster size", () => {
    const assignments = [0, 0, 1];
    const picks = pickPerCluster(assignments, 2, 5, mulberry32(9)).sort((a, b) => a - b);
    expect(picks).toEqual([0, 1, 2]);
  });

  it("is deterministic for a given seed", () => {
    const assignments = [0, 0, 0, 0, 1, 1, 1, 1];
    const a = pickPerCluster(assignments, 2, 2, mulberry32(5));
    const b = pickPerCluster(assignments, 2, 2, mulberry32(5));
    expect(a).toEqual(b);
  });
});

/** A 2×2 achromatic frame whose pixels sit near intensity `v` (slight jitter). */
function mk(frameIdx: number, v: number): WorkerFrameBuffer {
  return frame(frameIdx, 2, 2, [
    [v, v, v],
    [v + 1, v + 1, v + 1],
    [v, v, v],
    [v - 1, v - 1, v - 1],
  ]);
}

describe("runImageFeaturesJob", () => {
  it("clusters distinct-looking frames and picks across clusters with group labels", () => {
    const frames = [
      mk(0, 10),
      mk(1, 12),
      mk(2, 11),
      mk(10, 200),
      mk(11, 198),
      mk(12, 201),
    ];
    const res = runImageFeaturesJob({
      frames,
      pcaComponents: 2,
      nClusters: 2,
      perCluster: 3,
      seed: 1,
    });
    const byFrame = new Map(res.picks.map((p) => [p.frameIdx, p.group]));
    expect(new Set(res.picks.map((p) => p.frameIdx))).toEqual(
      new Set([0, 1, 2, 10, 11, 12])
    );
    // The dark frames share one group, the bright frames another, distinct.
    expect(byFrame.get(0)).toBe(byFrame.get(1));
    expect(byFrame.get(1)).toBe(byFrame.get(2));
    expect(byFrame.get(10)).toBe(byFrame.get(11));
    expect(byFrame.get(11)).toBe(byFrame.get(12));
    expect(byFrame.get(0)).not.toBe(byFrame.get(10));
  });

  it("returns the single frame directly when there is only one sample", () => {
    const res = runImageFeaturesJob({
      frames: [mk(7, 5)],
      pcaComponents: 5,
      nClusters: 5,
      perCluster: 5,
      seed: 2,
    });
    expect(res.picks).toEqual([{ frameIdx: 7, group: 0 }]);
  });

  it("clamps n_clusters to the sample count for short videos", () => {
    const frames = [mk(0, 10), mk(1, 120), mk(2, 240)];
    const res = runImageFeaturesJob({
      frames,
      pcaComponents: 5,
      nClusters: 5,
      perCluster: 5,
      seed: 3,
    });
    expect(res.picks.length).toBe(3);
    expect(new Set(res.picks.map((p) => p.frameIdx))).toEqual(new Set([0, 1, 2]));
  });

  it("is deterministic for a given seed", () => {
    const build = () => [mk(0, 10), mk(1, 12), mk(2, 200), mk(3, 201)];
    const opts = { pcaComponents: 2, nClusters: 2, perCluster: 2, seed: 5 };
    const a = runImageFeaturesJob({ frames: build(), ...opts });
    const b = runImageFeaturesJob({ frames: build(), ...opts });
    expect(a).toEqual(b);
  });

  it("returns no picks for an empty job", () => {
    const res = runImageFeaturesJob({
      frames: [],
      pcaComponents: 5,
      nClusters: 5,
      perCluster: 5,
      seed: 1,
    });
    expect(res.picks).toEqual([]);
  });
});
