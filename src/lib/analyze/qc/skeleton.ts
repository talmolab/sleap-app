/**
 * Skeleton topology analysis for the QC engine (which features apply; the
 * spine/chains for curvature).
 *
 * Ported from github.com/alexwu-z/sleap-qc-webapp
 * (`src/lib/qc/checks/features/skeleton.js`, itself a port of
 * `sleap/qc/features/skeleton.py`), a lab JS port of Python `sleap.qc` intended
 * for integration into sleap-app. `networkx` is replaced with plain BFS over the
 * (typically tree-shaped) skeleton graph.
 *
 * This module ports only the pure-numeric `SkeletonAnalyzer` (constructed from
 * node count + edge index pairs). The io adapter `analyzerFromSkeleton`, which
 * builds one from a sleap-io.js Skeleton, lands in the io-adapter step.
 */
export class SkeletonAnalyzer {
  nNodes: number;
  edges: [number, number][];
  symmetryPairs: [number, number][];
  /** Per-node degree, derived from edges (any skeleton topology). */
  degree: number[];
  endpoints: number[];
  branchPoints: number[];
  spine: number[];
  maxChainLength: number;
  allChains: number[][];
  private _adj: number[][];

  /**
   * @param nNodes number of nodes
   * @param edges index pairs [[src,dst], ...]
   * @param symmetryPairs [[leftIdx, rightIdx], ...]
   */
  constructor(
    nNodes: number,
    edges: [number, number][],
    symmetryPairs: [number, number][] = [],
  ) {
    this.nNodes = nNodes;
    this.edges = edges;
    this.symmetryPairs = symmetryPairs;

    const adjSets: Set<number>[] = Array.from(
      { length: nNodes },
      () => new Set<number>(),
    );
    for (const [s, d] of edges) {
      adjSets[s].add(d);
      adjSets[d].add(s);
    }
    this._adj = adjSets.map((s) => [...s]);
    this.degree = this._adj.map((a) => a.length);

    this.endpoints = this._nodes().filter((n) => this._adj[n].length === 1);
    this.branchPoints = this._nodes().filter((n) => this._adj[n].length > 2);
    this.spine = this._longestPath();
    this.maxChainLength = this.spine.length;
    this.allChains = this._findAllChains(3);
  }

  private _nodes(): number[] {
    return Array.from({ length: this.nNodes }, (_, i) => i);
  }

  private _bfsDistances(start: number): Map<number, number> {
    const dist = new Map<number, number>([[start, 0]]);
    const q: number[] = [start];
    while (q.length) {
      const u = q.shift() as number;
      for (const v of this._adj[u])
        if (!dist.has(v)) {
          dist.set(v, (dist.get(u) as number) + 1);
          q.push(v);
        }
    }
    return dist;
  }

  private _shortestPath(start: number, end: number): number[] {
    const prev = new Map<number, number | null>([[start, null]]);
    const q: number[] = [start];
    while (q.length) {
      const u = q.shift() as number;
      if (u === end) break;
      for (const v of this._adj[u])
        if (!prev.has(v)) {
          prev.set(v, u);
          q.push(v);
        }
    }
    if (!prev.has(end)) return [];
    const path: number[] = [];
    for (let n: number | null = end; n != null; n = prev.get(n) ?? null)
      path.push(n);
    return path.reverse();
  }

  private _longestPath(): number[] {
    if (this.nNodes === 0) return [];
    const starts = this.endpoints.length ? this.endpoints : [0];
    let longest: number[] = [];
    for (const start of starts) {
      const dist = this._bfsDistances(start);
      let farthest = start,
        best = -1;
      for (const [node, d] of dist)
        if (d > best) {
          best = d;
          farthest = node;
        }
      const path = this._shortestPath(start, farthest);
      if (path.length > longest.length) longest = path;
    }
    return longest;
  }

  private _findAllChains(minLength = 3): number[][] {
    const terminators = new Set<number>([
      ...this.endpoints,
      ...this.branchPoints,
    ]);
    const chains: number[][] = [];
    const visited = new Set<string>();
    const ekey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
    for (const start of terminators) {
      for (const neighbor of this._adj[start]) {
        if (visited.has(ekey(start, neighbor))) continue;
        const chain = [start, neighbor];
        visited.add(ekey(start, neighbor));
        let current = neighbor,
          prev = start;
        while (!terminators.has(current)) {
          const next = this._adj[current].filter((n) => n !== prev);
          if (!next.length) break;
          const nn = next[0];
          visited.add(ekey(current, nn));
          chain.push(nn);
          prev = current;
          current = nn;
        }
        if (chain.length >= minLength) chains.push(chain);
      }
    }
    return chains;
  }

  /** Chains usable for curvature (spine first, then others not contained in it). */
  getCurvatureChains(minLength = 3): number[][] {
    const chains: number[][] = [];
    if (this.spine.length >= minLength) chains.push(this.spine);
    const spineSet = new Set(this.spine);
    for (const chain of this.allChains) {
      if (chain.every((n) => spineSet.has(n))) continue;
      if (chain.length >= minLength) chains.push(chain);
    }
    chains.sort((a, b) => b.length - a.length);
    return chains;
  }
}
