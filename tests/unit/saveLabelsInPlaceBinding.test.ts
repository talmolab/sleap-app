/**
 * The fast in-place save patches a package only when the file is the one the
 * app last read or wrote, unchanged since, and the loaded videos map one to
 * one, in order, onto its entries (`inPlaceBinding.ts`). These sequences
 * defeated a check of dataset names alone:
 *
 * - Remove a video, Save (refused in place, so the file is rewritten and its
 *   datasets renumbered), Undo (the removed video comes back with its old
 *   dataset name), remove another video, Save: the names matched the
 *   renumbered file, and the labels of one video would have gone onto
 *   another's images. Now refused.
 * - The file replaced on disk by another package of the same layout. Now
 *   refused.
 *
 * And what still goes in place: a point edit after opening, a second one after
 * the first, and an edit after a full rewrite that renumbered the videos. The
 * check after writing also catches a changed `videos_json` entry or video
 * attribute, and a failed read, with the "reopen to check" guidance.
 *
 * Packages are written by the app (sleap-io.js's in-memory writer) from the
 * fixture `sleap_io_multi_noshape.pkg.slp`'s videos; its booleans become uint8,
 * so every case runs on any sleap-io.js. The streaming reader and writer are
 * stood in for by h5wasm on the file, the writer calling sleap-io.js's
 * `writeLabelTablesInPlace`.
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
  afterWrite?: (f: H5File) => void;
  failVerifyRead?: string;
  changeVideosJsonAfterWrite?: boolean;
} = {};

class H5Reader {
  private f: H5File | null = null;
  async openRange() {
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
    const written = fileOps.includes("updateLabelsInPlace");
    if (written && hooks.failVerifyRead === path) throw new Error("injected read failure");
    const ds = this.f!.get(path) as { value: unknown; slice: (s: unknown) => unknown };
    if (written && hooks.changeVideosJsonAfterWrite && path === "videos_json") {
      const values = Array.from(ds.value as ArrayLike<unknown>, (v) =>
        typeof v === "string" ? v : new TextDecoder().decode(v as Uint8Array)
      );
      return {
        value: values.map((v, i) =>
          i === 1 ? v.replace('"convert_range":false', '"convert_range":true') : v
        ),
      };
    }
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
      hooks.afterWrite?.(f);
    } finally {
      f.close();
    }
    fileOps.push("updateLabelsInPlace");
    return { success: true };
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
    return { size: st.size, mtime: st.mtime };
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
}));

const { saveLabelsInPlace } = await import("@/lib/saveLabelsInPlace");
const { withLegacyLayout } = await import("@/lib/slpFormatCompat");
const { bindLabelsToFile, clearFileBinding, statFileIdentity } = await import(
  "@/lib/inPlaceBinding"
);

const FIXTURE = join(import.meta.dir, "../fixtures/sleap_io_multi_noshape.pkg.slp");
const tmp = mkdtempSync(join(tmpdir(), "sleap-app-binding-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let copies = 0;

beforeEach(() => {
  Object.defineProperty(globalThis, "crossOriginIsolated", { value: true, configurable: true });
  const g = globalThis as { SharedArrayBuffer?: unknown };
  g.SharedArrayBuffer ??= ArrayBuffer;
  fileOps.length = 0;
  delete hooks.afterWrite;
  delete hooks.failVerifyRead;
  delete hooks.changeVideosJsonAfterWrite;
});

/**
 * A package the app wrote, of the fixture's videos `keep` (A, B: colour 32x32,
 * C: grayscale 32x32, D: no embedded frames).
 */
async function appPackage(keep: number[]): Promise<string> {
  const labels = await sio.loadSlp(FIXTURE);
  for (const v of labels.videos.filter((_, i) => !keep.includes(i))) labels.removeVideo(v);
  const path = join(tmp, `app-${copies++}.pkg.slp`);
  writeFileSync(path, await sio.saveSlpToBytes(labels, withLegacyLayout({})));
  return path;
}

/** A deferred backend's file (the large-file open), on h5wasm per call. */
function lazyFile(path: string) {
  const withFile = async <T,>(fn: (f: H5File) => T): Promise<T> => {
    await ready;
    const f = new H5File(path, "r");
    try {
      return fn(f);
    } finally {
      f.close();
    }
  };
  return {
    getKeys: (p: string) => withFile((f) => (f.get(p) as { keys: () => string[] }).keys()),
    getDatasetValue: (p: string) => withFile((f) => ({ value: (f.get(p) as { value: unknown }).value })),
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
  };
}

/** Open a copy of `source` as the app does (eager, or large-file deferred). */
async function open(source: string, lazy = false) {
  current = join(tmp, `open-${copies++}.pkg.slp`);
  copyFileSync(source, current);
  const identity = await statFileIdentity(current);
  const labels = await sio.loadSlp(current, { openVideos: false });
  if (lazy) {
    for (const v of labels.videos) {
      if (!v.hasEmbeddedImages) continue;
      (v as { backend: unknown }).backend = new sio.StreamingHdf5VideoBackend({
        filename: current,
        h5file: lazyFile(current) as never,
        datasetPath: v.backendMetadata.dataset as string,
        format: "png",
        shape: v.backendMetadata.shape as never,
        deferred: true,
      });
    }
  }
  bindLabelsToFile(labels, current, identity, "loaded");
  fileOps.length = 0;
  return labels;
}

/**
 * The app's full rewrite (saveProject.ts): forget the binding, write the file
 * anew (atomically) with `labels`' videos, then record it as written. The
 * bytes come from a fresh read of the file with the same change, since the
 * labels here are loaded with their videos closed.
 */
async function fullRewrite(labels: sioModule.Labels, change: (copy: sioModule.Labels) => void) {
  clearFileBinding(labels);
  const copy = await sio.loadSlp(current);
  change(copy);
  const bytes = await sio.saveSlpToBytes(copy, withLegacyLayout({}));
  for (const v of copy.videos) (v.backend as { close?: () => void } | null)?.close?.();
  writeFileSync(`${current}.tmp`, bytes);
  renameSync(`${current}.tmp`, current);
  bindLabelsToFile(labels, current, await statFileIdentity(current), "written");
}

/** Each labeled frame of the file as `video{i}@frame`. */
async function fileFrames(path: string): Promise<string[]> {
  const back = await sio.loadSlp(path, { openVideos: false });
  return back.labeledFrames.map((f) => `video${back.videos.indexOf(f.video)}@${f.frameIdx}`);
}

function movePoint(labels: sioModule.Labels, x: number) {
  labels.labeledFrames[0].instances[0].points[0].xy = [x, x + 1];
}

async function expectRefused(labels: sioModule.Labels, reason: RegExp) {
  const before = readFileSync(current);
  const res = await saveLabelsInPlace(labels, current);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.reason).toMatch(reason);
  expect(fileOps).toEqual([]);
  expect(readFileSync(current).equals(before)).toBe(true);
}

async function expectInPlace(labels: sioModule.Labels) {
  fileOps.length = 0;
  expect(await saveLabelsInPlace(labels, current)).toEqual({ ok: true });
  expect(fileOps).toContain("updateLabelsInPlace");
}

describe("in-place save: the file and its videos must be the ones loaded", () => {
  for (const [label, keep, first, second] of [
    ["A, B, C: remove A, save, undo, remove C", [0, 1, 2], 0, 2],
    ["A, C: remove A, save, undo, remove C", [0, 2], 0, 1],
    ["A, B (same size): remove A, save, undo, remove B", [0, 1], 0, 1],
  ] as Array<[string, number[], number, number]>) {
    for (const lazy of [false, true]) {
      it(`${label}${lazy ? " (large-file load)" : ""}: refused`, async () => {
        const labels = await open(await appPackage(keep), lazy);
        // An undoable edit: its snapshot holds the video list and the frames.
        const snapshotVideos = [...labels.videos];
        const snapshotFrames = [...labels.labeledFrames];
        const removed = labels.videos[first];
        labels.removeVideo(removed);
        await expectRefused(labels, /video list changed/);
        await fullRewrite(labels, (copy) => copy.removeVideo(copy.videos[first]));

        // Undo (restoreSnapshot), then remove the other video and edit.
        labels.videos = [...snapshotVideos];
        labels.labeledFrames = [...snapshotFrames];
        labels.removeVideo(snapshotVideos[second]);
        movePoint(labels, 11);
        await expectRefused(labels, /video list changed/);
      });
    }
  }

  it("refuses a file replaced on disk by another package of the same layout", async () => {
    const labels = await open(await appPackage([0]));
    copyFileSync(await appPackage([2]), current); // another program replaces it
    movePoint(labels, 31);
    await expectRefused(labels, /changed on disk/);
  });

  it("refuses labels the app has no record of (opened some other way)", async () => {
    const path = await appPackage([0, 1]);
    current = join(tmp, `unbound-${copies++}.pkg.slp`);
    copyFileSync(path, current);
    const labels = await sio.loadSlp(current, { openVideos: false });
    movePoint(labels, 5);
    await expectRefused(labels, /no record of this file/);
  });

  it("refuses an embedded video whose dataset the open could not tell", async () => {
    const path = await appPackage([0, 1]);
    current = join(tmp, `nodataset-${copies++}.pkg.slp`);
    copyFileSync(path, current);
    const labels = await sio.loadSlp(current, { openVideos: false });
    const md = { ...labels.videos[1].backendMetadata };
    delete md.dataset;
    labels.videos[1].backendMetadata = md;
    bindLabelsToFile(labels, current, await statFileIdentity(current), "loaded");
    movePoint(labels, 5);
    await expectRefused(labels, /dataset is unknown/);
  });

  it("saves in place after opening, and again after that", async () => {
    const labels = await open(await appPackage([0, 1, 2]));
    movePoint(labels, 1);
    await expectInPlace(labels);
    movePoint(labels, 2);
    await expectInPlace(labels);
    const back = await sio.loadSlp(current, { openVideos: false });
    expect(back.labeledFrames[0].instances[0].points[0].xy[0]).toBe(2);
  });

  it("saves in place after a full rewrite that renumbered the videos, onto the right ones", async () => {
    const labels = await open(await appPackage([0, 1, 2]));
    labels.removeVideo(labels.videos[0]);
    await expectRefused(labels, /video list changed/);
    await fullRewrite(labels, (copy) => copy.removeVideo(copy.videos[0]));
    const framesBefore = await fileFrames(current);
    movePoint(labels, 21);
    await expectInPlace(labels);
    // B's frame and C's frame are still on B's and C's images.
    expect(await fileFrames(current)).toEqual(framesBefore);
    expect(framesBefore).toEqual(["video0@3", "video1@4"]);
  });
});

describe("the check after an in-place write", () => {
  it("throws when a videos_json entry differs after writing", async () => {
    const labels = await open(await appPackage([0, 1, 2]));
    hooks.changeVideosJsonAfterWrite = true;
    movePoint(labels, 7);
    await expect(saveLabelsInPlace(labels, current)).rejects.toThrow(
      /videos_json changed after write — save may be inconsistent, reopen to check/
    );
  });

  it("throws when an embedded video's attribute changed after writing", async () => {
    const labels = await open(await appPackage([0, 1, 2]));
    hooks.afterWrite = (f) => {
      const ds = f.get("video1/video") as {
        create_attribute: (n: string, v: unknown) => void;
        delete_attribute: (n: string) => void;
      };
      ds.delete_attribute("frames");
      ds.create_attribute("frames", 99);
    };
    movePoint(labels, 7);
    await expect(saveLabelsInPlace(labels, current)).rejects.toThrow(
      /attributes changed after write — save may be inconsistent, reopen to check/
    );
  });

  it("says a failed read can't confirm the write, with the same guidance", async () => {
    const labels = await open(await appPackage([0, 1, 2]));
    hooks.failVerifyRead = "videos_json";
    movePoint(labels, 7);
    await expect(saveLabelsInPlace(labels, current)).rejects.toThrow(
      /could not read the file back to check it \(injected read failure\) — save may be inconsistent, reopen to check/
    );
  });
});
