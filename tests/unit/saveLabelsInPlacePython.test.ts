/**
 * The fast in-place save on a 2.x package written by Python sleap-io (#513),
 * whose point tables store `visible` / `complete` as HDF5 booleans (enum
 * members) and whose `videos_json` carries no shape for the embedded video.
 *
 * The app's own `saveLabelsInPlace` runs against a copy of the fixture
 * `python_minimal_instance.pkg.slp` (from Python sleap-io's test data), with
 * the real gate, update builder and table writer of the installed
 * sleap-io.js. Only the file access is replaced: the streaming reader and
 * writer (a Worker over native file handles in the app) are stood in for by
 * h5wasm on the file itself, the writer calling sleap-io.js's
 * `writeLabelTablesInPlace` (its main-thread twin).
 *
 * - A sleap-io.js that patches boolean members (talmolab/sleap-io.js#285 and
 *   later) saves the point edit in place: the file reads back with it, its
 *   booleans are still booleans, and the embedded frames are untouched.
 * - An older one (the pinned 0.5.16) refuses, as before: the save falls back
 *   to a full rewrite and the file is not touched.
 * - On either, that full rewrite stores the flags as uint8, so the save after
 *   it is fast.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "../bun-test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sioModule from "@talmolab/sleap-io.js";
import { ready, File as H5File } from "h5wasm/node";

// The real library, copied before it is mocked below.
const sio = { ...sioModule } as typeof sioModule & {
  writeLabelTablesInPlace: (file: unknown, update: unknown) => void;
  resolveSlpVersion?: unknown;
};
/** talmolab/sleap-io.js#285 (the format 3.0 writer, which patches booleans). */
const PATCHES_BOOLEANS = typeof sio.resolveSlpVersion === "function";

let current = "";
const fileOps: string[] = [];

/** The streaming reader, on h5wasm over the file at `current`. */
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

/** The streaming writer: sleap-io.js's in-place table writer on the file. */
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
    return { success: true };
  }
  async close() {}
}

vi.mock("@talmolab/sleap-io.js", () => ({
  ...sio,
  StreamingH5File: H5Reader,
  StreamingH5Writer: H5Writer,
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

const FIXTURE = join(import.meta.dir, "../fixtures/python_minimal_instance.pkg.slp");
const tmp = mkdtempSync(join(tmpdir(), "sleap-app-inplace-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** HDF5 type class of each `points` member (8 = enum, h5py's bool). */
async function pointMemberTypes(path: string): Promise<Record<string, number>> {
  await ready;
  const f = new H5File(path, "r");
  try {
    const members = (
      f.get("points") as { metadata: { compound_type: { members: Array<{ name: string; type: number }> } } }
    ).metadata.compound_type.members;
    return Object.fromEntries(members.map((m) => [m.name, m.type]));
  } finally {
    f.close();
  }
}

/** The embedded image bytes of `video0`. */
async function embeddedBytes(path: string): Promise<Uint8Array> {
  await ready;
  const f = new H5File(path, "r");
  try {
    const v = (f.get("video0/video") as { value: ArrayLike<number> }).value;
    return new Uint8Array(Array.from(v, (x) => Number(x) & 0xff));
  } finally {
    f.close();
  }
}

beforeEach(() => {
  fileOps.length = 0;
  Object.defineProperty(globalThis, "crossOriginIsolated", { value: true, configurable: true });
  const g = globalThis as { SharedArrayBuffer?: unknown };
  g.SharedArrayBuffer ??= ArrayBuffer;
});

describe("saveLabelsInPlace on a Python-written 2.x package (boolean point columns)", () => {
  it("the fixture is what #513 describes", async () => {
    const types = await pointMemberTypes(FIXTURE);
    expect(types.visible).toBe(8);
    expect(types.complete).toBe(8);
  });

  it(
    PATCHES_BOOLEANS
      ? "patches the point edit in place, keeping the booleans and the frames"
      : "falls back to a full rewrite, as before, and leaves the file alone",
    async () => {
      current = join(tmp, `edit-${Date.now()}.pkg.slp`);
      copyFileSync(FIXTURE, current);
      const before = readFileSync(current);
      const frames = await embeddedBytes(current);

      // Videos stay closed: h5wasm can't open the file for writing while a
      // backend holds it open (the app reads it through its own reader).
      const labels = await sio.loadSlp(current, { openVideos: false });
      const point = labels.labeledFrames[0].instances[0].points[0];
      point.xy = [12.5, 34.25];

      const res = await saveLabelsInPlace(labels, current);
      if (!PATCHES_BOOLEANS) {
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.reason).toMatch(/enum|bool/i);
        expect(fileOps).toEqual([]);
        expect(readFileSync(current).equals(before)).toBe(true);
        return;
      }

      expect(res).toEqual({ ok: true });
      expect(fileOps).toEqual(["writeOpenAppend", "openWrite", "updateLabelsInPlace"]);
      const back = await sio.loadSlp(current, { openVideos: false });
      const p = back.labeledFrames[0].instances[0].points[0];
      expect([p.xy[0], p.xy[1]]).toEqual([12.5, 34.25]);
      expect(p.visible).toBe(point.visible);
      // Still Python's layout: booleans, and the same embedded frames.
      const types = await pointMemberTypes(current);
      expect(types.visible).toBe(8);
      expect(types.complete).toBe(8);
      expect(await embeddedBytes(current)).toEqual(frames);
    }
  );

  it("a full rewrite stores the flags as uint8, so the next save can patch in place", async () => {
    // What the fallback writes (the app's full save of an embedded package).
    const { withLegacyLayout } = await import("@/lib/slpFormatCompat");
    const labels = await sio.loadSlp(FIXTURE);
    const bytes = await sio.saveSlpToBytes(labels, withLegacyLayout({}));
    const rewritten = join(tmp, "rewritten.pkg.slp");
    writeFileSync(rewritten, bytes);
    const types = await pointMemberTypes(rewritten);
    expect(types.visible).toBe(0);
    expect(types.complete).toBe(0);
  });
});
