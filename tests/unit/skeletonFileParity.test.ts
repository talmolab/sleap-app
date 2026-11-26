/**
 * Skeleton ▸ Load From File / Save As, PyQt parity (`docks.py:324`): Load
 * accepts legacy HDF5 skeleton files; Save As writes SLEAP's JSON skeleton
 * format (PyQt's default) as a one-skeleton list.
 */
import { describe, it, expect } from "../bun-test";
import { Skeleton } from "@talmolab/sleap-io.js";
import path from "node:path";
import { readFileSync } from "node:fs";
import { openWithRealH5wasm } from "./helpers/h5wasmWorkerMirror";
import {
  parseSkeletonFile,
  serializeSkeletonJson,
  skeletonFromHdf5Attrs,
} from "@/lib/skeletonIO";

function makeSkeleton(): Skeleton {
  const sk = new Skeleton({ nodes: ["head", "thorax", "tail"], name: "fly" });
  sk.addEdge(sk.node("head"), sk.node("thorax"));
  sk.addEdge(sk.node("thorax"), sk.node("tail"));
  return sk;
}

describe("Save As JSON", () => {
  // PyQt writes `save_skeleton([skel], ...)`: a list, readable back by Load.
  it("round-trips through Load From File", async () => {
    const text = serializeSkeletonJson(makeSkeleton());
    expect(Array.isArray(JSON.parse(text))).toBe(true);
    const back = await parseSkeletonFile("fly.json", text);
    expect(back.nodes.map((n) => n.name)).toEqual(["head", "thorax", "tail"]);
    expect(back.edges.length).toBe(2);
  });
});

const FIX = path.join(import.meta.dir, "..", "fixtures");

/**
 * parseSkeletonFile's HDF5 reader, backed by real h5wasm with the worker's
 * exact attribute wrapping (`{ value }`) — an injected raw-string reader hid
 * that every real .h5 load failed with "No skeleton found".
 */
const realReader = (file: string) => async () => {
  const h5 = await openWithRealH5wasm(path.join(FIX, file));
  try {
    return h5.keys().includes("skeleton") ? await h5.getAttrs("skeleton") : null;
  } finally {
    await h5.close();
  }
};
const load = (file: string) =>
  parseSkeletonFile(file, new Uint8Array([0]), realReader(file));

describe("Load From File: HDF5 (real files)", () => {
  // Written by SLEAP 1.4.1 `Skeleton.save_hdf5` (3 nodes, 2 edges).
  it("loads a SLEAP 1.x HDF5 skeleton", async () => {
    const sk = await load("skeleton_sleap14.h5");
    expect(sk.nodes.map((n) => n.name)).toEqual(["head", "thorax", "abdomen"]);
    expect(sk.edges.length).toBe(2);
  });

  // The fly32 template, saved by SLEAP 1.4.1 `save_hdf5`.
  it("loads the fly32 template saved as HDF5", async () => {
    expect((await load("fly32_sleap14.h5")).nodes.length).toBe(32);
  });

  // A template's {"nx_graph": ...} JSON stored as the attribute is unwrapped.
  it("unwraps an nx_graph-wrapped attribute", async () => {
    expect((await load("skeleton_nx_graph.h5")).nodes.length).toBe(32);
  });

  it("says so when the file holds no skeleton", () => {
    expect(() => skeletonFromHdf5Attrs(null, "x.h5")).toThrow(
      'No skeleton found in "x.h5".'
    );
  });
});

describe("Load From File: SLEAP template JSON", () => {
  // SLEAP's templates (sleap/skeletons/fly32.json) wrap the graph in
  // `nx_graph`; PyQt unwraps it, and loading it used to crash.
  it("loads fly32.json", async () => {
    const text = readFileSync(path.join(FIX, "fly32_template.json"), "utf8");
    const sk = await parseSkeletonFile("fly32.json", text);
    expect(sk.nodes.length).toBe(32);
  });
});
