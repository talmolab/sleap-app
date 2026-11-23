/**
 * The in-place save never patches a file whose label tables are not datasets
 * (SLP format 3.0 stores each as a group of columns), even when the labels no
 * longer record the file's format (e.g. a recovered draft): the probe fails
 * and the caller falls back to a full save, with nothing written.
 *
 * The range reader is faked: a `points` table that reports no shape is how
 * the streaming reader describes a group.
 */
import { describe, it, expect, vi } from "../bun-test";
import type { Labels } from "@talmolab/sleap-io.js";

const DATASET = {
  shape: [3],
  metadata: { compound_type: { members: [{ name: "x", type: 1, size: 8 }] } },
};
const opened: string[] = [];

class FakeStreamingH5File {
  async openRange() {
    opened.push("probe");
  }
  keys() {
    return ["frames", "instances", "points", "pred_points"];
  }
  async getDatasetMeta(name: string) {
    // `points` is a group of column datasets: no shape.
    return name === "points" ? { shape: undefined, metadata: {} } : DATASET;
  }
  async getDatasetValue() {
    return { value: [] };
  }
  async getAttrs() {
    return {};
  }
  async close() {}
}

const buildLabelTableUpdate = vi.fn();
vi.mock("@talmolab/sleap-io.js", () => ({
  StreamingH5File: FakeStreamingH5File,
  StreamingH5Writer: class {},
  onDiskTableFromMeta: (meta: { shape?: unknown }) =>
    Array.isArray(meta?.shape) ? { rows: (meta.shape as number[])[0], cols: 1, layout: "compound", chunked: false } : undefined,
  buildLabelTableUpdate,
  buildExpectedSidecars: vi.fn(),
  buildMetadataJson: vi.fn(),
  buildVideoSignatures: vi.fn(() => []),
  checkInPlaceWritable: vi.fn(() => ({ ok: true })),
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
  writeClose: vi.fn(),
}));

import { saveLabelsInPlace } from "@/lib/saveLabelsInPlace";

describe("saveLabelsInPlace on a file whose tables are not datasets", () => {
  it("fails the probe and falls back, before building or writing anything", async () => {
    Object.defineProperty(globalThis, "crossOriginIsolated", { value: true, configurable: true });
    const g = globalThis as { SharedArrayBuffer?: unknown };
    g.SharedArrayBuffer ??= ArrayBuffer;
    const labels = { videos: [] } as unknown as Labels; // no sourceFormat recorded
    const res = await saveLabelsInPlace(labels, "/data/recovered.pkg.slp");
    expect(opened).toEqual(["probe"]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toMatch(/probe/);
      expect(res.reason).toMatch(/\/points is not a table/);
    }
    expect(buildLabelTableUpdate).not.toHaveBeenCalled();
    expect(writeOpenAppend).not.toHaveBeenCalled();
  });
});
