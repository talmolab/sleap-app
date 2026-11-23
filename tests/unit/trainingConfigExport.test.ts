/**
 * "Export Training Job Package..." and "Save configuration files..." end to
 * end with file I/O faked: the zip must hold the .pkg.slp, valid sleap-nn
 * configs and scripts that point at that .pkg.slp — on desktop (temp file
 * streamed into the zip) and in the browser (built in memory, then
 * downloaded). Ported from alicup29's talmolab/sleap-app#485.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "../bun-test";
import { unzipSync, strFromU8 } from "fflate";
import yaml from "js-yaml";
import { Skeleton, Video, Labels, LabeledFrame, Instance } from "@talmolab/sleap-io.js";

// ── Fakes (registered before the module under test is imported) ────────
const FAKE_PKG = new Uint8Array(70_000).map((_, i) => i % 199);
let isTauri = false;
const disk = new Map<string, Uint8Array>();
const removed: string[] = [];
let packageLevel: string | null = null;
let packageImage: unknown = "unset";
let browserSave: { bytes: Uint8Array; name: string } | null = null;
let writeTarget: string | null = null;

vi.mock("@/commands/exportPackageCommands", () => ({
  canStreamPackage: async () => true,
  derivePackageFilename: (f: string | null) => `${(f ?? "labels").replace(/\.slp$/i, "")}.pkg.slp`,
  labelsPackageBytes: async (_l: unknown, level: string, _p: unknown, image?: unknown) => {
    packageLevel = level;
    packageImage = image;
    return FAKE_PKG;
  },
  warnUnembedded: () => {},
  withEmbedProgress: (_two: boolean, work: (p: () => boolean) => unknown) => work(() => true),
  withExportLock: (work: () => unknown) => work(),
  writeLabelsPackageToPath: async (
    _l: unknown,
    level: string,
    path: string,
    _p: unknown,
    image?: unknown,
  ) => {
    packageLevel = level;
    packageImage = image;
    disk.set(path, FAKE_PKG);
    return false;
  },
}));
vi.mock("@/commands/fileCommands", () => ({
  saveBytesFile: async (bytes: Uint8Array, name: string) => {
    browserSave = { bytes, name };
    return name;
  },
}));
vi.mock("@/platform", () => ({
  isTauri: false,
  getPlatform: async () => ({
    isTauri,
    showSaveDialog: async () => "/out/proj.slp.training_job.zip",
    writeFile: async (p: string, b: Uint8Array) => void disk.set(p, b),
  }),
}));
vi.mock("@/lib/exportToast", () => ({ toastExported: () => {} }));
vi.mock("@/lib/notify", () => ({
  toast: { success: () => {}, error: () => {}, info: () => {}, warning: () => {} },
}));
vi.mock("@tauri-apps/api/path", () => ({
  tempDir: async () => "/tmp",
  join: async (...parts: string[]) => parts.join("/"),
  dirname: async (p: string) => p.slice(0, p.lastIndexOf("/")),
}));
vi.mock("@/lib/nativeRange", () => ({
  fileSize: async (p: string) => disk.get(p)!.byteLength,
  readRange: async (p: string, o: number, n: number) => disk.get(p)!.slice(o, o + n),
}));
vi.mock("@/lib/nativeWrite", () => ({
  withNativeWriteHandle: (work: () => unknown) => work(),
  writeOpen: async (p: string) => {
    writeTarget = p;
    disk.set(p, new Uint8Array(0));
  },
  writeAt: async (offset: number, bytes: Uint8Array) => {
    const cur = disk.get(writeTarget!)!;
    const next = new Uint8Array(Math.max(cur.byteLength, offset + bytes.byteLength));
    next.set(cur);
    next.set(bytes, offset);
    disk.set(writeTarget!, next);
  },
  writeClose: async () => {
    writeTarget = null;
  },
  removeFile: async (p: string) => {
    removed.push(p);
    disk.delete(p);
  },
}));

type Mod = typeof import("@/commands/trainingConfigExport");
let mod: Mod;
let useAppStore: typeof import("@/stores/appStore").useAppStore;
let request: import("@/commands/trainingConfigExport").TrainingConfigRequest;

function makeLabels(): Labels {
  const skeleton = new Skeleton({ nodes: ["a", "b"], name: "s" });
  const video = new Video({ filename: "/data/v.mp4", backendMetadata: { shape: [30, 256, 256, 1] }, openBackend: false });
  const lf = new LabeledFrame({ video, frameIdx: 0 });
  const inst = Instance.empty({ skeleton });
  inst.points[0].xy = [5, 5];
  inst.points[0].visible = true;
  inst.points[1].xy = [40, 30];
  inst.points[1].visible = true;
  lf.instances.push(inst);
  return new Labels({ videos: [video], skeletons: [skeleton], labeledFrames: [lf] });
}

beforeAll(async () => {
  mod = await import("@/commands/trainingConfigExport");
  ({ useAppStore } = await import("@/stores/appStore"));
  const { useTrainingStore, getConfigSlots } = await import("@/stores/trainingStore");
  const { getRecommendedProfileForHead, slotToHeadType } = await import("@/lib/trainingProfiles");
  const configs = getConfigSlots("top_down").map((slot) => {
    const p = getRecommendedProfileForHead(slotToHeadType("top_down", slot), null)!;
    return useTrainingStore.getState().parseYamlConfig(p.content, p.filename, slot)!;
  });
  request = { modelType: "top_down", configs, inferenceTarget: "suggestions", sampleCount: 5, skipUserLabeled: false };
});

beforeEach(() => {
  disk.clear();
  removed.length = 0;
  packageLevel = null;
  browserSave = null;
  const labels = makeLabels();
  useAppStore.setState({ labels, filename: "proj.slp", projectPath: isTauri ? "/data/proj.slp" : null, video: labels.videos[0], frameIdx: 0 });
});

/** Checks every package must pass, whichever way it was written. */
function checkPackage(zipBytes: Uint8Array) {
  const files = unzipSync(zipBytes);
  expect(Object.keys(files).sort()).toEqual([
    "centered_instance.yaml",
    "centroid.yaml",
    "inference-script.sh",
    "jobs.yaml",
    "proj.pkg.slp",
    "train-script.sh",
  ]);
  expect(files["proj.pkg.slp"]).toEqual(FAKE_PKG);
  for (const name of ["centroid.yaml", "centered_instance.yaml"]) {
    const doc = yaml.load(strFromU8(files[name])) as { data_config: { train_labels_path: string[] } };
    expect(doc.data_config.train_labels_path).toEqual(["proj.pkg.slp"]);
  }
  expect(strFromU8(files["train-script.sh"])).toContain("--config-name centroid.yaml");
  expect(strFromU8(files["inference-script.sh"])).toContain("--data_path proj.pkg.slp");
}

describe("Export Training Job Package", () => {
  // Desktop: the package goes to a temp file, is streamed into the zip, and the temp file is cleaned up.
  it("writes a complete zip on desktop", async () => {
    isTauri = true;
    const saved = await mod.exportTrainingJobPackage(request);
    expect(saved).toBe("/out/proj.slp.training_job.zip");
    checkPackage(disk.get(saved!)!);
    expect(removed.some((p) => p.startsWith("/tmp/") && p.endsWith("proj.pkg.slp"))).toBe(true);
  });

  // Browser: same zip, built in memory and handed to the download/save picker.
  it("writes a complete zip in the browser", async () => {
    isTauri = false;
    const saved = await mod.exportTrainingJobPackage(request);
    expect(saved).toBe("proj.slp.training_job.zip");
    checkPackage(browserSave!.bytes);
  });

  // The Training dialog passes no frame format (PNG, as before); a caller's
  // format reaches the package on both paths.
  it("passes a frame format on to the package, desktop and browser", async () => {
    const image = { format: "jpg" as const, quality: 90 };
    for (const tauri of [true, false]) {
      isTauri = tauri;
      packageImage = "unset";
      await mod.exportTrainingJobPackage(request);
      expect(packageImage).toBeUndefined();
      await mod.exportTrainingJobPackage(request, { image });
      expect(packageImage).toEqual(image);
    }
  });

  // PyQt embeds suggested frames only when inference will run on them.
  it("includes suggested frames only when inference targets suggestions", async () => {
    isTauri = false;
    await mod.exportTrainingJobPackage(request);
    expect(packageLevel).toBe("training");
    await mod.exportTrainingJobPackage({ ...request, inferenceTarget: "user_labeled" });
    expect(packageLevel).toBe("user");
  });
});

describe("Save configuration files", () => {
  // The browser can't write into a folder, so it downloads the same files as a .zip.
  it("downloads the configs and scripts as a zip in the browser", async () => {
    isTauri = false;
    useAppStore.setState({ projectPath: null });
    const saved = await mod.saveTrainingConfigFiles(request);
    expect(saved).toBe("proj.slp.training_configs.zip");
    const files = unzipSync(browserSave!.bytes);
    expect(Object.keys(files).sort()).toEqual([
      "README.txt",
      "centered_instance.yaml",
      "centroid.yaml",
      "inference-script.sh",
      "jobs.yaml",
      "train-script.sh",
    ]);
    // The browser only knows the file name, so the README must say where the .slp goes.
    expect(strFromU8(files["README.txt"])).toContain("copy proj.slp (saved from SLEAP) next to these files");
    const doc = yaml.load(strFromU8(files["centroid.yaml"])) as { data_config: { train_labels_path: string[] } };
    expect(doc.data_config.train_labels_path).toEqual(["proj.slp"]);
  });
});
