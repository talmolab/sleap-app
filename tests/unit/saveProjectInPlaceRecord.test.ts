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
 *   rewrite that renumbered them the user is told to reopen, and a further
 *   full save is refused until then (it would copy another video's images).
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
  /** The reader fails (the read-back after a full rewrite). */
  failReadBack?: boolean;
  /** The next stat fails. */
  statThrowOnce?: boolean;
  /** Save As picks this path. */
  saveAsPath?: string;
  /** Use sleap-io.js's real in-memory writer, reading through the backends. */
  realWriter?: boolean;
  origin?: string;
  originIndex?: Map<unknown, number>;
} = {};

class H5Reader {
  private f: H5File | null = null;
  async openRange() {
    if (hooks.failReadBack) throw new Error("injected read-back failure");
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
  saveSlpToBytes: async (labels: sioModule.Labels, options: unknown) => {
    if (hooks.realWriter) {
      if (hooks.failWrite) throw new Error("injected write failure");
      fileOps.push("fullRewrite");
      const bytes = await sio.saveSlpToBytes(labels, options as never);
      await hooks.duringWrite?.();
      return bytes;
    }
    return hooks.origin ? appSaveSlpToBytes(labels, options) : sio.saveSlpToBytes(labels, options as never);
  },
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  stat: async (p: string) => {
    if (hooks.statThrowOnce) {
      hooks.statThrowOnce = false;
      throw new Error("injected stat failure");
    }
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
  consumeLastBrowserFileHandle: () => null,
  getPlatform: async () => ({
    isTauri: true,
    writeFile: async (p: string, bytes: Uint8Array) => writeFileSync(p, bytes),
    showSaveDialog: async () => hooks.saveAsPath ?? null,
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
const { isSaveInProgress } = await import("@/lib/saveInProgress");
const { confirmDiscardUnsavedWork } = await import("@/lib/unsavedGuard");
const { refuseEditIfViewOnly } = await import("@/lib/slpAccess");
const { exportLabelsPackage } = await import("@/commands/exportPackageCommands");
const { buildRemoteLabelsPayload } = await import("@/lib/remoteLabelsPayload");
const { markDiskBackedVideos } = await import("@/lib/diskBackedVideos");
const { useAppStore } = await import("@/stores/appStore");
const { commandContext } = await import("@/commands/CommandContext");
const { withLegacyLayout } = await import("@/lib/slpFormatCompat");
const { bindLabelsToFile, bindingRefusal, hasStaleVideoNames, statFileIdentity } = await import(
  "@/lib/inPlaceBinding"
);

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

/**
 * Give each embedded video a deferred backend on the project file, as a large
 * file's open does; `disk` false gives the same backend class without noting
 * it as reading the disk, as the app's eager path does (its reader holds the
 * file's bytes in memory).
 */
function loadAsLargeFile(labels: sioModule.Labels, disk = true) {
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
  if (disk) markDiskBackedVideos(labels);
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
  it("asks to reopen, and refuses another full save until then; an in-place save still runs", async () => {
    const labels = await openAsApp(await appPackage([0, 1, 2]));
    loadAsLargeFile(labels);
    labels.removeVideo(labels.videos[0]); // B and C get new names
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

describe("full saves that copy images from the project file (fifth review)", () => {
  it("marks a large file's labels when the written file can't be read back, and refuses the next full save", async () => {
    const labels = await openAsApp(await appPackage([0, 1, 2]));
    loadAsLargeFile(labels);
    hooks.realWriter = true;
    labels.removeVideo(labels.videos[0]); // B and C renumbered
    hooks.duringWrite = () => {
      hooks.failReadBack = true;
    };
    await saveProjectAsSlp(labels, "proj.pkg.slp");
    hooks.failReadBack = false;
    expect(hasStaleVideoNames(labels)).toBe(true);
    expect(toasts.some((t) => t.startsWith("warning: Reopen this project"))).toBe(true);

    labels.removeVideo(labels.videos[1]);
    const before = readFileSync(current);
    fileOps.length = 0;
    await saveProjectAsSlp(labels, "proj.pkg.slp");
    expect(fileOps).toEqual([]);
    expect(readFileSync(current).equals(before)).toBe(true);
  });

  it("marks them too when the stat right after the write fails", async () => {
    const labels = await openAsApp(await appPackage([0, 1, 2]));
    loadAsLargeFile(labels);
    hooks.realWriter = true;
    labels.removeVideo(labels.videos[0]);
    hooks.duringWrite = () => {
      hooks.statThrowOnce = true;
    };
    await saveProjectAsSlp(labels, "proj.pkg.slp");
    expect(hasStaleVideoNames(labels)).toBe(true);
  });

  it("refuses a full save of a large file's project when the file changed on disk", async () => {
    const labels = await openAsApp(await appPackage([0, 1, 2]));
    loadAsLargeFile(labels);
    hooks.realWriter = true;
    // Another program rewrites the project with B and A swapped.
    copyFileSync(await appPackage([1, 0, 2]), `${current}.ext`);
    renameSync(`${current}.ext`, current);
    const replaced = readFileSync(current);
    movePoint(labels, 7);
    fileOps.length = 0;
    await saveProjectAsSlp(labels, "proj.pkg.slp");
    expect(fileOps).toEqual([]);
    expect(readFileSync(current).equals(replaced)).toBe(true);
    expect(toasts.some((t) => t.startsWith("error: The project file changed on disk"))).toBe(true);
    expect(hasStaleVideoNames(labels)).toBe(true);

    // Save As would read the same file: refused as well.
    hooks.saveAsPath = join(tmp, `saveas-${copies++}.pkg.slp`);
    fileOps.length = 0;
    await saveProjectAsSlp(labels, "proj.pkg.slp", true);
    expect(fileOps).toEqual([]);
  });

  it("refuses exports and training copies while the labels are marked", async () => {
    const labels = await openAsApp(await appPackage([0, 1, 2]));
    loadAsLargeFile(labels);
    labels.removeVideo(labels.videos[0]);
    await saveProjectAsSlp(labels, "proj.pkg.slp");
    expect(hasStaleVideoNames(labels)).toBe(true);
    toasts.length = 0;
    expect(await exportLabelsPackage(labels, "proj.pkg.slp", "user")).toBeNull();
    expect(toasts.some((t) => t.startsWith("error: Reopen this project before exporting"))).toBe(true);
    await expect(
      buildRemoteLabelsPayload(labels, labels.videos.map(() => ({ visible: false })) as never, {
        embedFramesToPredict: false,
      })
    ).rejects.toThrow(/Reopen the project first/);
  });

  it("an eager load (images in memory) is not marked, and saves in a row stay on the right images", async () => {
    const labels = await openAsApp(await appPackage([0, 1, 2, 3]));
    const ops: string[] = [];
    const save = async () => {
      fileOps.length = 0;
      await saveProjectAsSlp(labels, "proj.pkg.slp");
      ops.push(fileOps.includes("updateLabelsInPlace") ? "in place" : fileOps.join(","));
    };
    movePoint(labels, 1);
    await save();
    labels.removeVideo(labels.videos[1]);
    await save();
    movePoint(labels, 2);
    await save();
    labels.removeVideo(labels.videos[0]);
    await save();
    movePoint(labels, 3);
    await save();
    expect(ops).toEqual(["in place", "fullRewrite", "in place", "fullRewrite", "in place"]);
    expect(hasStaleVideoNames(labels)).toBe(false);
    expect(await fileImages(current)).toEqual(["video0/video:[4]", "video3/video:[]"]);
    expect(await fileFrames(current)).toEqual(["video0@4"]);
  });
});

describe("only readers of the file on disk are checked for stale names", () => {
  it("an eager load with streaming backends over the file's bytes is not marked, and saves in full", async () => {
    const labels = await openAsApp(await appPackage([0, 1, 2]));
    loadAsLargeFile(labels, false); // the app's eager path: same class, bytes in memory
    labels.removeVideo(labels.videos[0]); // B and C renumbered
    await saveProjectAsSlp(labels, "proj.pkg.slp");
    expect(hasStaleVideoNames(labels)).toBe(false);
    expect(toasts.filter((t) => t.startsWith("warning:") || t.startsWith("error:"))).toEqual([]);
    labels.removeVideo(labels.videos[1]);
    fileOps.length = 0;
    await saveProjectAsSlp(labels, "proj.pkg.slp");
    expect(fileOps).toEqual(["fullRewrite"]);
  });
});

describe("the save guard covers more than commands (fifth review)", () => {
  it("refuses opening or importing another project, and direct edits, while a save runs", async () => {
    const labels = await openAsApp(await appPackage([0, 1]));
    labels.removeVideo(labels.videos[0]);
    const during: unknown[] = [];
    hooks.duringWrite = async () => {
      during.push(await confirmDiscardUnsavedWork("Importing a project"), refuseEditIfViewOnly());
    };
    await saveProjectAsSlp(labels, "proj.pkg.slp");
    expect(during).toEqual([false, true]);
    expect(isSaveInProgress()).toBe(false);
  });

  it("a project replaced during a Save As doesn't take the new path or lose its changes", async () => {
    const labels = await openAsApp(await appPackage([0, 1]));
    const saveAs = join(tmp, `saveas-${copies++}.pkg.slp`);
    hooks.saveAsPath = saveAs;
    const imported = new sioModule.Labels({ skeletons: [labels.skeletons[0]] });
    imported.addVideo(new sioModule.Video({ filename: "/elsewhere/ext.mp4" }));
    hooks.duringWrite = () => {
      // As if an import got past the guard and replaced the project.
      useAppStore.getState().setLabels(imported, "imp.analysis.h5", "/elsewhere/imp.analysis.h5");
      useAppStore.getState().markChanged();
    };
    await saveProjectAsSlp(labels, "proj.pkg.slp", true);
    const st = useAppStore.getState();
    expect(st.labels).toBe(imported);
    expect(st.projectPath).toBe("/elsewhere/imp.analysis.h5");
    expect(st.filename).toBe("imp.analysis.h5");
    expect(st.hasChanges).toBe(true);
  });

  it("clears the busy flag on every early return and error", async () => {
    const labels = await openAsApp(await appPackage([0, 1, 2]));
    await saveProjectAsSlp(labels, "proj.pkg.slp", true); // Save As cancelled
    expect(isSaveInProgress()).toBe(false);
    labels.removeVideo(labels.videos[0]);
    hooks.failWrite = true;
    await saveProjectAsSlp(labels, "proj.pkg.slp");
    expect(isSaveInProgress()).toBe(false);
  });
});
