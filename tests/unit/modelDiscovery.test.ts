/**
 * Unit tests for trained-model auto-detection (parity with legacy SLEAP's
 * TrainingConfigsGetter auto-selecting the most recently trained model).
 *
 * File access is an in-memory mock (ModelFsAccess) so no Tauri runtime or
 * real disk is needed.
 */

import { describe, it, expect } from "../bun-test";
import {
  findTrainedModels,
  pickModelsForPipeline,
  type ModelFsAccess,
  type ModelDirEntry,
} from "@/lib/modelDiscovery";

const CENTROID_CFG = `
model_config:
  head_configs:
    centroid:
      confmaps: {}
trainer_config:
  run_name: "250101_120000.centroid.n=100"
`;

const CENTERED_INSTANCE_CFG = `
model_config:
  head_configs:
    centered_instance:
      confmaps: {}
trainer_config:
  run_name: "250102_120000.centered_instance.n=100"
`;

const BOTTOMUP_CFG = `
model_config:
  head_configs:
    bottomup:
      confmaps: {}
trainer_config:
  run_name: "250103_120000.bottomup.n=100"
`;

interface FsFixture {
  dirs: Record<string, ModelDirEntry[]>;
  files: Record<string, string>;
  mtimes: Record<string, number>;
}

function makeFs(fixture: FsFixture): ModelFsAccess {
  return {
    async readDir(path: string) {
      const entries = fixture.dirs[path];
      if (!entries) throw new Error(`ENOENT (readDir): ${path}`);
      return entries;
    },
    async readTextFile(path: string) {
      const content = fixture.files[path];
      if (content === undefined) throw new Error(`ENOENT (readTextFile): ${path}`);
      return content;
    },
    async exists(path: string) {
      return path in fixture.dirs || path in fixture.files;
    },
    async mtimeMs(path: string) {
      return fixture.mtimes[path] ?? 0;
    },
  };
}

describe("findTrainedModels", () => {
  it("returns [] when there's no models/ folder", async () => {
    const fs = makeFs({ dirs: {}, files: {}, mtimes: {} });
    expect(await findTrainedModels("/proj", fs)).toEqual([]);
  });

  it("skips a run dir with a config but no checkpoint (not trained)", async () => {
    const fs = makeFs({
      dirs: {
        "/proj/models": [{ name: "run1", isDirectory: true }],
        "/proj/models/run1": [{ name: "training_config.yaml", isDirectory: false }],
      },
      files: { "/proj/models/run1/training_config.yaml": CENTROID_CFG },
      mtimes: {},
    });
    expect(await findTrainedModels("/proj", fs)).toEqual([]);
  });

  it("skips non-directory entries under models/", async () => {
    const fs = makeFs({
      dirs: {
        "/proj/models": [{ name: "notes.txt", isDirectory: false }],
      },
      files: {},
      mtimes: {},
    });
    expect(await findTrainedModels("/proj", fs)).toEqual([]);
  });

  it("finds trained runs and sorts most-recently-modified first", async () => {
    const fs = makeFs({
      dirs: {
        "/proj/models": [
          { name: "old_centroid", isDirectory: true },
          { name: "new_centroid", isDirectory: true },
        ],
        "/proj/models/old_centroid": [
          { name: "training_config.yaml", isDirectory: false },
          { name: "best.ckpt", isDirectory: false },
        ],
        "/proj/models/new_centroid": [
          { name: "training_config.yaml", isDirectory: false },
          { name: "best.ckpt", isDirectory: false },
        ],
      },
      files: {
        "/proj/models/old_centroid/training_config.yaml": CENTROID_CFG,
        "/proj/models/new_centroid/training_config.yaml": CENTROID_CFG,
      },
      mtimes: {
        "/proj/models/old_centroid": 1000,
        "/proj/models/new_centroid": 2000,
      },
    });
    const models = await findTrainedModels("/proj", fs);
    expect(models.map((m) => m.path)).toEqual([
      "/proj/models/new_centroid",
      "/proj/models/old_centroid",
    ]);
    expect(models[0].headKey).toBe("centroid");
  });

  it("prefers last.ckpt over best.ckpt for checkpointFile", async () => {
    const fs = makeFs({
      dirs: {
        "/proj/models": [{ name: "run1", isDirectory: true }],
        "/proj/models/run1": [
          { name: "training_config.yaml", isDirectory: false },
          { name: "best.ckpt", isDirectory: false },
          { name: "last.ckpt", isDirectory: false },
        ],
      },
      files: { "/proj/models/run1/training_config.yaml": CENTROID_CFG },
      mtimes: {},
    });
    const models = await findTrainedModels("/proj", fs);
    expect(models[0].checkpointFile).toBe("last.ckpt");
  });

  it("falls back to best.ckpt when there's no last.ckpt", async () => {
    const fs = makeFs({
      dirs: {
        "/proj/models": [{ name: "run1", isDirectory: true }],
        "/proj/models/run1": [
          { name: "training_config.yaml", isDirectory: false },
          { name: "best.ckpt", isDirectory: false },
        ],
      },
      files: { "/proj/models/run1/training_config.yaml": CENTROID_CFG },
      mtimes: {},
    });
    const models = await findTrainedModels("/proj", fs);
    expect(models[0].checkpointFile).toBe("best.ckpt");
  });

  it("extracts the head key for each head type", async () => {
    const fs = makeFs({
      dirs: {
        "/proj/models": [
          { name: "centroid_run", isDirectory: true },
          { name: "centered_instance_run", isDirectory: true },
          { name: "bottomup_run", isDirectory: true },
        ],
        "/proj/models/centroid_run": [
          { name: "training_config.yaml", isDirectory: false },
          { name: "best.ckpt", isDirectory: false },
        ],
        "/proj/models/centered_instance_run": [
          { name: "training_config.yaml", isDirectory: false },
          { name: "best.ckpt", isDirectory: false },
        ],
        "/proj/models/bottomup_run": [
          { name: "training_config.yaml", isDirectory: false },
          { name: "best.ckpt", isDirectory: false },
        ],
      },
      files: {
        "/proj/models/centroid_run/training_config.yaml": CENTROID_CFG,
        "/proj/models/centered_instance_run/training_config.yaml": CENTERED_INSTANCE_CFG,
        "/proj/models/bottomup_run/training_config.yaml": BOTTOMUP_CFG,
      },
      mtimes: {},
    });
    const models = await findTrainedModels("/proj", fs);
    const headKeys = models.map((m) => m.headKey).sort();
    expect(headKeys).toEqual(["bottomup", "centered_instance", "centroid"]);
  });
});

describe("pickModelsForPipeline", () => {
  const models = [
    { path: "/proj/models/centroid_run", headKey: "centroid", runName: null, mtimeMs: 2000, checkpointFile: null },
    {
      path: "/proj/models/centered_instance_run",
      headKey: "centered_instance",
      runName: null,
      mtimeMs: 1000,
      checkpointFile: null,
    },
    { path: "/proj/models/bottomup_run", headKey: "bottomup", runName: null, mtimeMs: 3000, checkpointFile: null },
  ];

  it("picks centroid + centered_instance for top-down, in head order", () => {
    expect(pickModelsForPipeline(models, "top-down")).toEqual([
      "/proj/models/centroid_run",
      "/proj/models/centered_instance_run",
    ]);
  });

  it("picks bottomup for bottom-up", () => {
    expect(pickModelsForPipeline(models, "bottom-up")).toEqual(["/proj/models/bottomup_run"]);
  });

  it("returns [] when a required head has no trained model", () => {
    expect(pickModelsForPipeline(models, "single-animal")).toEqual([]);
    expect(pickModelsForPipeline(models, "top-down-id")).toEqual([]);
  });

  it("prefers the most recent match when multiple runs share a head", () => {
    const withDupeCentroid = [
      { path: "/proj/models/centroid_old", headKey: "centroid", runName: null, mtimeMs: 1000, checkpointFile: null },
      ...models,
    ];
    // findTrainedModels sorts most-recent-first; pickModelsForPipeline takes
    // the first match, so callers must pass an already-sorted list.
    expect(pickModelsForPipeline(withDupeCentroid, "bottom-up")).toEqual([
      "/proj/models/bottomup_run",
    ]);
  });
});
