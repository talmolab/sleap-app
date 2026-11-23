/**
 * The fast in-place save on 2.x packages written in Python (#513). Their point
 * tables store `visible` / `complete` as HDF5 booleans (enum members), and
 * their `videos_json` describes embedded videos in other ways than the app's:
 *
 * - `sleap_io_multi.pkg.slp`, written by Python sleap-io 0.10's 2.x writer
 *   (`gen_sleap_io_multi.py`): four embedded videos (two colour of one size, a
 *   grayscale one, one with no embedded frames); the JSON shape counts the
 *   embedded images, the `frames` attribute the source frames; contiguous
 *   tables.
 * - `sleap_io_multi_noshape.pkg.slp`: the same without `backend.shape` and
 *   without the `frames` attribute, as SLEAP 1.x writes them.
 * - `sleap1_minimal_instance.pkg.slp`: written by SLEAP 1.x (format 1.2), one
 *   video, chunked tables.
 *
 * The app's own `saveLabelsInPlace` runs against a copy of each, with the real
 * gate, update builder and table writer of the installed sleap-io.js. Only the
 * file access is replaced: the streaming reader and writer (a Worker over
 * native file handles in the app) are stood in for by h5wasm on the file, the
 * writer calling sleap-io.js's `writeLabelTablesInPlace` (its main-thread
 * twin). Each package is loaded as the app loads small files (eager, videos
 * closed here, since h5wasm can't write a file a backend holds open) and as it
 * loads large ones (a deferred `StreamingHdf5VideoBackend` per embedded video),
 * with no video shown, the first shown (the state after opening), and all.
 *
 * - A sleap-io.js that patches booleans (talmolab/sleap-io.js#285 and later;
 *   detected by asking its gate) saves a point edit in place in every case:
 *   the file reads back with it, booleans still booleans, frames untouched.
 *   An edit that changes row counts is refused: sleap-io writes its tables
 *   contiguous (not resizable).
 * - An older one (the pinned 0.5.16) refuses at the gate, as before; the save
 *   falls back to a full rewrite and the file is not touched. That rewrite
 *   stores the flags as uint8 (the next save is not run here).
 * - The video check reads no embedded image or frame number; the attributes
 *   of the video datasets are read before and after an in-place write only.
 * - A package the app wrote saves in place on either, in every load state.
 * - Swapping two embedded videos of the same size is refused.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "../bun-test";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sioModule from "@talmolab/sleap-io.js";
import { ready, File as H5File } from "h5wasm/node";

// The real library, copied before it is mocked below.
const sio = { ...sioModule } as typeof sioModule & {
  writeLabelTablesInPlace: (file: unknown, update: unknown) => void;
};

let current = "";
const fileOps: string[] = [];
const readerCalls: string[] = [];

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
    readerCalls.push(`value:${path}`);
    const ds = this.f!.get(path) as { value: unknown; slice: (s: unknown) => unknown };
    return { value: slice ? ds.slice(slice) : ds.value };
  }
  async getAttrs(path: string) {
    readerCalls.push(`attrs:${path}`);
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
// The file's size and modification time (the in-place save's baseline).
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
const { bindLabelsToFile, statFileIdentity } = await import("@/lib/inPlaceBinding");

const FIXTURES = join(import.meta.dir, "../fixtures");
const PYTHON = {
  "sleap-io 0.10": join(FIXTURES, "sleap_io_multi.pkg.slp"),
  "SLEAP 1.x style, 4 videos": join(FIXTURES, "sleap_io_multi_noshape.pkg.slp"),
  "SLEAP 1.x": join(FIXTURES, "sleap1_minimal_instance.pkg.slp"),
};
const tmp = mkdtempSync(join(tmpdir(), "sleap-app-inplace-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function withFile<T>(path: string, fn: (f: H5File) => T): T {
  const f = new H5File(path, "r");
  try {
    return fn(f);
  } finally {
    f.close();
  }
}

/** HDF5 type class of each `points` member (8 = enum, h5py's bool). */
async function pointMemberTypes(path: string): Promise<Record<string, number>> {
  await ready;
  return withFile(path, (f) => {
    const members = (
      f.get("points") as {
        metadata: { compound_type: { members: Array<{ name: string; type: number }> } };
      }
    ).metadata.compound_type.members;
    return Object.fromEntries(members.map((m) => [m.name, m.type]));
  });
}

/** The shapes of the embedded image datasets (to check they're untouched). */
function embeddedDatasetShapes(path: string): string[] {
  return withFile(path, (f) =>
    f
      .keys()
      .filter((k) => /^video\d+$/.test(k))
      .map((k) => `${k}:${String((f.get(`${k}/video`) as { shape?: number[] } | null)?.shape)}`)
  );
}

/**
 * Does the installed sleap-io.js's gate accept HDF5 booleans? Asked of the
 * gate itself, on the SLEAP 1.x fixture's tables with nothing else changed.
 */
async function gatePatchesBooleans(): Promise<boolean> {
  await ready;
  const path = PYTHON["SLEAP 1.x"];
  const onDisk = withFile(path, (f) => {
    const tables: Record<string, unknown> = {};
    for (const [key, name] of [
      ["frames", "frames"],
      ["instances", "instances"],
      ["points", "points"],
      ["predPoints", "pred_points"],
    ]) {
      const ds = f.get(name) as { shape: number[]; metadata: unknown } | null;
      if (ds) {
        tables[key] = sio.onDiskTableFromMeta({ shape: ds.shape, metadata: ds.metadata as never });
      }
    }
    return tables;
  });
  const labels = await sio.loadSlp(path, { openVideos: false });
  const update = sio.buildLabelTableUpdate(labels);
  const sidecars = sio.buildExpectedSidecars(labels);
  return sio.checkInPlaceWritable(update, onDisk as never, { onDisk: sidecars, expected: sidecars })
    .ok;
}
const PATCHES_BOOLEANS = await gatePatchesBooleans();
console.info(`[saveLabelsInPlacePython] the gate patches HDF5 booleans: ${PATCHES_BOOLEANS}`);

/** The `videos_json` entries of `path`, parsed. */
function videosJson(path: string): Array<{ backend?: Record<string, unknown> }> {
  return withFile(path, (f) =>
    Array.from((f.get("videos_json") as { value: ArrayLike<unknown> }).value, (v) =>
      JSON.parse(typeof v === "string" ? v : new TextDecoder().decode(v as Uint8Array))
    )
  );
}

/** A deferred backend's h5 file (the large-file open), on h5wasm per call. */
const lazyH5 = {
  async getKeys(path: string) {
    await ready;
    return withFile(current, (f) => (f.get(path) as { keys: () => string[] }).keys());
  },
  async getDatasetValue(path: string) {
    await ready;
    return withFile(current, (f) => ({ value: (f.get(path) as { value: unknown }).value }));
  },
  async getAttrs(path: string) {
    await ready;
    return withFile(current, (f) =>
      Object.fromEntries(
        Object.entries((f.get(path) as { attrs: Record<string, { value: unknown }> }).attrs).map(
          ([k, a]) => [k, a.value]
        )
      )
    );
  },
  async getDatasetMeta(path: string) {
    await ready;
    return withFile(current, (f) => {
      const d = f.get(path) as { shape: number[]; dtype: string };
      return { shape: d.shape, dtype: d.dtype };
    });
  },
};

/**
 * Give each embedded video a deferred backend seeded from its JSON shape, as
 * the app's large-file open leaves it; `shown` loads the metadata of those
 * videos, as showing a frame does.
 */
async function loadLazily(labels: sioModule.Labels, shown: number[]) {
  const jsons = videosJson(current);
  labels.videos.forEach((v, i) => {
    if (!v.hasEmbeddedImages) return;
    const b = jsons[i].backend ?? {};
    const s = b.shape as number[] | undefined;
    const seeded =
      s && s[1] && s[2] && s[3]
        ? ([s[0] > 0 ? s[0] : 0, s[1], s[2], s[3]] as [number, number, number, number])
        : undefined;
    (v as { backend: unknown }).backend = new sio.StreamingHdf5VideoBackend({
      filename: current,
      h5file: lazyH5 as never,
      datasetPath: (b.dataset as string) ?? `video${i}/video`,
      format: "png",
      shape: seeded,
      deferred: true,
    });
    (v as unknown as { _shape: unknown })._shape = null;
    const md = { ...v.backendMetadata };
    if (seeded) md.shape = seeded;
    else delete md.shape;
    v.backendMetadata = md;
  });
  for (const i of shown) {
    const backend = labels.videos[i].backend as { ensureLoaded?: () => Promise<void> } | null;
    await backend?.ensureLoaded?.();
  }
}

type LoadState = "eager" | "large, none shown" | "large, first shown" | "large, all shown";
const LOAD_STATES: LoadState[] = [
  "eager",
  "large, none shown",
  "large, first shown",
  "large, all shown",
];

let copies = 0;
/** A fresh copy of `source`, loaded in `state`. */
async function open(source: string, state: LoadState) {
  current = join(tmp, `pkg-${copies++}.pkg.slp`);
  copyFileSync(source, current);
  const labels = await sio.loadSlp(current, { openVideos: false });
  if (state !== "eager") {
    const first = labels.videos.indexOf(labels.labeledFrames[0].video);
    const shown =
      state === "large, none shown"
        ? []
        : state === "large, first shown"
          ? [first]
          : labels.videos.map((_, i) => i);
    await loadLazily(labels, shown);
  }
  // As the app's open records it (loadProjectFromPath).
  bindLabelsToFile(labels, current, await statFileIdentity(current), "loaded");
  fileOps.length = 0;
  readerCalls.length = 0;
  return { labels, before: readFileSync(current) };
}

function editPoint(labels: sioModule.Labels) {
  labels.labeledFrames[0].instances[0].points[0].xy = [12.5, 34.25];
}

async function expectSavedInPlace(labels: sioModule.Labels) {
  const res = await saveLabelsInPlace(labels, current);
  expect(res).toEqual({ ok: true });
  expect(fileOps).toEqual(["writeOpenAppend", "openWrite", "updateLabelsInPlace"]);
  const back = await sio.loadSlp(current, { openVideos: false });
  const p = back.labeledFrames[0].instances[0].points[0];
  expect([p.xy[0], p.xy[1]]).toEqual([12.5, 34.25]);
}

async function expectRefused(labels: sioModule.Labels, before: Buffer, reason: RegExp) {
  const res = await saveLabelsInPlace(labels, current);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.reason).toMatch(reason);
  expect(fileOps).toEqual([]);
  expect(readFileSync(current).equals(before)).toBe(true);
}

beforeEach(() => {
  Object.defineProperty(globalThis, "crossOriginIsolated", { value: true, configurable: true });
  const g = globalThis as { SharedArrayBuffer?: unknown };
  g.SharedArrayBuffer ??= ArrayBuffer;
});

describe("in-place save of packages written in Python (HDF5 boolean flags)", () => {
  it("the fixtures store the flags as HDF5 booleans", async () => {
    for (const path of Object.values(PYTHON)) {
      const types = await pointMemberTypes(path);
      expect([types.visible, types.complete]).toEqual([8, 8]);
    }
  });

  for (const [name, source] of Object.entries(PYTHON)) {
    for (const state of LOAD_STATES) {
      it(
        PATCHES_BOOLEANS
          ? `${name}, ${state}: a point edit is saved in place, flags and frames kept`
          : `${name}, ${state}: refused at the gate without reading the videos; file untouched`,
        async () => {
          const { labels, before } = await open(source, state);
          const frames = embeddedDatasetShapes(current);
          editPoint(labels);
          if (!PATCHES_BOOLEANS) {
            await expectRefused(labels, before, /enum|bool/i);
            expect(readerCalls.filter((c) => /:video\d/.test(c))).toEqual([]);
            return;
          }
          await expectSavedInPlace(labels);
          // No embedded image or frame number is read: only the video
          // datasets' attributes, before and after writing.
          expect(readerCalls.filter((c) => /^value:video\d/.test(c))).toEqual([]);
          const types = await pointMemberTypes(current);
          expect([types.visible, types.complete]).toEqual([8, 8]);
          expect(embeddedDatasetShapes(current)).toEqual(frames);
        }
      );
    }
  }

  it("a full rewrite stores the flags as uint8", async () => {
    // What the fallback writes (the app's full save of an embedded package).
    const labels = await sio.loadSlp(PYTHON["sleap-io 0.10"]);
    const rewritten = join(tmp, "rewritten.pkg.slp");
    writeFileSync(rewritten, await sio.saveSlpToBytes(labels, withLegacyLayout({})));
    const types = await pointMemberTypes(rewritten);
    expect([types.visible, types.complete]).toEqual([0, 0]);
  });
});

describe("in-place save of a package the app wrote", () => {
  /** The sleap-io fixture, saved by the app (uint8 flags, chunked tables). */
  let appWritten = "";
  async function appPackage(): Promise<string> {
    if (!appWritten) {
      const labels = await sio.loadSlp(PYTHON["sleap-io 0.10"]);
      appWritten = join(tmp, "app-written.pkg.slp");
      writeFileSync(appWritten, await sio.saveSlpToBytes(labels, withLegacyLayout({})));
    }
    return appWritten;
  }

  for (const state of LOAD_STATES) {
    it(`${state}: a point edit is saved in place (any sleap-io.js)`, async () => {
      const { labels } = await open(await appPackage(), state);
      editPoint(labels);
      await expectSavedInPlace(labels);
    });
  }

  it("refuses two embedded videos of the same size swapped", async () => {
    const { labels, before } = await open(await appPackage(), "eager");
    const [a, b] = labels.videos;
    expect(a.shape?.slice(1)).toEqual(b.shape?.slice(1));
    labels.videos[0] = b;
    labels.videos[1] = a;
    await expectRefused(labels, before, /video list changed/);
  });

  it("refuses an embedded video repointed at a file", async () => {
    const { labels, before } = await open(await appPackage(), "eager");
    labels.videos[1].filename = "/data/vB.mp4";
    await expectRefused(labels, before, /video set changed/);
  });
});

describe.skipIf(!PATCHES_BOOLEANS)("sleap-io's contiguous tables (a gate that patches booleans)", () => {
  it("adding an instance changes row counts: refused, file untouched", async () => {
    const { labels, before } = await open(PYTHON["sleap-io 0.10"], "eager");
    const frame = labels.labeledFrames[0];
    const skeleton = labels.skeletons[0];
    const points = Object.fromEntries(skeleton.nodes.map((n, i) => [n.name, [3 + i, 4 + i]]));
    frame.instances.push(new sio.Instance({ points, skeleton } as never));
    await expectRefused(labels, before, /contiguous|resiz/i);
  });
});
