/**
 * Benchmark for Compare Model Predictions on a big synthetic case: a 60-node
 * skeleton, a 100k-frame video and 5 models (2 animals, untracked, so the
 * position-matching path runs). Times the parts a user waits on: loading
 * (checking a file and pulling out its poses), drawing one frame, jumping to
 * the next/previous disagreement (◀ ▶) and building the traces.
 *
 *   bun run scripts/bench-compare-models.ts
 *   BENCH_FRAMES=20000 BENCH_ANIMALS=1 BENCH_TRACKED=1 bun run scripts/bench-compare-models.ts
 *
 * Synthetic data: every model follows the same smooth path with ~1 px noise,
 * except on a few frames where one model is off by 40 px (a "disagreement").
 * Those frames sit near the end, so ▶ from frame 0 has to look through most
 * of the video, the slow case.
 */
import { Labels, LabeledFrame, PredictedInstance, Skeleton, Track, Video } from "@talmolab/sleap-io.js";
import { analyzePredictionFile, targetFromVideo } from "@/lib/modelOverlay/core";
import { useModelOverlayStore } from "@/stores/modelOverlayStore";
import { useAppStore } from "@/stores/appStore";
import {
  findDisagreementFrame,
  frameDisagreements,
  modelOverlayLayers,
  shownModelsShareTracks,
} from "@/hooks/useModelOverlayFrame";
import { renderModelOverlay, hoverTestModelOverlay } from "@/canvas/modelOverlayRenderer";
import { buildAnimalIndex, buildTraces } from "@/lib/modelOverlay/traces";
import { disagreementIndexFor, fillIndex } from "@/lib/modelOverlay/disagreementIndex";

const N_NODES = Number(process.env.BENCH_NODES ?? 60);
const N_FRAMES = Number(process.env.BENCH_FRAMES ?? 100_000);
const N_MODELS = Number(process.env.BENCH_MODELS ?? 5);
const N_ANIMALS = Number(process.env.BENCH_ANIMALS ?? 2);
const TRACKED = process.env.BENCH_TRACKED === "1";

const NODE_NAMES = Array.from({ length: N_NODES }, (_, i) => `n${i}`);
const VIDEO_PATH = "/data/bench/long.mp4";

/** Seeded PRNG so every run sees the same data. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Frames where one model is far off: 30 of them in the last 2% of the video. */
const DISAGREE = new Set<number>();
for (let k = 0; k < 30; k++) DISAGREE.add(N_FRAMES - 1 - Math.floor((k * N_FRAMES * 0.02) / 30));

function makeVideo(): Video {
  return new Video({ filename: VIDEO_PATH, backendMetadata: { shape: [N_FRAMES, 1024, 1280, 1] }, openBackend: false });
}

/** One model's prediction file, built through io's columnar fast path (as the SLP reader does). */
function makeModelLabels(model: number): Labels {
  const rand = rng(1000 + model);
  const skeleton = new Skeleton({ nodes: NODE_NAMES, name: "big" });
  const video = makeVideo();
  const tracks = Array.from({ length: N_ANIMALS }, (_, a) => new Track(`track_${a}`));
  const total = N_FRAMES * N_ANIMALS * N_NODES;
  const x = new Float64Array(total);
  const y = new Float64Array(total);
  const visible = new Uint8Array(total).fill(1);
  const score = new Float64Array(total).fill(0.9);
  const lfs: LabeledFrame[] = new Array(N_FRAMES);
  let off = 0;
  for (let f = 0; f < N_FRAMES; f++) {
    const lf = new LabeledFrame({ video, frameIdx: f });
    for (let a = 0; a < N_ANIMALS; a++) {
      const cx = 300 + a * 500 + 100 * Math.sin(f / 500 + a);
      const cy = 400 + 100 * Math.cos(f / 700 + a);
      const off40 = DISAGREE.has(f) && model === N_MODELS - 1 && a === 0 ? 40 : 0;
      const start = off;
      for (let n = 0; n < N_NODES; n++) {
        x[off] = cx + (n % 10) * 8 + (rand() - 0.5) * 2 + off40;
        y[off] = cy + Math.floor(n / 10) * 8 + (rand() - 0.5) * 2;
        off++;
      }
      lf.instances.push(
        PredictedInstance._fromColumns({
          columns: { x, y, visible, score },
          start,
          end: off,
          skeleton,
          track: TRACKED ? tracks[a] : null,
          score: 0.8,
        })
      );
    }
    lfs[f] = lf;
  }
  return new Labels({
    labeledFrames: lfs,
    videos: [video],
    skeletons: [skeleton],
    tracks: TRACKED ? tracks : [],
    provenance: { model_paths: [`/models/model_${model}`] },
  });
}

function time<T>(label: string, fn: () => T, results: Record<string, number>): T {
  const t0 = performance.now();
  const out = fn();
  const ms = performance.now() - t0;
  results[label] = ms;
  return out;
}

/** A canvas context that records nothing: measures our JS, not the browser's raster. */
function nullCtx(): CanvasRenderingContext2D {
  return new Proxy({} as CanvasRenderingContext2D, {
    get: (_t, p) => (p === "canvas" ? { width: 1280, height: 1024 } : () => undefined),
    set: () => true,
  });
}

const fmt = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(ms < 1 ? 3 : 1)} ms`);

async function main() {
  const results: Record<string, number> = {};
  console.log(
    `Compare Models bench: ${N_NODES} nodes, ${N_FRAMES.toLocaleString()} frames, ${N_MODELS} models, ${N_ANIMALS} animal(s), ${TRACKED ? "tracked" : "untracked"}`
  );

  const projectVideo = makeVideo();
  const target = targetFromVideo(projectVideo);

  // --- Load: build each file's Labels (stand-in for reading the .slp), then check + extract poses.
  const analyses = [];
  let buildMs = 0;
  let analyzeMs = 0;
  for (let m = 0; m < N_MODELS; m++) {
    let t0 = performance.now();
    const labels = makeModelLabels(m);
    buildMs += performance.now() - t0;
    t0 = performance.now();
    const a = analyzePredictionFile(labels, `model_${m}.predictions.slp`, target, NODE_NAMES);
    analyzeMs += performance.now() - t0;
    if (!a.ok) throw new Error(a.reason);
    analyses.push(a);
  }
  results["load: build Labels (synthetic, not app code)"] = buildMs;
  results["load: check + extract poses (×models)"] = analyzeMs;

  const projectLabels = new Labels({ labeledFrames: [], videos: [projectVideo], skeletons: [] });
  time(
    "load: add to store",
    () =>
      useModelOverlayStore.getState().addModels(
        projectLabels,
        analyses.map((a) => ({ name: a.ok ? a.name : "", source: a.name, video: projectVideo, frames: a.ok ? a.frames : new Map() }))
      ),
    results
  );
  useAppStore.setState({ video: projectVideo, frameIdx: 0 });
  const models = useModelOverlayStore.getState().models;

  // --- Per frame: layers + disagreements (what useModelOverlayFrame does), draw, hover test.
  const byTrack = shownModelsShareTracks(models, projectVideo);
  const edges = Array.from({ length: N_NODES - 1 }, (_, i) => [i, i + 1] as [number, number]);
  const ctx = nullCtx();
  const frames = 2000;
  let tLayers = 0;
  let tDraw = 0;
  let tHover = 0;
  for (let i = 0; i < frames; i++) {
    const f = Math.floor((i * N_FRAMES) / frames);
    let t0 = performance.now();
    const layers = modelOverlayLayers(models, projectVideo, f);
    const dis = frameDisagreements(layers, byTrack, 10);
    tLayers += performance.now() - t0;
    t0 = performance.now();
    renderModelOverlay(ctx, layers, edges, { markerSize: 4, poseOpacity: 1, showEdges: true, zoom: 1, toImage: (a, b) => [a, b] }, { disagreements: dis });
    tDraw += performance.now() - t0;
    t0 = performance.now();
    hoverTestModelOverlay(layers, edges, 640, 512, 8, 30, (a, b) => [a, b]);
    tHover += performance.now() - t0;
  }
  results["frame: layers + disagreements (avg)"] = tLayers / frames;
  results["frame: draw, JS side (avg)"] = tDraw / frames;
  results["frame: hover test per mouse move (avg)"] = tHover / frames;

  // --- ◀ ▶: next disagreement from the start (looks through ~98% of frames), previous from the end.
  const next1 = time("▶ next disagreement from frame 0 (1st press)", () => findDisagreementFrame(models, projectVideo, 10, 0, 1), results);
  const next2 = time("▶ next disagreement, 2nd press", () => findDisagreementFrame(models, projectVideo, 10, next1 ?? 0, 1), results);
  time("◀ previous disagreement from the last frame", () => findDisagreementFrame(models, projectVideo, 10, N_FRAMES, -1), results);
  time("▶ after the last disagreement (none: whole tail)", () => findDisagreementFrame(models, projectVideo, 10, N_FRAMES - 1, 1), results);
  time("threshold changed to 15 px, then ▶ from 0", () => findDisagreementFrame(models, projectVideo, 15, 0, 1), results);
  if (next1 === null || next2 === null) console.warn("  (warning: no disagreement found)");
  // Background warm-up: the whole index, as the app fills it in slices after models load.
  time("whole disagreement index (background warm-up, total)", () => fillIndex(disagreementIndexFor(models, projectVideo), Infinity), results);

  // --- Traces: animal index (untracked only) + one node's x/y series.
  const index = byTrack ? undefined : time("traces: link animals across frames (once per set of models)", () => buildAnimalIndex(models), results);
  time("traces: one node's series (per node change)", () => buildTraces(models, 7, byTrack ? { kind: "track", name: "track_0" } : { kind: "animal", index: 0 }, index), results);
  time("traces: another node (per node change)", () => buildTraces(models, 8, byTrack ? { kind: "track", name: "track_0" } : { kind: "animal", index: 0 }, index), results);

  const width = Math.max(...Object.keys(results).map((k) => k.length));
  for (const [k, v] of Object.entries(results)) console.log(`  ${k.padEnd(width)}  ${fmt(v)}`);
  const mem = process.memoryUsage();
  console.log(`  heap used ${(mem.heapUsed / 2 ** 20).toFixed(0)} MB, rss ${(mem.rss / 2 ** 20).toFixed(0)} MB`);
}

await main();
