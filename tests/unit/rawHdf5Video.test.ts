/**
 * Import Videos ▸ HDF5 movie: PyQt's dataset menu (rank-4 datasets, found
 * recursively) and its channels_first / channels_last choice
 * (`sleap/gui/dialogs/importvideos.py:140-157`).
 */
import { describe, it, expect } from "../bun-test";
import {
  findRank4Datasets,
  frameShapeFor,
  rawFrameToRgba,
  type Hdf5Tree,
} from "@/lib/rawHdf5Video";
import {
  prepareVideoImportEntries,
  hdf5ImportOptions,
  setAllInputFormats,
  isHdf5MovieFile,
} from "@/components/dialogs/VideoImportList";
import { hdf5HintsForVideo, rawMovieShape } from "@/lib/hdf5VideoSource";
import { Video } from "@talmolab/sleap-io.js";

/** A fake HDF5 file: groups map to children, datasets map to shapes. */
function tree(nodes: Record<string, string[] | number[]>): Hdf5Tree {
  const isGroup = (p: string) =>
    Array.isArray(nodes[p]) && typeof (nodes[p] as unknown[])[0] === "string";
  return {
    keys: () => nodes[""] as string[],
    getKeys: async (p) => {
      if (!isGroup(p)) throw new Error("not a group");
      return nodes[p] as string[];
    },
    getDatasetMeta: async (p) => {
      if (isGroup(p) || !(p in nodes)) throw new Error("not a dataset");
      return { shape: nodes[p] as number[], dtype: "<u1" };
    },
  };
}

describe("findRank4Datasets", () => {
  // PyQt lists only rank-4 datasets, walking into groups, as "/group/name".
  it("lists rank-4 datasets recursively, PyQt-style paths", async () => {
    const h5 = tree({
      "": ["box", "meta", "grp"],
      box: [100, 64, 48, 1],
      meta: [3],
      grp: ["movie", "inner"],
      "grp/movie": [10, 3, 32, 32],
      "grp/inner": ["deep"],
      "grp/inner/deep": [5, 8, 8, 3],
    });
    expect(await findRank4Datasets(h5)).toEqual([
      "/box",
      "/grp/movie",
      "/grp/inner/deep",
    ]);
  });

  // A SLEAP package stores 1-D encoded frames, so PyQt's menu is empty.
  it("offers nothing for a SLEAP package", async () => {
    const h5 = tree({
      "": ["video0"],
      video0: ["video", "frame_numbers"],
      "video0/video": [12],
      "video0/frame_numbers": [12],
    });
    expect(await findRank4Datasets(h5)).toEqual([]);
  });
});

describe("raw frame layout", () => {
  // channels_first stores [frames, C, H, W]; the video is still [N, H, W, C].
  it("maps the stored shape to [frames, H, W, C]", () => {
    expect(frameShapeFor([10, 3, 32, 48], "channels_first")).toEqual([10, 32, 48, 3]);
    expect(frameShapeFor([10, 32, 48, 3], "channels_last")).toEqual([10, 32, 48, 3]);
  });

  // The same 2x1 RGB image, stored both ways, decodes to the same pixels.
  it("decodes channels_last and channels_first to the same RGBA", () => {
    // pixel 0 = (1,2,3), pixel 1 = (4,5,6)
    const last = rawFrameToRgba([1, 2, 3, 4, 5, 6], 1, 2, 3, "channels_last");
    const first = rawFrameToRgba([1, 4, 2, 5, 3, 6], 1, 2, 3, "channels_first");
    expect([...last]).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
    expect([...first]).toEqual([...last]);
  });

  // One channel is gray: copied into R, G and B.
  it("spreads a single channel to gray", () => {
    expect([...rawFrameToRgba([7, 9], 1, 2, 1, "channels_last")]).toEqual([
      7, 7, 7, 255, 9, 9, 9, 255,
    ]);
  });
});

describe("Import Videos list: HDF5 rows", () => {
  const pick = (name: string) => ({ file: new File([], name), absPath: null });

  // PyQt preselects the first dataset and channels_first.
  it("stages an .h5 with its datasets and PyQt's defaults", async () => {
    const entries = await prepareVideoImportEntries(
      [pick("a.mp4"), pick("m.h5")],
      async () => ["/box", "/other"]
    );
    expect(entries[0]!.hdf5).toBeUndefined();
    expect(entries[1]!.hdf5).toEqual({
      datasets: ["/box", "/other"],
      dataset: "/box",
      inputFormat: "channels_first",
    });
    expect(hdf5ImportOptions(entries[1]!)).toEqual({
      dataset: "/box",
      inputFormat: "channels_first",
    });
  });

  // No rank-4 dataset (e.g. a package saved as .h5): import it as before.
  it("leaves a file with no rank-4 dataset to auto-detection", async () => {
    const [entry] = await prepareVideoImportEntries([pick("p.h5")], async () => []);
    expect(entry!.hdf5).toBeUndefined();
  });

  // "All channels last" touches only HDF5 rows.
  it("sets every HDF5 row's channel order in bulk", async () => {
    const entries = await prepareVideoImportEntries(
      [pick("a.mp4"), pick("m.hdf5")],
      async () => ["/box"]
    );
    const out = setAllInputFormats(entries, "channels_last");
    expect(out[0]).toEqual(entries[0]);
    expect(out[1]!.hdf5!.inputFormat).toBe("channels_last");
  });

  it("recognizes .h5/.hdf5 but not .slp", () => {
    expect(isHdf5MovieFile("x.H5")).toBe(true);
    expect(isHdf5MovieFile("x.hdf5")).toBe(true);
    expect(isHdf5MovieFile("x.pkg.slp")).toBe(false);
  });
});

describe("saved input_format", () => {
  // A saved project re-opens the movie with the layout the user chose.
  it("reads input_format back from the video's metadata", () => {
    const v = new Video({
      filename: "/m.h5",
      backendMetadata: { dataset: "/box", input_format: "channels_first" },
      openBackend: false,
    });
    expect(hdf5HintsForVideo(v).inputFormat).toBe("channels_first");
    expect(hdf5HintsForVideo(v).dataset).toBe("/box");
  });
});

describe("rawMovieShape", () => {
  const h5 = {
    keys: () => ["box", "video0"],
    getKeys: async (p: string) => {
      if (p === "video0") return ["video", "frame_numbers"];
      throw new Error("not a group");
    },
    getDatasetMeta: async (p: string) => {
      if (p === "box") return { shape: [9, 4, 4, 1], dtype: "<u1" };
      if (p === "video0/video") return { shape: [3, 4, 4, 1], dtype: "<u1" };
      throw new Error("not a dataset");
    },
  };

  // A plain rank-4 array is read by the raw movie reader...
  it("routes a root rank-4 dataset to the raw reader", async () => {
    expect(await rawMovieShape(h5, "/box")).toEqual([9, 4, 4, 1]);
  });

  // ...but a package's embedded frames (with frame_numbers) stay on the package reader.
  it("leaves a package's embedded frames alone", async () => {
    expect(await rawMovieShape(h5, "video0/video")).toBeNull();
  });
});
