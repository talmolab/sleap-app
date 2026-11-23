/**
 * The app's Save (`saveProjectAsSlp`) and what it records about the file for
 * the fast in-place save, end to end: the real save routing, the real
 * `saveLabelsInPlace` and the real record (`inPlaceBinding.ts`), with the file
 * system, the platform and the streaming reader and writer stood in for by
 * node fs and h5wasm.
 *
 * - A full rewrite records the video list it WROTE. If the list changed while
 *   it ran (an undo or redo between building the file and recording it), the
 *   record is cleared, and the next save rewrites in full: A's labels never
 *   land on B's images.
 * - Undo, redo and edits are refused while a save runs, and a second save
 *   doesn't start.
 * - A failed full rewrite, or a failed in-place write, leaves no record.
 * - After a full rewrite that renumbered the videos, an edit goes in place onto
 *   the right videos, also with a video that has no embedded frames (whose
 *   dataset keeps its old name).
 * - A large file's open reads its images from the file by name: after a full
 *   rewrite its videos are rebound to the written file (covered in
 *   rebindEmbeddedVideos.test.ts). If that fails and the rewrite renumbered
 *   them, the user is told to reopen, and a further full save is refused until
 *   then (it would copy another video's images).
 *
 * Packages are app-written from `sleap_io_multi_noshape.pkg.slp` (A: frames 2
 * and 5, B: frame 3, C: frame 4, D: no embedded frames). The app's in-memory
 * writer is stood in for by building the bytes from a fresh read of the
 * package first opened, with the video list it is given, as the labels here
 * are loaded with their videos closed.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "../bun-test";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sioModule from "@talmolab/sleap-io.js";
import { ready, File as H5File } from "h5wasm/node";

const sio = { ...sioModule } as typeof sioModule & {
  writeLabelTablesInPlace: (file: unknown, update: unknown) => void;
};

let current = "";
const fileOps: string[] = [];
const hooks: {
  /** Runs inside the full-rewrite writer, after the bytes are built. */
  duringWrite?: () => void | Promise<void>;
  failWrite?: boolean;
  failInPlaceAfterWrite?: boolean;
  /** Fail the rebind's reader open (the only open that names its file). */
  failRebindOpen?: boolean;
  origin?: string;
  originIndex?: Map<unknown, number>;
} = {};

class H5Reader {
  private f: H5File | null = null;
  async openRange(_source?: unknown, options?: { filenameHint?: string }) {
    if (hooks.failRebindOpen && options?.filenameHint) throw new Error("injected open failure");
    await ready;
    this.f = new H5File(current, "r");
  }
  keys() {
    return this.f!.keys();
  }
  async getDatasetMeta(path: string) {
    const ds = this.f!.get(path) as { shape?: number[]; metadata?: unknown } | null;
    return { shape: ds?.shape, metadata: ds?.metadata ?? {} };
  }
  async getDatasetValue(path: string, slice?: Array<[number, number] | []>) {
    const ds = this.f!.get(path) as { value: unknown; slice: (s: unknown) => unknown };
    return { value: slice ? ds.slice(slice) : ds.value };
  }
  async getAttrs(path: string) {
    const obj = this.f!.get(path) as { attrs: Record<string, { value: unknown }> };
    return Object.fromEntries(Object.entries(obj.attrs).map(([k, a]) => [k, a.value]));
  }
  async close() {
    this.f?.close();
    this.f = null;
  }
}

class H5Writer {
  async openWrite() {
    fileOps.push("openWrite");
  }
  async updateLabelsInPlace(update: unknown) {
    await ready;
    const f = new H5File(current, "a");
    try {
      sio.writeLabelTablesInPlace(f, update);
    } finally {
      f.close();
    }
    fileOps.push("updateLabelsInPlace");
    if (hooks.failInPlaceAfterWrite) throw new Error("injected failure after writing");
    return { success: true };
  }
  async close() {}
}

/** The app's in-memory full-rewrite writer, from the package first opened. */
async function appSaveSlpToBytes(labels: sioModule.Labels, options: unknown) {
  if (hooks.failWrite) throw new Error("injected write failure");
  fileOps.push("fullRewrite");
  const written = [...labels.videos];
  const copy = await sioModule.loadSlp(hooks.origin!);
  const keep = written.map((v) => copy.videos[hooks.originIndex!.get(v)!]);
  for (const v of copy.videos.filter((v) => !keep.includes(v))) copy.removeVideo(v);
  copy.videos = keep;
  const bytes = await sio.saveSlpToBytes(copy, options as never);
  for (const v of copy.videos) (v.backend as { close?: () => void } | null)?.close?.();
  await hooks.duringWrite?.();
  return bytes;
}

vi.mock("@talmolab/sleap-io.js", () => ({
  ...sio,
  StreamingH5File: H5Reader,
  StreamingH5Writer: H5Writer,
  saveSlpToBytes: (labels: sioModule.Labels, options: unknown) =>
    hooks.origin ? appSaveSlpToBytes(labels, options) : sio.saveSlpToBytes(labels, options as never),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  stat: async (p: string) => {
    const st = statSync(p);
    return { size: st.size, mtime: st.mtime, ino: st.ino, dev: st.dev };
  },
}));
vi.mock("@/lib/nativeRange", () => ({
  fileSize: async (p: string) => statSync(p).size,
  readRange: async () => new Uint8Array(0),
}));
vi.mock("@/lib/nativeWrite", () => ({
  withNativeWriteHandle: <T,>(work: () => Promise<T>) => work(),
  writeOpenAppend: async () => void fileOps.push("writeOpenAppend"),
  writeAt: async () => {},
  readAt: async () => new Uint8Array(0),
  truncateFile: async () => {},
  writeClose: async () => {},
  renameFile: async (a: string, b: string) => renameSync(a, b),
  removeFile: async (p: string) => rmSync(p, { force: true }),
}));
vi.mock("@/platform/index", () => ({
  isTauri: true,
  getPlatform: async () => ({
    isTauri: true,
    writeFile: async (p: string, bytes: Uint8Array) => writeFileSync(p, bytes),
    showSaveDialog: async () => null,
  }),
}));
vi.mock("@/lib/saveEmbeddedPkgStreaming", () => ({
  saveEmbeddedPkgStreaming: async () => {
    throw new Error("streaming not expected here");
  },
  tempPathFor: (p: string) => `${p}.sleap-tmp`,
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
const { commandContext } = await import("@/commands/CommandContext");
const { withLegacyLayout } = await import("@/lib/slpFormatCompat");
const { bindLabelsToFile, bindingRefusal, hasStaleVideoNames, statFileIdentity } = await import(
  "@/lib/inPlaceBinding"
);
const { markDiskBackedVideos } = await import("@/lib/rebindEmbeddedVideos");

const FIXTURE = join(import.meta.dir, "../fixtures/sleap_io_multi_noshape.pkg.slp");
const tmp = mkdtempSync(join(tmpdir(), "sleap-app-save-record-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let copies = 0;

beforeEach(() => {
  Object.defineProperty(globalThis, "crossOriginIsolated", { value: true, configurable: true });
  const g = globalThis as { SharedArrayBuffer?: unknown };
  g.SharedArrayBuffer ??= ArrayBuffer;
  fileOps.length = 0;
  toasts.length = 0;
  for (const k of Object.keys(hooks)) delete (hooks as Record<string, unknown>)[k];
  useAppStore.setState(useAppStore.getInitialState());
});

/** An app-written package of the fixture's videos `keep`, in that order. */
async function appPackage(keep: number[]): Promise<string> {
  const labels = await sioModule.loadSlp(FIXTURE);
  const kept = keep.map((i) => labels.videos[i]);
  for (const v of labels.videos.filter((v) => !kept.includes(v))) labels.removeVideo(v);
  labels.videos = kept;
  const path = join(tmp, `app-${copies++}.pkg.slp`);
  writeFileSync(path, await sio.saveSlpToBytes(labels, withLegacyLayout({})));
  return path;
}

/** Open a copy as loadProjectFromPath does (stat, read, setLabels, record). */
async function openAsApp(source: string) {
  current = join(tmp, `open-${copies++}.pkg.slp`);
  copyFileSync(source, current);
  const identity = await statFileIdentity(current);
  const labels = await sioModule.loadSlp(current, { openVideos: false });
  useAppStore.getState().setLabels(labels, "proj.pkg.slp", current);
  bindLabelsToFile(labels, current, identity, "loaded");
  hooks.origin = source;
  hooks.originIndex = new Map(labels.videos.map((v, i) => [v, i]));
  fileOps.length = 0;
  return labels;
}

/** Give each embedded video a deferred backend on the project file (large-file open). */
function loadAsLargeFile(labels: sioModule.Labels) {
  const path = current;
  const withFile = async <T,>(fn: (f: H5File) => T): Promise<T> => {
    await ready;
    const f = new H5File(path, "r");
    try {
      return fn(f);
    } finally {
      f.close();
    }
  };
  for (const v of labels.videos) {
    (v as { backend: unknown }).backend = new sioModule.StreamingHdf5VideoBackend({
      filename: path,
      h5file: {
        getKeys: (p: string) => withFile((f) => (f.get(p) as { keys: () => string[] }).keys()),
        getDatasetValue: (p: string) =>
          withFile((f) => ({ value: (f.get(p) as { value: unknown }).value })),
        getAttrs: (p: string) =>
          withFile((f) =>
            Object.fromEntries(
              Object.entries((f.get(p) as { attrs: Record<string, { value: unknown }> }).attrs).map(
                ([k, a]) => [k, a.value]
              )
            )
          ),
        getDatasetMeta: (p: string) =>
          withFile((f) => {
            const d = f.get(p) as { shape: number[]; dtype: string };
            return { shape: d.shape, dtype: d.dtype };
          }),
      } as never,
      datasetPath: v.backendMetadata.dataset as string,
      format: "png",
      shape: v.backendMetadata.shape as never,
      deferred: true,
    });
  }
  markDiskBackedVideos(labels);
}

/** Each labeled frame of the file as `video{i}@frame`. */
async function fileFrames(path: string): Promise<string[]> {
  const back = await sioModule.loadSlp(path, { openVideos: false });
  return back.labeledFrames.map((fr) => `video${back.videos.indexOf(fr.video)}@${fr.frameIdx}`);
}

/** The stored frame numbers of each embedded entry of the file. */
async function fileImages(path: string): Promise<string[]> {
  await ready;
  const f = new H5File(path, "r");
  try {
    const vj = (f.get("videos_json") as { value: ArrayLike<unknown> }).value;
    return Array.from(vj, (raw) => {
      const e = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw as Uint8Array));
      const group = (e.backend.dataset as string).replace(/\/video$/, "");
      const fn = f.keys().includes(group)
        ? Array.from((f.get(`${group}/frame_numbers`) as { value: ArrayLike<number> }).value, Number)
        : [];
      return `${e.backend.dataset}:${JSON.stringify(fn)}`;
    });
  } finally {
    f.close();
  }
}

function movePoint(labels: sioModule.Labels, x: number) {
  labels.labeledFrames[0].instances[0].points[0].xy = [x, x + 1];
}

describe("Save records the video list it wrote", () => {
  it("a list changed while the rewrite ran is not recorded; the next save rewrites in full", async () => {
    const labels = await openAsApp(await appPackage([0, 1, 2]));
    const [A, B, C] = labels.videos;
    const allFrames = [...labels.labeledFrames];
    labels.removeVideo(A); // written: [B, C]
    hooks.duringWrite = () => {
      // A redo restoring [A, B], as the review's sequence does.
      labels.videos = [A, B];
      labels.labeledFrames.length = 0;
      labels.labeledFrames.push(...allFrames.filter((f) => f.video === A || f.video === B));
    };
    await saveProjectAsSlp(labels, "proj.pkg.slp");
    delete hooks.duringWrite;
    expect(await fileImages(current)).toEqual(["video0/video:[3]", "video1/video:[4]"]);
    expect(bindingRefusal(labels, current, await statFileIdentity(current))).toMatch(/no record/);

    // The next save: a point of A's, now in full, A and B as they are.
    movePoint(labels, 41);
    fileOps.length = 0;
    await saveProjectAsSlp(labels, "proj.pkg.slp");
    expect(fileOps).toEqual(["fullRewrite"]);
    expect(await fileImages(current)).toEqual(["video0/video:[2,5]", "video1/video:[3]"]);
    expect(await fileFrames(current)).toEqual(["video0@2", "video0@5", "video1@3"]);
    void C;
  });

  it("refuses undo, redo and edits while a save runs, and a second save", async () => {
    const labels = await openAsApp(await appPackage([0, 1]));
    labels.removeVideo(labels.videos[0]);
    const during: unknown[] = [];
    hooks.duringWrite = async () => {
      during.push(commandContext.undo(), commandContext.redo());
      await saveProjectAsSlp(labels, "proj.pkg.slp");
    };
    await saveProjectAsSlp(labels, "proj.pkg.slp");
    expect(during).toEqual([false, false]);
    expect(fileOps).toEqual(["fullRewrite"]); // the second save didn't start
    expect(toasts.some((t) => t.startsWith("info: Saving…"))).toBe(true);
    expect(toasts).toContain("info: A save is already running — Wait for it to finish before saving again.");
  });

  it("leaves no record after a failed full rewrite or a failed in-place write", async () => {
    const labels = await openAsApp(await appPackage([0, 1, 2]));
    labels.removeVideo(labels.videos[0]);
    hooks.failWrite = true;
    await saveProjectAsSlp(labels, "proj.pkg.slp");
    expect(toasts.filter((t) => t.startsWith("error:"))).toHaveLength(1);
    expect(bindingRefusal(labels, current, await statFileIdentity(current))).toMatch(/no record/);

    const other = await openAsApp(await appPackage([0, 1, 2]));
    hooks.failInPlaceAfterWrite = true;
    movePoint(other, 3);
    await saveProjectAsSlp(other, "proj.pkg.slp");
    expect(bindingRefusal(other, current, await statFileIdentity(current))).toMatch(/no record/);
  });

  for (const [label, keep] of [
    ["A, B, C, D (D has no embedded frames)", [0, 1, 2, 3]],
    ["A, D, B", [0, 3, 1]],
  ] as Array<[string, number[]]>) {
    it(`${label}: remove A, save, edit, save: in place, onto the right videos`, async () => {
      const labels = await openAsApp(await appPackage(keep));
      labels.removeVideo(labels.videos[0]);
      await saveProjectAsSlp(labels, "proj.pkg.slp");
      expect(fileOps).toEqual(["fullRewrite"]);
      const framesBefore = await fileFrames(current);
      movePoint(labels, 9);
      fileOps.length = 0;
      await saveProjectAsSlp(labels, "proj.pkg.slp");
      expect(fileOps).toContain("updateLabelsInPlace");
      expect(fileOps).not.toContain("fullRewrite");
      expect(await fileFrames(current)).toEqual(framesBefore);
    });
  }
});

describe("a large file's open after a full rewrite that renumbered its videos", () => {
  it("rebinds its videos: no warning, and a further full save goes ahead", async () => {
    const labels = await openAsApp(await appPackage([0, 1, 2]));
    loadAsLargeFile(labels);
    labels.removeVideo(labels.videos[0]); // B and C get new names
    await saveProjectAsSlp(labels, "proj.pkg.slp");
    expect(hasStaleVideoNames(labels)).toBe(false);
    expect(toasts.filter((t) => t.startsWith("warning:"))).toEqual([]);
    expect(labels.videos.map((v) => (v.backend as { dataset?: string }).dataset)).toEqual([
      "video0/video",
      "video1/video",
    ]);
    labels.removeVideo(labels.videos[1]);
    fileOps.length = 0;
    await saveProjectAsSlp(labels, "proj.pkg.slp");
    expect(fileOps).toEqual(["fullRewrite"]);
  });

  it("when the rebind fails: asks to reopen, and refuses another full save until then; an in-place save still runs", async () => {
    const labels = await openAsApp(await appPackage([0, 1, 2]));
    loadAsLargeFile(labels);
    labels.removeVideo(labels.videos[0]); // B and C get new names
    hooks.failRebindOpen = true;
    await saveProjectAsSlp(labels, "proj.pkg.slp");
    expect(hasStaleVideoNames(labels)).toBe(true);
    expect(toasts.some((t) => t.startsWith("warning: Reopen this project"))).toBe(true);

    // An edit that keeps the video list: in place (no image is copied).
    movePoint(labels, 5);
    fileOps.length = 0;
    await saveProjectAsSlp(labels, "proj.pkg.slp");
    expect(fileOps).toContain("updateLabelsInPlace");

    // Another full save would copy images under the old names: refused.
    labels.removeVideo(labels.videos[1]);
    const before = readFileSync(current);
    fileOps.length = 0;
    toasts.length = 0;
    await saveProjectAsSlp(labels, "proj.pkg.slp");
    expect(fileOps).toEqual([]);
    expect(toasts.some((t) => t.startsWith("error: Reopen this project"))).toBe(true);
    expect(readFileSync(current).equals(before)).toBe(true);
  });

  it("doesn't ask when nothing was renumbered (the last video removed)", async () => {
    const labels = await openAsApp(await appPackage([0, 1, 2]));
    loadAsLargeFile(labels);
    labels.removeVideo(labels.videos[2]);
    await saveProjectAsSlp(labels, "proj.pkg.slp");
    expect(hasStaleVideoNames(labels)).toBe(false);
    expect(toasts.filter((t) => t.startsWith("warning:"))).toEqual([]);
  });
});
