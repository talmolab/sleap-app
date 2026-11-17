/**
 * How well does Claude review Label QC flags? Plant known errors in a
 * well-labeled project, let Claude review it through the connector, then score
 * Claude's proposals against what was planted.
 *
 *   bun scripts/qc-claude-eval.ts plant <in.slp> <out.slp> [--n 40] [--seed 0] [--min 10] [--max 40]
 *     Moves one visible node on each of N random user instances by 10–40 px in
 *     a random direction. Writes <out.slp> and <out>.planted.json.
 *
 *   bun scripts/qc-claude-eval.ts score <planted.json> <proposals.json> [--flags flags.json]
 *     <proposals.json> is the text of list_proposals (in the SLEAP console:
 *     `copy((await sleap.automation.call("list_proposals", {})).content[0].text)`).
 *     Optional <flags.json>: list_qc_flags with a high limit, to report how many
 *     planted errors Label QC flagged at all.
 *
 * Planted errors are the only known errors: a fix on another instance may be a
 * real catch in the original labels, so "false fixes" is an upper bound.
 */
import { readFileSync, writeFileSync } from "node:fs";

export interface Planted {
  videoIdx: number;
  frameIdx: number;
  /** Index into the frame's user instances (as QC and the tools count them). */
  instIdx: number;
  node: number;
  nodeName: string;
  original: [number, number];
  moved: [number, number];
  distance: number;
}

/** A proposal as list_proposals reports it. */
export interface ProposalOut {
  proposal_id: string;
  kind: "fix" | "ignore";
  status: string;
  video: number;
  frame: number;
  instance: number;
  after?: Record<string, [number, number] | null>;
}

/** mulberry32: small seeded PRNG, so a plant is repeatable. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface PoseLike {
  points: { xy: [number, number]; visible: boolean }[];
}
interface FrameLike {
  videoIdx: number;
  frameIdx: number;
  userInstances: PoseLike[];
}

/**
 * Pick N distinct user instances and move one visible node on each. Mutates
 * the poses; returns what was moved. `bounds` (w, h) keeps moved nodes inside
 * the frame.
 */
export function plantErrors(
  frames: FrameLike[],
  nodeNames: string[],
  opts: { n: number; seed: number; min: number; max: number; bounds?: [number, number] | null },
): Planted[] {
  const rand = rng(opts.seed);
  const candidates: { f: FrameLike; i: number }[] = [];
  for (const f of frames) f.userInstances.forEach((inst, i) => {
    if (inst.points.some((p) => p.visible && Number.isFinite(p.xy[0]))) candidates.push({ f, i });
  });
  // Fisher–Yates, then take the first N.
  for (let k = candidates.length - 1; k > 0; k--) {
    const j = Math.floor(rand() * (k + 1));
    [candidates[k], candidates[j]] = [candidates[j], candidates[k]];
  }
  const out: Planted[] = [];
  for (const { f, i } of candidates.slice(0, opts.n)) {
    const inst = f.userInstances[i];
    const visible = inst.points.map((_, k) => k).filter((k) => inst.points[k].visible && Number.isFinite(inst.points[k].xy[0]));
    const node = visible[Math.floor(rand() * visible.length)];
    const [x, y] = inst.points[node].xy;
    const d = opts.min + rand() * (opts.max - opts.min);
    const a = rand() * Math.PI * 2;
    let nx = x + Math.cos(a) * d;
    let ny = y + Math.sin(a) * d;
    if (opts.bounds) {
      nx = Math.min(Math.max(nx, 0), opts.bounds[0] - 1);
      ny = Math.min(Math.max(ny, 0), opts.bounds[1] - 1);
    }
    inst.points[node].xy = [nx, ny];
    out.push({
      videoIdx: f.videoIdx,
      frameIdx: f.frameIdx,
      instIdx: i,
      node,
      nodeName: nodeNames[node] ?? `node ${node + 1}`,
      original: [x, y],
      moved: [nx, ny],
      distance: Math.hypot(nx - x, ny - y),
    });
  }
  return out;
}

const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (a: number, b: number) => (b === 0 ? null : Math.round((1000 * a) / b) / 10);

export interface Score {
  planted: number;
  /** Planted errors whose instance Label QC flagged (when flags were given). */
  flaggedByQc: number | null;
  /** Of those, how many got no proposal at all (left for the user). */
  flaggedNoProposal: number | null;
  /** Planted errors with a fix that moves the planted node. */
  found: number;
  foundPct: number | null;
  /** Fixes on a planted instance that don't move the planted node (wrong node). */
  wrongNodeFixes: number;
  /** Fixes that move the planted node and other nodes too. */
  fixesWithExtraNodes: number;
  /** Planted errors Claude proposed to ignore (missed). */
  ignoredPlanted: number;
  /** All fixes on planted instances: right node (found) + wrong node. */
  fixesOnPlanted: number;
  /** Share of fixes on planted instances that moved the right node. */
  rightNodePct: number | null;
  medianErrorPx: number | null;
  within5PxPct: number | null;
  within10PxPct: number | null;
  /** Found fixes that ended closer to the original than the planted error was. */
  improvedPct: number | null;
  /** Proposals on instances with nothing planted. */
  otherIgnored: number;
  otherFixed: number;
  /** Of proposals on instances with nothing planted, the share that were "ignore". */
  falseAlarmsIgnoredPct: number | null;
}

export function scoreProposals(
  planted: Planted[],
  proposals: ProposalOut[],
  flags?: { video: number; frame: number; instance: number | null }[],
): Score {
  const key = (v: number, f: number, i: number) => `${v}:${f}:${i}`;
  const plantedAt = new Map(planted.map((p) => [key(p.videoIdx, p.frameIdx, p.instIdx), p]));
  // The latest proposal per instance (a re-proposal replaces the earlier one).
  const latest = new Map<string, ProposalOut>();
  for (const p of proposals) latest.set(key(p.video, p.frame, p.instance), p);

  const errors: number[] = [];
  let improved = 0;
  let ignoredPlanted = 0;
  let wrongNodeFixes = 0;
  let fixesWithExtraNodes = 0;
  for (const p of planted) {
    const prop = latest.get(key(p.videoIdx, p.frameIdx, p.instIdx));
    if (!prop) continue;
    if (prop.kind === "ignore") {
      ignoredPlanted++;
      continue;
    }
    const xy = prop.after?.[p.nodeName];
    if (!xy) {
      // A fix that leaves the planted node where it is (or hides it) is wrong.
      wrongNodeFixes++;
      continue;
    }
    if (Object.keys(prop.after ?? {}).length > 1) fixesWithExtraNodes++;
    const e = Math.hypot(xy[0] - p.original[0], xy[1] - p.original[1]);
    errors.push(e);
    if (e < p.distance) improved++;
  }
  let otherIgnored = 0;
  let otherFixed = 0;
  for (const [k, prop] of latest) {
    if (plantedAt.has(k)) continue;
    if (prop.kind === "ignore") otherIgnored++;
    else otherFixed++;
  }
  let flaggedByQc: number | null = null;
  let flaggedNoProposal: number | null = null;
  if (flags) {
    const flagged = new Set(flags.filter((f) => f.instance !== null).map((f) => key(f.video, f.frame, f.instance!)));
    const hit = planted.filter((p) => flagged.has(key(p.videoIdx, p.frameIdx, p.instIdx)));
    flaggedByQc = hit.length;
    flaggedNoProposal = hit.filter((p) => !latest.has(key(p.videoIdx, p.frameIdx, p.instIdx))).length;
  }
  const found = errors.length;
  const fixesOnPlanted = found + wrongNodeFixes;
  const med = median(errors);
  return {
    planted: planted.length,
    flaggedByQc,
    flaggedNoProposal,
    found,
    foundPct: pct(found, planted.length),
    wrongNodeFixes,
    fixesWithExtraNodes,
    ignoredPlanted,
    fixesOnPlanted,
    rightNodePct: pct(found, fixesOnPlanted),
    medianErrorPx: med === null ? null : Math.round(med * 10) / 10,
    within5PxPct: pct(errors.filter((e) => e <= 5).length, found),
    within10PxPct: pct(errors.filter((e) => e <= 10).length, found),
    improvedPct: pct(improved, found),
    otherIgnored,
    otherFixed,
    falseAlarmsIgnoredPct: pct(otherIgnored, otherIgnored + otherFixed),
  };
}

function arg(args: string[], name: string, fallback: number): number {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
}

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  if (cmd === "plant") {
    const [input, output] = rest;
    if (!input || !output) throw new Error("usage: plant <in.slp> <out.slp> [--n 40] [--seed 0] [--min 10] [--max 40]");
    const { loadSlp, saveSlpToBytes } = await import("@talmolab/sleap-io.js");
    const labels = await loadSlp(input, { openVideos: false } as never);
    const frames = labels.labeledFrames.map((lf) => ({
      videoIdx: labels.videos.indexOf(lf.video),
      frameIdx: lf.frameIdx,
      userInstances: lf.userInstances as unknown as PoseLike[],
    }));
    const shape = labels.videos[0]?.shape;
    const planted = plantErrors(frames, labels.skeletons[0]?.nodeNames ?? [], {
      n: arg(rest, "n", 40),
      seed: arg(rest, "seed", 0),
      min: arg(rest, "min", 10),
      max: arg(rest, "max", 40),
      bounds: shape ? [shape[2], shape[1]] : null,
    });
    writeFileSync(output, await saveSlpToBytes(labels));
    const plantedPath = output.replace(/\.slp$/, "") + ".planted.json";
    writeFileSync(plantedPath, JSON.stringify(planted, null, 2));
    console.log(`Planted ${planted.length} errors → ${output}, ${plantedPath}`);
  } else if (cmd === "score") {
    const [plantedPath, proposalsPath] = rest;
    if (!plantedPath || !proposalsPath) throw new Error("usage: score <planted.json> <proposals.json> [--flags flags.json]");
    const planted = JSON.parse(readFileSync(plantedPath, "utf8")) as Planted[];
    const raw = JSON.parse(readFileSync(proposalsPath, "utf8"));
    const proposals = (Array.isArray(raw) ? raw : raw.proposals) as ProposalOut[];
    const fi = rest.indexOf("--flags");
    let flags;
    if (fi >= 0) {
      const f = JSON.parse(readFileSync(rest[fi + 1], "utf8"));
      flags = Array.isArray(f) ? f : f.flags;
    }
    const s = scoreProposals(planted, proposals, flags);
    console.log(JSON.stringify(s, null, 2));
  } else {
    throw new Error("usage: bun scripts/qc-claude-eval.ts plant|score …");
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
