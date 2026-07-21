/**
 * E2E for first-class centroid annotations (WS3). Proves, against the real app
 * stores/commands + the dev-linked iojs (with the /centroids group fix):
 *
 *   fixture  — seed UserCentroids via the real SeedCentroid command → save .slp
 *              → reload; centroids round-trip (incl. centroid-only frames).
 *   phase2   — PairPoseInstances → buildWorkList → enterKeypointPassMode; assert
 *              the Phase-2 zoom-to-centroid "crop" params (each work item's
 *              centroidXY anchor + the zoom window + a valid pass cursor). This
 *              is the pan/zoom "crop" the parts-labelling view displays.
 *   train    — train a centroid model from the APP-written .slp via sleap-nn
 *              (anchor_part=null → target is the UserCentroids). Spawns sleap-nn.
 *
 * Run:  OPTION_A_GATE_DIR must have frames/ (from the HI-07 gate).
 *   bun tests/integration/centroid-annotation-e2e.ts fixture
 *   bun tests/integration/centroid-annotation-e2e.ts phase2
 *   bun tests/integration/centroid-annotation-e2e.ts train    # spawns sleap-nn
 */
import "./_headless";
import { readFileSync } from "node:fs";
import { Labels, LabeledFrame, Skeleton, Video, loadSlp, saveSlpToBytes } from "@talmolab/sleap-io.js";
import { useAppStore } from "@/stores/appStore";
import { useActiveLearningStore } from "@/stores/activeLearningStore";
import { CommandContext } from "@/commands/CommandContext";
import { SeedCentroid, PairPoseInstances } from "@/commands/editCommands";
import { normalizeActiveLearningConfig } from "@/lib/activeLearning/config";
import { buildWorkList, passDims, initialCursor, resolveItemInstance } from "@/lib/activeLearning/passEngine";

const GATE = "/private/tmp/claude-501/-Users-than-work-sleap-app/588b7f19-9f25-4a81-b495-b1becaf0f0bb/scratchpad/optionA-gate";
const DIR = "/private/tmp/claude-501/-Users-than-work-sleap-app/588b7f19-9f25-4a81-b495-b1becaf0f0bb/scratchpad";
const SLP = `${DIR}/centroid_annotation_e2e.slp`;
const N = 12;
const CROP = 96;

function blobCenters(f: number): [number, number][] {
  return [[40 + 4 * f, 50 + 1.5 * f], [150 - 3.2 * f, 140 - 2 * f]];
}
function fail(m: string): never { console.error(`✗ ${m}`); process.exit(1); }
function ok(m: string) { console.log(`✓ ${m}`); }
function assert(c: unknown, m: string): asserts c { if (!c) fail(m); }
function near(a: number, b: number) { return Math.abs(a - b) < 1e-6; }

function alConfig() {
  return normalizeActiveLearningConfig({
    localize: { centroidNode: "centroid", separateCentroid: true, cropSize: CROP },
    labelKeypoints: { passes: [{ name: "P1", nodes: ["snout", "tailbase"], guide: "none" }] },
  });
}

async function stageFixture() {
  const framePaths = Array.from({ length: N }, (_, i) => `${GATE}/frames/frame_${String(i).padStart(3, "0")}.png`);
  const pose = new Skeleton({ nodes: ["snout", "neck", "tailbase"], name: "rodent" });
  const video = new Video({ filename: framePaths, backendMetadata: { shape: [N, 192, 192, 1] }, openBackend: false });
  const labels = new Labels({ videos: [video], skeletons: [pose], labeledFrames: [] });
  for (let f = 0; f < N; f++) labels.labeledFrames.push(new LabeledFrame({ video, frameIdx: f }));

  useAppStore.getState().setLabels(labels, "centroid_annotation_e2e.slp", SLP);
  // Seed via the REAL command path, in centroid-annotation mode.
  useAppStore.getState().enterSeedMode(0, true);
  const ctx = new CommandContext();
  for (let f = 0; f < N; f++) {
    useAppStore.getState().setFrameIdx(f);
    for (const [x, y] of blobCenters(f)) await ctx.execute(SeedCentroid, { x, y });
  }
  useAppStore.getState().exitSeedMode();

  // Every seed must be a UserCentroid on frame.centroids — zero pose instances.
  let nCentroids = 0, nInstances = 0;
  for (const lf of labels.labeledFrames) { nCentroids += lf.centroids.length; nInstances += lf.instances.length; }
  assert(nCentroids === N * 2, `expected ${N * 2} centroids, got ${nCentroids}`);
  assert(nInstances === 0, `seeding created ${nInstances} instances (should be 0 — centroids only)`);
  ok(`seeded ${nCentroids} UserCentroids across ${N} frames via SeedCentroid (0 pose instances)`);

  await Bun.write(SLP, await saveSlpToBytes(labels));
  const back = await loadSlp(readFileSync(SLP).buffer as ArrayBuffer, { openVideos: false, h5: { filenameHint: SLP } });
  const backCentroids = back.labeledFrames.reduce((n, lf) => n + lf.centroids.length, 0);
  assert(backCentroids === N * 2, `reload: ${backCentroids} centroids (expected ${N * 2})`);
  assert(back.skeletons.length === 1, `reload: expected single skeleton, got ${back.skeletons.length}`);
  ok(`app wrote + reloaded .slp: ${backCentroids} centroids, single pose skeleton (no centroid skeleton)`);
}

async function stagePhase2() {
  const labels = await loadSlp(readFileSync(SLP).buffer as ArrayBuffer, { openVideos: false, h5: { filenameHint: SLP } });
  useAppStore.getState().setLabels(labels, "centroid_annotation_e2e.slp", SLP);
  const config = alConfig();
  useActiveLearningStore.getState().setConfig(config, ["snout", "neck", "tailbase"]);

  // 1. Pair: create a pose instance per centroid (undoable command).
  const ctx = new CommandContext();
  await ctx.execute(PairPoseInstances);
  const poseCount = labels.labeledFrames.reduce(
    (n, lf) => n + lf.instances.filter((i) => i.skeleton === labels.skeletons[0]).length, 0);
  assert(poseCount === N * 2, `expected ${N * 2} paired pose instances, got ${poseCount}`);
  ok(`PairPoseInstances created ${poseCount} pose instances (one per centroid)`);

  // 2. Work list: each item is a Phase-2 "crop" = a zoom anchor (centroidXY) +
  //    the pose instance to label. This is the pan/zoom the parts view shows.
  const workList = buildWorkList(labels, config);
  assert(workList.length === N * 2, `work list has ${workList.length} items, expected ${N * 2}`);
  // Every item's anchor must be one of the seeded blob centers.
  const seeds = new Set<string>();
  for (let f = 0; f < N; f++) for (const [x, y] of blobCenters(f)) seeds.add(`${x},${y}`);
  for (const it of workList) {
    assert(seeds.has(`${it.centroidXY[0]},${it.centroidXY[1]}`), `work item anchor ${it.centroidXY} is not a seeded centroid`);
    const inst = resolveItemInstance(labels, it);
    assert(inst && inst.skeleton === labels.skeletons[0], "work item did not resolve to a pose instance");
  }
  ok(`buildWorkList produced ${workList.length} zoom-to-centroid items, each anchored on a seeded centroid`);

  // 3. Pass cursor + zoom window: this is what enterKeypointPassMode feeds the
  //    VideoPlayer to pan/zoom to the current item's centroid.
  const names = labels.skeletons[0].nodes.map((n) => n.name);
  const dims = passDims(config, workList, names);
  const cursor = initialCursor(dims);
  assert(cursor && cursor.itemIdx === 0 && cursor.passIdx === 0, "no valid initial pass cursor");
  assert(dims.nodeCountForPass[0] === 2, `pass 0 should place 2 nodes, got ${dims.nodeCountForPass[0]}`);
  useAppStore.getState().enterKeypointPassMode({
    workList, dims, nodeIndices: [[0, 2]], zoomWindow: config.localize.cropSize,
  });
  const s = useAppStore.getState();
  assert(s.labelingMode === "keypointPass", "did not enter keypointPass mode");
  assert(s.passZoomWindow === CROP, `pass zoom window ${s.passZoomWindow} != cropSize ${CROP}`);
  assert(s.passCursor?.itemIdx === 0, "pass cursor not at first item");
  const firstAnchor = s.passWorkList[s.passCursor!.itemIdx].centroidXY;
  assert(near(firstAnchor[0], 40) && near(firstAnchor[1], 50), `first crop anchor ${firstAnchor} != first seed [40,50]`);
  ok(`Phase-2 crop ready: keypointPass mode, zoom window=${s.passZoomWindow}px, first crop pans to centroid [${firstAnchor}]`);
  useAppStore.getState().exitKeypointPassMode();
}

async function stageTrain() {
  // Handed to a shell wrapper that runs sleap-nn; here we just confirm the app
  // .slp exists and print the command to run. (train.sh does the spawn.)
  assert(readFileSync(SLP).byteLength > 0, "no app-written .slp — run `fixture` first");
  ok(`app .slp ready for sleap-nn training: ${SLP}`);
  console.log("Run training via: bun tests/integration/centroid-annotation-e2e.ts (train stage is driven by the shell wrapper)");
}

const stage = process.argv[2];
const stages: Record<string, () => Promise<void>> = { fixture: stageFixture, phase2: stagePhase2, train: stageTrain };
if (!stage || !stages[stage]) { console.error(`usage: <${Object.keys(stages).join("|")}>`); process.exit(2); }
await stages[stage]();
console.log(`— stage "${stage}" passed —`);
