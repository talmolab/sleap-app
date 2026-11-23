/**
 * Skeleton ▸ Load From File / Save As, PyQt parity (`docks.py:324`): Load
 * accepts legacy HDF5 skeleton files; Save As writes SLEAP's JSON skeleton
 * format (PyQt's default) as a one-skeleton list.
 */
import { describe, it, expect } from "../bun-test";
import { Skeleton, writeSkeletonJson } from "@talmolab/sleap-io.js";
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

describe("Load From File: HDF5", () => {
  // SLEAP 1.x save_hdf5: `/skeleton` attrs, one JSON string per skeleton.
  const attrs = { fly: writeSkeletonJson(makeSkeleton()) };

  it("reads the first skeleton from the /skeleton group's attributes", () => {
    const sk = skeletonFromHdf5Attrs(attrs, "fly.h5");
    expect(sk.nodes.map((n) => n.name)).toEqual(["head", "thorax", "tail"]);
  });

  // The attribute may come back as raw bytes (fixed-length numpy string).
  it("accepts the JSON as bytes", () => {
    const bytes = { fly: new TextEncoder().encode(attrs.fly) };
    expect(skeletonFromHdf5Attrs(bytes, "fly.h5").nodes.length).toBe(3);
  });

  it("says so when the file holds no skeleton", () => {
    expect(() => skeletonFromHdf5Attrs(null, "x.h5")).toThrow(
      'No skeleton found in "x.h5".'
    );
  });

  // .h5 and .hdf5 both route to the HDF5 reader.
  it("routes .h5/.hdf5 through the HDF5 reader", async () => {
    const reader = async () => attrs;
    for (const name of ["fly.h5", "fly.HDF5"]) {
      const sk = await parseSkeletonFile(name, new Uint8Array([1]), reader);
      expect(sk.nodes.length).toBe(3);
    }
  });
});
