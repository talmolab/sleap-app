/**
 * After a full save, the open project's embedded videos read their images from
 * the file just written (`rebindEmbeddedVideos.ts`), and the streaming writer
 * copies each video's images from the dataset the file holds them under
 * (`embeddedVideoSources.ts`), end to end through the app's real Save
 * (`saveProjectAsSlp`), the real in-memory and streaming writers, the real
 * in-place save and its record.
 *
 * Stood in for: the file system and platform (node fs), the range reader
 * (`StreamingH5File`: h5wasm, reading the file at its path on each call, as
 * the app's native range reads do), and the streaming writer's worker
 * (`StreamingH5Writer`: copies each planned frame's stored image from the
 * source dataset it is given).
 *
 * A large file's open is built as the loader builds it: one range reader on
 * the project file, shared by a deferred `StreamingHdf5VideoBackend` per
 * embedded video, on the dataset `videos_json` names. An eager open gets the
 * same backends over a reader of the file's bytes held in memory, as
 * sleap-io.js's eager read gives them in the app. Packages are app-written from `sleap_io_multi_noshape.pkg.slp`
 * (A: frames 2 and 5, B: frame 3, C: frame 4 (grayscale), D: no embedded
 * frames); each stored image is identified by its bytes.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "../bun-test";
import {
  closeSync,
  copyFileSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as sioModule from "@talmolab/sleap-io.js";
import { ready, File as H5File } from "h5wasm/node";

const sio = { ...sioModule } as typeof sioModule & {
  writeLabelTablesInPlace: (file: unknown, update: unknown) => void;
};
const GiB = 1024 ** 3;

const state = {
  /** Route full saves to the streaming writer (the file's size says > 3 GiB). */
  streaming: false,
  /** The path the last range read named (a reader opened with no file name). */
  lastRangePath: "",
  /** Fail the rebind's reader open (it names the file it opens). */
  failRebindOpen: false,
  /** What the Save As dialog returns. */
  saveAsPath: null as string | null,
};
const fileOps: string[] = [];
const copiedFrom: string[] = [];

async function withFile<T>(path: string, fn: (f: H5File) => T): Promise<T> {
  await ready;
  const f = new H5File(path, "r");
  try {
    return fn(f);
  } finally {
    f.close();
  }
}

type H5Node = {
  keys: () => string[];
  shape: number[];
  dtype: string;
  value: unknown;
  metadata?: unknown;
  slice: (s: unknown) => unknown;
  attrs: Record<string, { value: unknown }>;
};

/** The range reader: reads the file at its path on each call, until closed. */
class H5Reader {
  path = "";
  closed = false;
  async openRange(
    source: { readRange: (offset: number, length: number) => Promise<Uint8Array> },
    options?: { filenameHint?: string }
  ) {
    await source.readRange(0, 0); // the mocked readRange notes its path
    this.path = options?.filenameHint ?? state.lastRangePath;
    if (state.failRebindOpen && options?.filenameHint) throw new Error("injected open failure");
    await ready;
  }
  private use<T>(fn: (f: H5File) => T): Promise<T> {
    if (this.closed) return Promise.reject(new Error("reader closed"));
    return withFile(this.path, fn);
  }
  keys() {
    if (this.closed) throw new Error("reader closed");
    const f = new H5File(this.path, "r");
    try {
      return f.keys();
    } finally {
      f.close();
    }
  }
  getKeys(p: string) {
    return this.use((f) => (f.get(p) as unknown as H5Node).keys());
  }
  getDatasetMeta(p: string) {
    return this.use((f) => {
      const d = f.get(p) as unknown as H5Node;
      return { shape: d.shape, dtype: d.dtype, metadata: d.metadata ?? {} };
    });
  }
  getDatasetValue(p: string, slice?: Array<[number, number] | []>) {
    return this.use((f) => {
      const d = f.get(p) as unknown as H5Node;
      return { value: slice ? d.slice(slice) : d.value, shape: d.shape, dtype: d.dtype };
    });
  }
  getAttrs(p: string) {
    return this.use((f) =>
      Object.fromEntries(
        Object.entries((f.get(p) as unknown as H5Node).attrs).map(([k, a]) => [k, a.value])
      )
    );
  }
  async close() {
    this.closed = true;
  }
}

interface PlanEntry {
  videoIndex: number;
  sourceDataset: string;
  sourceGroup: string;
  frameNumbers: number[];
  format: string;
  channelOrder: string;
}

/**
 * The writer: the in-place save's table patch, and the streaming writer's
 * worker, which copies each planned frame's stored image out of the source
 * dataset it is given.
 */
class H5Writer {
  private dest = "";
  private source = "";
  async openWrite(_sink: unknown, path: string) {
    this.dest = path;
    fileOps.push("openWrite");
  }
  async openAppend(_sink: unknown, destPath: string, _size: number, _src: unknown, sourcePath: string) {
    this.dest = destPath;
    this.source = sourcePath;
    fileOps.push("openAppend");
  }
  async updateLabelsInPlace(update: unknown) {
    await ready;
    const f = new H5File(this.dest, "a");
    try {
      sio.writeLabelTablesInPlace(f, update);
    } finally {
      f.close();
    }
    fileOps.push("updateLabelsInPlace");
    return { success: true };
  }
  async appendEmbeddedVideos(entries: PlanEntry[]) {
    fileOps.push("appendEmbeddedVideos");
    await ready;
    const src = new H5File(this.source, "r");
    const dst = new H5File(this.dest, "a");
    try {
      for (const e of entries) {
        copiedFrom.push(`video${e.videoIndex} <- ${e.sourceDataset}`);
        const stored = Array.from(
          (src.get(`${e.sourceGroup}/frame_numbers`) as unknown as H5Node).value as ArrayLike<number>,
          Number
        );
        const data = src.get(e.sourceDataset) as unknown as H5Node;
        const rows = e.frameNumbers.map((fn) => {
          const row = stored.indexOf(fn);
          if (row < 0) throw new Error(`frame ${fn} is not in ${e.sourceDataset}`);
          return data.slice([[row, row + 1], []]) as Int8Array;
        });
        const width = Math.max(...rows.map((r) => r.length));
        const flat = new Int8Array(rows.length * width);
        rows.forEach((r, i) => flat.set(r, i * width));
        const group = `video${e.videoIndex}`;
        if (!dst.keys().includes(group)) dst.create_group(group);
        dst.create_dataset({
          name: `${group}/video`,
          data: flat,
          shape: [rows.length, width],
          dtype: "<b",
        });
        const video = dst.get(`${group}/video`) as unknown as {
          create_attribute: (name: string, value: unknown) => void;
        };
        video.create_attribute("format", e.format);
        video.create_attribute("channel_order", e.channelOrder);
        dst.create_dataset({
          name: `${group}/frame_numbers`,
          data: BigInt64Array.from(e.frameNumbers, (n) => BigInt(n)),
          shape: [e.frameNumbers.length],
          dtype: "<q",
        });
      }
    } finally {
      dst.close();
      src.close();
    }
    return { success: true, perVideo: {} };
  }
  async close() {}
}

vi.mock("@talmolab/sleap-io.js", () => ({
  ...sio,
  StreamingH5File: H5Reader,
  StreamingH5Writer: H5Writer,
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  stat: async (p: string) => {
    const st = statSync(p);
    return { size: st.size, mtime: st.mtime, ino: st.ino, dev: st.dev };
  },
}));
vi.mock("@/lib/nativeRange", () => ({
  fileSize: async (p: string) => (state.streaming ? 4 * GiB : statSync(p).size),
  readRange: async (p: string) => {
    state.lastRangePath = p;
    return new Uint8Array(0);
  },
}));
let handle: number | null = null;
vi.mock("@/lib/nativeWrite", () => ({
  withNativeWriteHandle: <T,>(work: () => Promise<T>) => work(),
  writeOpen: async (p: string) => {
    mkdirSync(dirname(p), { recursive: true });
    handle = openSync(p, "w");
  },
  writeOpenAppend: async (p: string) => void (handle = openSync(p, "r+")),
  writeAt: async (offset: number, bytes: Uint8Array) => void writeSync(handle!, bytes, 0, bytes.length, offset),
  readAt: async (offset: number, length: number) => {
    const out = new Uint8Array(length);
    readSync(handle!, out, 0, length, offset);
    return out;
  },
  truncateFile: async (length: number) => ftruncateSync(handle!, length),
  writeClose: async () => {
    if (handle !== null) closeSync(handle);
    handle = null;
  },
  renameFile: async (a: string, b: string) => {
    fileOps.push("rename");
    renameSync(a, b);
  },
  copyFile: async (a: string, b: string) => copyFileSync(a, b),
  removeFile: async (p: string) => rmSync(p, { force: true }),
}));
vi.mock("@/platform/index", () => ({
  isTauri: true,
  getPlatform: async () => ({
    isTauri: true,
    writeFile: async (p: string, bytes: Uint8Array) => {
      fileOps.push("fullRewrite");
      writeFileSync(p, bytes);
    },
    showSaveDialog: async () => state.saveAsPath,
  }),
}));
const tmp = mkdtempSync(join(tmpdir(), "sleap-app-rebind-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
vi.mock("@tauri-apps/api/path", () => ({
  appCacheDir: async () => join(tmp, "cache"),
  appLocalDataDir: async () => join(tmp, "local"),
  join: async (...parts: string[]) => join(...parts),
}));
const toasts: string[] = [];
const note = (kind: string) => (title: string, o?: { description?: string }) =>
  void toasts.push(`${kind}: ${title}${o?.description ? ` — ${o.description}` : ""}`);
vi.mock("@/lib/notify", () => ({
  toast: { success: vi.fn(), error: note("error"), info: note("info"), warning: note("warning") },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const { saveProjectAsSlp } = await import("@/lib/saveProject");
const { useAppStore } = await import("@/stores/appStore");
const { withLegacyLayout } = await import("@/lib/slpFormatCompat");
const { bindLabelsToFile, bindingRefusal, boundDatasets, hasStaleVideoNames, loadedVideoDataset, statFileIdentity } =
  await import("@/lib/inPlaceBinding");
const { recordEmbeddedSources } = await import("@/lib/embeddedVideoSources");
const { rebindEmbeddedVideos } = await import("@/lib/rebindEmbeddedVideos");
const { markDiskBackedVideos } = await import("@/lib/diskBackedVideos");
const { applyRecordedSourceDatasets, saveEmbeddedPkgStreaming } = await import(
  "@/lib/saveEmbeddedPkgStreaming"
);

const FIXTURE = join(import.meta.dir, "../fixtures/sleap_io_multi_noshape.pkg.slp");
const NAMES = ["A", "B", "C", "D"];
let copies = 0;

beforeEach(() => {
  Object.defineProperty(globalThis, "crossOriginIsolated", { value: true, configurable: true });
  const g = globalThis as { SharedArrayBuffer?: unknown };
  g.SharedArrayBuffer ??= ArrayBuffer;
  state.streaming = false;
  state.failRebindOpen = false;
  state.saveAsPath = null;
  fileOps.length = 0;
  copiedFrom.length = 0;
  toasts.length = 0;
  useAppStore.setState(useAppStore.getInitialState());
});

/** Stored image bytes, without the zero padding of their row. */
function imageKey(bytes: Uint8Array | null | undefined): string {
  if (!bytes || bytes.length === 0) return "none";
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return Bun.hash(bytes.subarray(0, end)).toString(16);
}

/** The stored images of each embedded entry of the file at `path`, as `dataset: [key, …]`. */
async function storedImages(path: string): Promise<Array<{ dataset: string; frames: Array<[number, string]> }>> {
  const vj = await withFile(path, (f) =>
    Array.from((f.get("videos_json") as unknown as H5Node).value as ArrayLike<unknown>, (raw) =>
      JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw as Uint8Array))
    )
  );
  const reader = new H5Reader();
  reader.path = path;
  const out = [];
  for (const entry of vj as Array<{ backend: { dataset: string } }>) {
    const backend = new sioModule.StreamingHdf5VideoBackend({
      filename: path,
      h5file: reader as never,
      datasetPath: entry.backend.dataset,
      deferred: true,
    });
    await backend.ensureLoaded();
    const frames: Array<[number, string]> = [];
    for (const fn of backend.frameNumbers) frames.push([fn, imageKey(await backend.getFrameBuffer(fn))]);
    out.push({ dataset: entry.backend.dataset, frames });
  }
  return out;
}

/** Which video's image each stored image is: `A@2`, …, by the package first written. */
let imageNames = new Map<string, string>();

/** An app-written package of the fixture's videos `keep`, in that order; names its images. */
async function appPackage(keep: number[]): Promise<string> {
  const labels = await sioModule.loadSlp(FIXTURE);
  const kept = keep.map((i) => labels.videos[i]);
  for (const v of labels.videos.filter((v) => !kept.includes(v))) labels.removeVideo(v);
  labels.videos = kept;
  const path = join(tmp, `app-${copies++}.pkg.slp`);
  writeFileSync(path, await sio.saveSlpToBytes(labels, withLegacyLayout({})));
  for (const v of labels.videos) (v.backend as { close?: () => void } | null)?.close?.();
  imageNames = new Map();
  (await storedImages(path)).forEach((entry, i) => {
    for (const [fn, key] of entry.frames) imageNames.set(key, `${NAMES[keep[i]]}@${fn}`);
  });
  return path;
}

/** Each embedded entry of the file, as the images it holds: `A@2,A@5`. */
async function fileImages(path: string): Promise<string[]> {
  return (await storedImages(path)).map((e) =>
    e.frames.map(([, key]) => imageNames.get(key) ?? `unknown@${key}`).join(",")
  );
}

/** The image each loaded video shows for each of `frames[i]`, through its backend. */
async function shownImages(labels: sioModule.Labels, frames: number[][]): Promise<string[]> {
  const out = [];
  for (const [i, video] of labels.videos.entries()) {
    const shown = [];
    for (const fn of frames[i]) shown.push(imageNames.get(imageKey(await video.getFrameBuffer(fn))) ?? "wrong");
    out.push(shown.join(","));
  }
  return out;
}

type Mode = "large" | "eager";

/**
 * Open a copy of `source` as loadProjectFromPath does. Either way, each
 * embedded video gets a `StreamingHdf5VideoBackend` on the dataset its
 * `videos_json` entry names, through one reader:
 * - large: a range reader on the project file on disk (deferred backends;
 *   `shown` reads their metadata, as viewing the videos does);
 * - eager: a reader of the file's bytes held in memory (a snapshot here),
 *   with every video's metadata read at open, as sleap-io.js's eager read does
 *   in the app.
 * `wrap` puts B in a crop wrapper and C in a grayscale one.
 */
async function openAsApp(source: string, mode: Mode, opts: { shown?: boolean; wrap?: boolean } = {}) {
  const path = join(tmp, `open-${copies++}.pkg.slp`);
  copyFileSync(source, path);
  const identity = await statFileIdentity(path);
  const labels = await sioModule.loadSlp(path, { openVideos: false });
  const reader = new H5Reader();
  let readFrom = path;
  if (mode === "eager") {
    readFrom = `${path}.in-memory`;
    copyFileSync(path, readFrom);
  }
  await reader.openRange({ readRange: async () => new Uint8Array(0) }, { filenameHint: readFrom });
  for (const v of labels.videos) {
    const leaf = new sioModule.StreamingHdf5VideoBackend({
      filename: path,
      h5file: reader as never,
      datasetPath: v.backendMetadata.dataset as string,
      format: "png",
      shape: v.backendMetadata.shape as never,
      deferred: true,
    });
    if (opts.shown || mode === "eager") await leaf.ensureLoaded();
    let backend: sioModule.VideoBackend = leaf;
    const name = NAMES[labels.videos.indexOf(v)];
    if (opts.wrap && name === "B") backend = sioModule.CropVideoBackend.wrap({ inner: leaf, crop: [0, 0, 16, 16] });
    if (opts.wrap && name === "C") backend = sioModule.GrayscaleVideoBackend.wrap({ inner: leaf, grayscale: true });
    v.backend = backend;
  }
  if (mode === "large") markDiskBackedVideos(labels);
  useAppStore.getState().setLabels(labels, "proj.pkg.slp", path);
  bindLabelsToFile(labels, path, identity, "loaded");
  recordEmbeddedSources(path, labels.videos, labels.videos.map(loadedVideoDataset));
  fileOps.length = 0;
  return { labels, path };
}

/** The file's embedded datasets as its `videos_json` names them. */
async function fileDatasets(path: string): Promise<Array<string | null>> {
  return (await storedImages(path)).map((e) => e.dataset);
}

/** The in-place record names the file's datasets, and would patch it. */
async function expectRecordMatches(labels: sioModule.Labels, path: string) {
  expect(bindingRefusal(labels, path, await statFileIdentity(path))).toBeNull();
  const embedded = labels.videos.map((v) => v.hasEmbeddedImages);
  expect(boundDatasets(labels).filter((_, i) => embedded[i])).toEqual(
    (await fileDatasets(path)).filter((_, i) => embedded[i])
  );
}

function movePoint(labels: sioModule.Labels, x: number) {
  labels.labeledFrames[0].instances[0].points[0].xy = [x, x + 1];
}

const FRAMES: Record<string, number[]> = { A: [2, 5], B: [3], C: [4], D: [] };

describe("a large file's open, saved in full after removing a video", () => {
  it("reproduces the bug's sequence: remove A, save, remove C, save: B keeps its own images", async () => {
    const { labels, path } = await openAsApp(await appPackage([0, 1, 2]), "large");
    const [A, , C] = labels.videos;
    labels.removeVideo(A);
    await saveProjectAsSlp(labels, "proj.pkg.slp");
    expect(await fileImages(path)).toEqual(["B@3", "C@4"]);
    expect(await shownImages(labels, [FRAMES.B, FRAMES.C])).toEqual(["B@3", "C@4"]);

    labels.removeVideo(C);
    await saveProjectAsSlp(labels, "proj.pkg.slp");
    expect(toasts.filter((t) => !t.startsWith("info"))).toEqual([]);
    expect(await fileImages(path)).toEqual(["B@3"]);
    expect(await shownImages(labels, [FRAMES.B])).toEqual(["B@3"]);
  });

  for (const writer of ["in-memory", "streaming"] as const) {
    for (const target of ["over the project file", "Save As"] as const) {
      for (const shown of [false, true]) {
        it(`${writer} writer, ${target}${shown ? ", videos shown" : ""}: every save keeps each video's images`, async () => {
          const opened = await openAsApp(await appPackage([0, 1, 2, 3]), "large", { shown, wrap: true });
          const { labels } = opened;
          let path = opened.path;
          const [A, B, C, D] = labels.videos;
          const cropWrapper = B.backend;
          const grayWrapper = C.backend;
          state.streaming = writer === "streaming";
          const save = async () => {
            if (target === "Save As") {
              path = join(tmp, `saved-as-${copies++}.pkg.slp`);
              state.saveAsPath = path;
            }
            copiedFrom.length = 0;
            await saveProjectAsSlp(labels, "proj.pkg.slp", target === "Save As");
            expect(toasts.filter((t) => !t.startsWith("info"))).toEqual([]);
            expect(hasStaleVideoNames(labels)).toBe(false);
            expect(fileOps).toContain(writer === "streaming" ? "appendEmbeddedVideos" : "fullRewrite");
            fileOps.length = 0;
          };

          labels.removeVideo(A); // B, C and D get new indices
          await save();
          expect(await fileImages(path)).toEqual(["B@3", "C@4", ""]);
          expect(await shownImages(labels, [FRAMES.B, FRAMES.C, FRAMES.D])).toEqual(["B@3", "C@4", ""]);
          await expectRecordMatches(labels, path);
          if (writer === "streaming") {
            expect(copiedFrom).toEqual(["video0 <- video1/video", "video1 <- video2/video"]);
          }
          // The wrappers are kept, around backends on the written file.
          expect(B.backend).toBe(cropWrapper);
          expect(C.backend).toBe(grayWrapper);
          expect((C.backend as { dataset?: string }).dataset).toBe("video1/video");

          labels.removeVideo(B); // C moves again
          await save();
          expect(await fileImages(path)).toEqual(["C@4", ""]);
          expect(await shownImages(labels, [FRAMES.C, FRAMES.D])).toEqual(["C@4", ""]);
          await expectRecordMatches(labels, path);
          // The streaming writer copied C from its name in the file it read.
          if (writer === "streaming") expect(copiedFrom).toEqual(["video0 <- video1/video"]);

          // An edit that keeps the video list then goes in place, on the right images.
          if (target === "over the project file") {
            movePoint(labels, 7);
            await saveProjectAsSlp(labels, "proj.pkg.slp");
            expect(fileOps).toContain("updateLabelsInPlace");
            expect(await fileImages(path)).toEqual(["C@4", ""]);
            expect(await shownImages(labels, [FRAMES.C, FRAMES.D])).toEqual(["C@4", ""]);
          }
          void D;
        });
      }
    }
  }

  it("closes the old backends' reader once every video reads the written file", async () => {
    const { labels } = await openAsApp(await appPackage([0, 1, 2]), "large");
    const oldReader = (labels.videos[1].backend as unknown as { h5file: H5Reader }).h5file;
    labels.removeVideo(labels.videos[0]);
    await saveProjectAsSlp(labels, "proj.pkg.slp");
    expect(oldReader.closed).toBe(true);
    const newReader = (labels.videos[0].backend as unknown as { h5file: H5Reader }).h5file;
    expect(newReader).not.toBe(oldReader);
    expect(newReader.closed).toBe(false);
  });

  it("a failed rebind keeps the old backends, asks to reopen, and refuses further full saves", async () => {
    const { labels, path } = await openAsApp(await appPackage([0, 1, 2]), "large");
    const before = labels.videos.map((v) => v.backend);
    labels.removeVideo(labels.videos[0]);
    state.failRebindOpen = true;
    await saveProjectAsSlp(labels, "proj.pkg.slp");
    expect(labels.videos.map((v) => v.backend)).toEqual(before.slice(1));
    expect(hasStaleVideoNames(labels)).toBe(true);
    expect(toasts.some((t) => t.startsWith("warning: Reopen this project"))).toBe(true);
    // The record still names the written file's datasets: an edit goes in place.
    await expectRecordMatches(labels, path);
    movePoint(labels, 5);
    fileOps.length = 0;
    await saveProjectAsSlp(labels, "proj.pkg.slp");
    expect(fileOps).toContain("updateLabelsInPlace");

    // A full save would copy images under the old names: refused, file untouched.
    labels.removeVideo(labels.videos[1]);
    const bytes = readFileSync(path);
    fileOps.length = 0;
    toasts.length = 0;
    await saveProjectAsSlp(labels, "proj.pkg.slp");
    expect(fileOps).toEqual([]);
    expect(toasts.some((t) => t.startsWith("error: Reopen this project"))).toBe(true);
    expect(readFileSync(path).equals(bytes)).toBe(true);
  });

  it("refuses a full save of a video removed before a save and restored after it", async () => {
    const { labels, path } = await openAsApp(await appPackage([0, 1, 2]), "large");
    const [A, B, C] = labels.videos;
    const framesOfA = labels.labeledFrames.filter((f) => f.video === A);
    labels.removeVideo(A);
    await saveProjectAsSlp(labels, "proj.pkg.slp");
    // Undo brings A back; its images are not in the file any more.
    labels.videos = [A, B, C];
    labels.labeledFrames.push(...framesOfA);
    const bytes = readFileSync(path);
    for (const streaming of [false, true]) {
      state.streaming = streaming;
      fileOps.length = 0;
      toasts.length = 0;
      await saveProjectAsSlp(labels, "proj.pkg.slp");
      expect(fileOps.filter((op) => op !== "openWrite")).toEqual([]);
      expect(toasts.some((t) => t.startsWith("error: Can't save this project in full"))).toBe(true);
      expect(readFileSync(path).equals(bytes)).toBe(true);
    }
    // Without it, the save goes ahead.
    labels.removeVideo(A);
    toasts.length = 0;
    await saveProjectAsSlp(labels, "proj.pkg.slp");
    expect(toasts.filter((t) => t.startsWith("error"))).toEqual([]);
    expect(await fileImages(path)).toEqual(["B@3", "C@4"]);
  });
});

describe("an eager open (the file held in memory)", () => {
  for (const target of ["over the project file", "Save As"] as const) {
    it(`${target}: remove, save, remove, save keeps each video's images; nothing is rebound`, async () => {
      const opened = await openAsApp(await appPackage([0, 1, 2, 3]), "eager");
      const { labels } = opened;
      let path = opened.path;
      const backends = labels.videos.map((v) => v.backend);
      const save = async () => {
        if (target === "Save As") {
          path = join(tmp, `saved-as-${copies++}.pkg.slp`);
          state.saveAsPath = path;
        }
        await saveProjectAsSlp(labels, "proj.pkg.slp", target === "Save As");
        expect(toasts.filter((t) => !t.startsWith("info"))).toEqual([]);
        expect(hasStaleVideoNames(labels)).toBe(false);
      };
      labels.removeVideo(labels.videos[0]);
      await save();
      expect(await fileImages(path)).toEqual(["B@3", "C@4", ""]);
      await expectRecordMatches(labels, path);
      labels.removeVideo(labels.videos[0]);
      await save();
      expect(await fileImages(path)).toEqual(["C@4", ""]);
      await expectRecordMatches(labels, path);
      // The same backends, on the file's bytes in memory.
      expect(labels.videos.map((v) => v.backend)).toEqual(backends.slice(2));
    });
  }
});

describe("the streaming writer's source names", () => {
  it("come from the record of the written file, not from a backend's stale name", async () => {
    // An eager open whose backends keep the names they were read under: after
    // a renumbering save, a streaming save must copy from the new names.
    const { labels, path } = await openAsApp(await appPackage([0, 1, 2]), "eager");
    labels.removeVideo(labels.videos[0]);
    await saveProjectAsSlp(labels, "proj.pkg.slp");
    expect(labels.videos.map((v) => (v.backend as { dataset?: string }).dataset)).toEqual([
      "video1/video",
      "video2/video",
    ]);
    // A streaming save reads images from the file on disk, by name.
    expect(existsSync(path)).toBe(true);
    const out = join(tmp, `stream-${copies++}.pkg.slp`);
    await saveEmbeddedPkgStreaming(labels, out, path);
    expect(copiedFrom).toEqual(["video0 <- video0/video", "video1 <- video1/video"]);
    expect(await fileImages(out)).toEqual(["B@3", "C@4"]);
  });
});

describe("rebindEmbeddedVideos on its own", () => {
  it("rebinds only videos that read the file on disk", async () => {
    const { labels, path } = await openAsApp(await appPackage([0, 1]), "eager");
    const backends = labels.videos.map((v) => v.backend);
    expect(await rebindEmbeddedVideos(labels, path, labels.videos, await fileDatasets(path))).toEqual({
      ok: true,
      rebound: 0,
    });
    expect(labels.videos.map((v) => v.backend)).toEqual(backends);
  });

  it("refuses names two embedded videos share, and leaves the backends", async () => {
    const { labels, path } = await openAsApp(await appPackage([0, 1]), "large");
    const backends = labels.videos.map((v) => v.backend);
    const result = await rebindEmbeddedVideos(labels, path, labels.videos, ["video0/video", "video0/video"]);
    expect(result).toEqual({ ok: false, reason: "two embedded videos have the same dataset in the written file" });
    expect(labels.videos.map((v) => v.backend)).toEqual(backends);
  });

  it("refuses a name that holds other frames than the video's, and closes its new reader", async () => {
    const { labels, path } = await openAsApp(await appPackage([0, 1]), "large", { shown: true });
    const backends = labels.videos.map((v) => v.backend);
    // A's frames (2, 5) are not under video1/video (B's: 3).
    const result = await rebindEmbeddedVideos(labels, path, labels.videos, ["video1/video", "video0/video"]);
    expect(result.ok).toBe(false);
    expect(labels.videos.map((v) => v.backend)).toEqual(backends);
    expect((backends[0] as unknown as { h5file: H5Reader }).h5file.closed).toBe(false);
  });

  it("refuses when the written file's names are unknown", async () => {
    const { labels, path } = await openAsApp(await appPackage([0, 1]), "large");
    expect((await rebindEmbeddedVideos(labels, path, labels.videos, null)).ok).toBe(false);
  });
});

describe("applyRecordedSourceDatasets", () => {  const video = (embedded = true) => ({ hasEmbeddedImages: embedded }) as unknown as sioModule.Video;
  const entry = (videoIndex: number, sourceDataset: string) => ({
    videoIndex,
    sourceDataset,
    sourceGroup: sourceDataset.replace(/\/video$/, ""),
    frameNumbers: [1],
  });
  const planOf = (...entries: ReturnType<typeof entry>[]) =>
    ({ sourcePath: "/p.slp", entries, encodeEntries: [] }) as unknown as sioModule.SerializableEmbedPlan;

  it("names each source from the record of the file, and leaves videos with no record", () => {
    const [a, b, c] = [video(), video(), video()];
    recordEmbeddedSources("/p.slp", [a, b], ["video0/video", "video1/video"]);
    const plan = planOf(entry(0, "video5/video"), entry(1, "video1/video"), entry(2, "video7/video"));
    applyRecordedSourceDatasets(plan, { videos: [a, b, c] } as unknown as sioModule.Labels, "/p.slp");
    expect(plan.entries.map((e) => [e.sourceDataset, e.sourceGroup])).toEqual([
      ["video0/video", "video0"],
      ["video1/video", "video1"],
      ["video7/video", "video7"],
    ]);
  });

  it("refuses a video the file no longer holds, or one recorded for another file", () => {
    const [a, b] = [video(), video()];
    recordEmbeddedSources("/q.slp", [a, b], ["video0/video", "video1/video"]);
    recordEmbeddedSources("/q.slp", [b], ["video0/video"]); // a was not written again
    const labels = { videos: [a, b] } as unknown as sioModule.Labels;
    expect(() => applyRecordedSourceDatasets(planOf(entry(0, "video0/video")), labels, "/q.slp")).toThrow(
      /no longer in the source file/
    );
    expect(() => applyRecordedSourceDatasets(planOf(entry(1, "video0/video")), labels, "/other.slp")).toThrow(
      /no longer in the source file/
    );
    const ok = planOf(entry(1, "video1/video"));
    applyRecordedSourceDatasets(ok, labels, "/q.slp");
    expect(ok.entries[0].sourceDataset).toBe("video0/video");
  });
});
