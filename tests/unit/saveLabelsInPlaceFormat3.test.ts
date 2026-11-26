/**
 * `saveLabelsInPlace` on SLP format 3.0 column-group tables and unreadable
 * non-table groups:
 *  - A table that is neither a dataset nor a column group fails the probe
 *    cleanly and falls back to a full re-save before building or writing.
 *  - A format 3.0 file opened natively (`access: "keep"`) probes its column
 *    groups and metadata subgroups via `onDiskColumnTableFromMeta`, gates with
 *    `checkInPlaceWritable`, patches via `StreamingH5Writer.updateLabelsInPlace`,
 *    and verifies per-column row counts + `points/x`/`points/y` row 0.
 *  - When `updateLabelsInPlace` returns a pre-write column refusal (e.g. a
 *    string metadata value changed), `saveLabelsInPlace` returns `{ ok: false }`
 *    so the caller falls back cleanly to a full re-save.
 *  - `access: "edit"` skips in-place and falls back to 2.x full re-save;
 *    `access: "view"` throws `SlpViewOnlyError`.
 */
import { describe, it, expect, beforeEach, vi } from "../bun-test";
import type { Labels, OnDiskTable } from "@talmolab/sleap-io.js";

const DATASET = {
  shape: [3],
  metadata: { compound_type: { members: [{ name: "x", type: 1, size: 8 }] } },
};
const COL_FLOAT = { shape: [2], metadata: { type: 1, size: 8, signed: false } };
const COL_INT = { shape: [1], metadata: { type: 0, size: 8, signed: true } };
const COL_STR = { shape: [1], metadata: { type: 3, size: 8 } };

let mode: "bad-group" | "v3" = "bad-group";
let writerResult: { success: boolean; error?: string } = { success: true };
const opened: string[] = [];
const probedColumnTables: Array<{ columns: Record<string, unknown>; metadata?: Record<string, unknown> }> = [];
const verifiedPaths: string[] = [];
let updateArg: unknown = null;

class FakeSlpViewOnlyError extends Error {
  sourceFormat: unknown;
  constructor(sf: unknown) {
    super("These labels were loaded for viewing only (format3: \"view\").");
    this.name = "SlpViewOnlyError";
    this.sourceFormat = sf;
  }
}

class FakeStreamingH5File {
  async openRange() {
    opened.push("openRange");
  }
  keys() {
    return ["frames", "instances", "points", "pred_points", "videos_json"];
  }
  async getKeys(path: string): Promise<string[]> {
    if (mode === "bad-group") return [];
    if (path === "frames") return ["frame_idx", "video"];
    if (path === "instances") return ["instance_type", "metadata"];
    if (path === "instances/metadata") return ["annotator"];
    if (path === "instances/metadata/annotator") return ["values", "present"];
    if (path === "points") return ["x", "y", "visible", "complete", "labeled"];
    if (path === "pred_points") return ["x", "y"];
    return [];
  }
  async getDatasetMeta(path: string) {
    verifiedPaths.push(path);
    if (mode === "bad-group") {
      return path === "points" ? { shape: undefined, metadata: {} } : DATASET;
    }
    if (path === "frames" || path === "instances" || path === "points" || path === "pred_points") {
      return { shape: undefined, metadata: {} };
    }
    if (path.startsWith("frames/")) return COL_INT;
    if (path === "instances/metadata/annotator/values") return COL_STR;
    if (path.startsWith("instances/")) return COL_INT;
    if (path.startsWith("points/")) return COL_FLOAT;
    if (path.startsWith("pred_points/")) return { shape: [0], metadata: { type: 1, size: 8 } };
    return { shape: undefined, metadata: {} };
  }
  async getDatasetValue(path: string) {
    if (path === "points/x") return { value: new Float64Array([15]) };
    if (path === "points/y") return { value: new Float64Array([25]) };
    return { value: [] };
  }
  async getAttrs(path: string): Promise<Record<string, unknown>> {
    if (path === "instances/metadata/annotator/values") {
      return { kind: { value: "string" } };
    }
    return {};
  }
  async close() {}
}

class FakeStreamingH5Writer {
  async openWrite() {}
  async updateLabelsInPlace(update: unknown) {
    updateArg = update;
    return writerResult;
  }
  async close() {}
}

const v3Update = {
  layout: "v3" as const,
  frames: { fields: ["frame_idx", "video"], rows: [[0, 0]] },
  instances: { fields: ["instance_type"], rows: [[0]] },
  points: { fields: ["x", "y", "visible", "complete", "labeled"], rows: [[15, 25, 1, 1, 1], [30, 40, 1, 1, 1]] },
  predPoints: { fields: ["x", "y"], rows: [] },
};

const buildLabelTableUpdate = vi.fn(() => v3Update);
const checkInPlaceWritable = vi.fn(() => ({ ok: true as const }));
const onDiskColumnTableFromMeta = vi.fn(
  (columns: Record<string, unknown>, metadata?: Record<string, unknown>): OnDiskTable => {
    probedColumnTables.push({ columns, metadata });
    return { rows: 1, cols: Object.keys(columns).length, layout: "columns", chunked: false };
  },
);

vi.mock("@talmolab/sleap-io.js", () => ({
  SlpViewOnlyError: FakeSlpViewOnlyError,
  StreamingH5File: FakeStreamingH5File,
  StreamingH5Writer: FakeStreamingH5Writer,
  onDiskTableFromMeta: (meta: { shape?: unknown }) =>
    Array.isArray(meta?.shape)
      ? { rows: (meta.shape as number[])[0], cols: 1, layout: "compound", chunked: false }
      : undefined,
  onDiskColumnTableFromMeta,
  buildLabelTableUpdate,
  buildExpectedSidecars: vi.fn(() => ({ tracksJson: [], suggestionsJson: [], metadataJson: null, videos: [] })),
  buildMetadataJson: vi.fn(() => "{}"),
  buildVideoSignatures: vi.fn(() => []),
  checkInPlaceWritable,
}));
vi.mock("@/lib/nativeRange", () => ({
  fileSize: vi.fn(async () => 1000),
  readRange: vi.fn(),
}));
const writeOpenAppend = vi.fn();
vi.mock("@/lib/nativeWrite", () => ({
  withNativeWriteHandle: <T,>(work: () => Promise<T>) => work(),
  writeOpenAppend,
  writeAt: vi.fn(),
  readAt: vi.fn(),
  truncateFile: vi.fn(),
  writeClose: vi.fn(async () => {}),
}));

import { saveLabelsInPlace } from "@/lib/saveLabelsInPlace";

beforeEach(() => {
  Object.defineProperty(globalThis, "crossOriginIsolated", { value: true, configurable: true });
  const g = globalThis as { SharedArrayBuffer?: unknown };
  g.SharedArrayBuffer ??= ArrayBuffer;
  mode = "bad-group";
  writerResult = { success: true };
  opened.length = 0;
  probedColumnTables.length = 0;
  verifiedPaths.length = 0;
  updateArg = null;
  buildLabelTableUpdate.mockClear();
  checkInPlaceWritable.mockClear();
  onDiskColumnTableFromMeta.mockClear();
  writeOpenAppend.mockClear();
});

describe("saveLabelsInPlace format 3.0 handling", () => {
  it("fails the probe and falls back when a group has no column datasets", async () => {
    const labels = { videos: [], sourceFormat: null } as unknown as Labels;
    const res = await saveLabelsInPlace(labels, "/data/recovered.pkg.slp");
    expect(opened).toEqual(["openRange"]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toMatch(/probe/);
      expect(res.reason).toMatch(/\/points is not a table/);
    }
    expect(buildLabelTableUpdate).not.toHaveBeenCalled();
    expect(writeOpenAppend).not.toHaveBeenCalled();
  });

  it("probes 3.0 column groups + metadata, patches in place, and verifies per-column row counts", async () => {
    mode = "v3";
    const labels = {
      videos: [],
      sourceFormat: { formatId: 3, access: "keep", summary: { formatId: 3 }, labelsPath: "/data/v3.pkg.slp" },
    } as unknown as Labels;

    const res = await saveLabelsInPlace(labels, "/data/v3.pkg.slp");

    expect(res).toEqual({ ok: true });
    expect(onDiskColumnTableFromMeta).toHaveBeenCalledTimes(4);
    const instancesProbe = probedColumnTables.find((t) => "instance_type" in t.columns);
    expect(instancesProbe?.metadata).toEqual({
      annotator: { values: COL_STR, kindAttr: "string", present: true },
    });
    expect(buildLabelTableUpdate).toHaveBeenCalledTimes(1);
    expect(writeOpenAppend).toHaveBeenCalledTimes(1);
    expect(updateArg).toBe(v3Update);
    // Verify ran against per-column datasets, not group paths.
    expect(verifiedPaths).toContain("frames/frame_idx");
    expect(verifiedPaths).toContain("instances/instance_type");
    expect(verifiedPaths).toContain("points/x");
    expect(verifiedPaths).toContain("pred_points/x");
  });

  it("returns { ok: false } when worker refuses pre-write on format 3.0 (e.g. string metadata changed)", async () => {
    mode = "v3";
    writerResult = {
      success: false,
      error: "in-place save: a string value of instances/metadata/annotator/values changed - re-save the whole file instead",
    };
    const labels = {
      videos: [],
      sourceFormat: { formatId: 3, access: "keep", summary: { formatId: 3 }, labelsPath: "/data/v3.pkg.slp" },
    } as unknown as Labels;

    const res = await saveLabelsInPlace(labels, "/data/v3.pkg.slp");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("string value");
  });

  it("skips in-place for explicit 2.x conversion (access: 'edit') and throws SlpViewOnlyError for 'view'", async () => {
    const editLabels = {
      videos: [],
      sourceFormat: { formatId: 3, access: "edit", summary: { formatId: 3 }, labelsPath: "/data/v3.pkg.slp" },
    } as unknown as Labels;
    const editRes = await saveLabelsInPlace(editLabels, "/data/v3.pkg.slp");
    expect(editRes.ok).toBe(false);
    expect(opened).toEqual([]);

    const viewLabels = {
      videos: [],
      sourceFormat: { formatId: 3, access: "view", summary: { formatId: 3 }, labelsPath: "/data/v3.pkg.slp" },
    } as unknown as Labels;
    await expect(saveLabelsInPlace(viewLabels, "/data/v3.pkg.slp")).rejects.toBeInstanceOf(
      FakeSlpViewOnlyError,
    );
  });
});
