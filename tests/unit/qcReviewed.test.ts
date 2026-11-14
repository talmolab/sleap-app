/**
 * Label QC "Mark as OK" storage (qcReviewed.ts): the pose fingerprint, the
 * IndexedDB backend (one record per mark, per project), and the in-memory
 * fallback when IndexedDB is missing or fails.
 */
import { describe, it, expect, beforeEach, vi } from "../bun-test";
import { IDBFactory } from "fake-indexeddb";
import { Instance, Skeleton } from "@talmolab/sleap-io.js";
import {
  addQcMarks,
  idbBackend,
  loadQcMarks,
  memoryBackend,
  poseFingerprint,
  qcMarkKey,
  removeQcMark,
  setQcReviewedBackend,
  type QcReviewedBackend,
} from "@/lib/qcReviewed";

const skeleton = new Skeleton({ nodes: ["a", "b"], edges: [["a", "b"]] });
const pose = (pts: number[][]) => Instance.fromNumpy({ pointsData: pts, skeleton });

describe("poseFingerprint", () => {
  it("is the same for the same pose, down to 0.01 px", () => {
    const fp = poseFingerprint(pose([[1, 2], [3, 4]]));
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
    expect(poseFingerprint(pose([[1, 2], [3, 4]]))).toBe(fp);
    expect(poseFingerprint(pose([[1.001, 2], [3, 4]]))).toBe(fp);
  });

  it("changes when a point moves or is hidden", () => {
    const inst = pose([[1, 2], [3, 4]]);
    const fp = poseFingerprint(inst);
    inst.points[0].xy = [1.5, 2];
    const moved = poseFingerprint(inst);
    expect(moved).not.toBe(fp);
    inst.points[0].visible = false;
    expect(poseFingerprint(inst)).not.toBe(moved);
  });

  it("goes into the mark key after the position", () => {
    const inst = pose([[1, 2], [3, 4]]);
    expect(qcMarkKey(0, 12, 1, inst)).toBe(`0:12:1:${poseFingerprint(inst)}`);
  });
});

describe("idbBackend", () => {
  it("keeps one record per mark, per project, across connections", async () => {
    const factory = new IDBFactory();
    const a = idbBackend(factory);
    await a.add("/p/one.slp", ["0:1:0:aa", "0:2:0:bb"]);
    await a.add("/p/two.slp", ["0:1:0:cc"]);
    await a.add("/p/one.slp", ["0:1:0:aa"]); // again: still one record
    await a.remove("/p/one.slp", "0:2:0:bb");

    const b = idbBackend(factory); // a fresh connection, as after a reload
    expect(await b.load("/p/one.slp")).toEqual(["0:1:0:aa"]);
    expect(await b.load("/p/two.slp")).toEqual(["0:1:0:cc"]);
    expect(await b.load("/p/none.slp")).toEqual([]);
  });
});

describe("storage helpers", () => {
  beforeEach(() => setQcReviewedBackend(null));

  it("fall back to memory without IndexedDB", async () => {
    expect(typeof indexedDB).toBe("undefined"); // happy-dom has none
    await addQcMarks("proj", ["0:1:0:aa"]);
    expect(await loadQcMarks("proj")).toEqual(["0:1:0:aa"]);
    await removeQcMark("proj", "0:1:0:aa");
    expect(await loadQcMarks("proj")).toEqual([]);
  });

  it("keep the session's marks in memory when IndexedDB fails", async () => {
    const broken: QcReviewedBackend = {
      load: () => Promise.reject(new Error("blocked")),
      add: () => Promise.reject(new Error("blocked")),
      remove: () => Promise.reject(new Error("blocked")),
    };
    setQcReviewedBackend(broken);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await addQcMarks("proj", ["0:1:0:aa"]); // fails, falls back, keeps it
    expect(await loadQcMarks("proj")).toEqual(["0:1:0:aa"]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("memoryBackend keeps projects apart", async () => {
    const m = memoryBackend();
    await m.add("a", ["k"]);
    expect(await m.load("a")).toEqual(["k"]);
    expect(await m.load("b")).toEqual([]);
  });
});
