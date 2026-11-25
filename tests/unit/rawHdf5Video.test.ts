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
} from "@/lib/rawHdf5Video";
import {
  prepareVideoImportEntries,
  hdf5ImportOptions,
  setAllInputFormats,
  isHdf5MovieFile,
} from "@/components/dialogs/VideoImportList";
import { hdf5HintsForVideo, rawMovieShape } from "@/lib/hdf5VideoSource";
import { Video } from "@talmolab/sleap-io.js";
import path from "node:path";
import { openWithRealH5wasm } from "./helpers/h5wasmWorkerMirror";

const MOVIE = path.join(import.meta.dir, "..", "fixtures", "raw_movie.h5");
// raw_movie.h5 (written with h5py): /box = (2, 64, 96, 3) channels-last, and
// /g/first = the same movie as (2, 3, 64, 96). Each frame is red on the top 32
// rows, blue below. Expected values come from Python sleap-io 0.6.0:
// `sio.load_video("raw_movie.h5", dataset=..., input_format=...)`.

describe("findRank4Datasets (real h5wasm)", () => {
  // The worker's getKeys returns [] for a dataset, so detection must use the
  // dataset's shape — a mock that threw on getKeys hid that every dataset was
  // taken for an empty group and the menu came out empty.
  it("lists the rank-4 datasets of a real file, PyQt-style", async () => {
    const h5 = await openWithRealH5wasm(MOVIE);
    try {
      expect(await findRank4Datasets(h5)).toEqual(["/box", "/g/first"]);
    } finally {
      await h5.close();
    }
  });

  // A SLEAP package stores 1-D encoded frames, so PyQt's menu is empty.
  it("offers nothing for a SLEAP package", async () => {
    const pkg = path.join(import.meta.dir, "..", "fixtures", "embedded_source.pkg.slp");
    const h5 = await openWithRealH5wasm(pkg);
    try {
      expect(await findRank4Datasets(h5)).toEqual([]);
    } finally {
      await h5.close();
    }
  });
});

describe("raw frame layout matches Python sleap-io", () => {
  // Python stores channels_first as (frames, C, W, H) and transposes each
  // frame (2, 1, 0): (2, 3, 64, 96) reads as (2, 96, 64, 3).
  it("maps the stored shape to [frames, H, W, C]", () => {
    expect(frameShapeFor([2, 3, 64, 96], "channels_first")).toEqual([2, 96, 64, 3]);
    expect(frameShapeFor([2, 64, 96, 3], "channels_last")).toEqual([2, 64, 96, 3]);
  });

  /** Read frame 1 of `dataset` from the real file as RGBA. */
  async function frame(dataset: string, fmt: "channels_first" | "channels_last") {
    const h5 = await openWithRealH5wasm(MOVIE);
    try {
      const meta = await h5.getDatasetMeta(dataset.slice(1));
      const [, h, w, c] = frameShapeFor(meta.shape, fmt);
      const { value } = await h5.getDatasetValue(dataset.slice(1), [[1, 2], [], [], []]);
      const rgba = rawFrameToRgba(value as ArrayLike<number>, h, w, c, fmt);
      return (y: number, x: number) => [...rgba.slice((y * w + x) * 4, (y * w + x) * 4 + 3)];
    } finally {
      await h5.close();
    }
  }

  // Same pixels Python returns for channels_last.
  it("decodes channels_last like Python", async () => {
    const px = await frame("/box", "channels_last");
    expect(px(5, 7)).toEqual([255, 0, 0]);
    expect(px(5, 40)).toEqual([255, 0, 0]);
    expect(px(60, 10)).toEqual([0, 0, 255]);
  });

  // Same pixels Python returns for channels_first (a transposed frame).
  it("decodes channels_first like Python", async () => {
    const px = await frame("/g/first", "channels_first");
    expect(px(5, 7)).toEqual([255, 0, 0]);
    expect(px(5, 40)).toEqual([0, 0, 255]);
    expect(px(60, 10)).toEqual([255, 0, 0]);
    expect(px(90, 50)).toEqual([0, 0, 255]);
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

describe("rawMovieShape (real h5wasm)", () => {
  // Plain rank-4 arrays (root or nested) go to the raw movie reader.
  it("routes the movie's rank-4 datasets to the raw reader", async () => {
    const h5 = await openWithRealH5wasm(MOVIE);
    try {
      expect(await rawMovieShape(h5, "/box")).toEqual([2, 64, 96, 3]);
      expect(await rawMovieShape(h5, "/g/first")).toEqual([2, 3, 64, 96]);
      expect(await rawMovieShape(h5, "/g")).toBeNull(); // a group
    } finally {
      await h5.close();
    }
  });

  // A package's embedded frames stay on the package reader.
  it("leaves a package's embedded frames alone", async () => {
    const pkg = path.join(import.meta.dir, "..", "fixtures", "embedded_source.pkg.slp");
    const h5 = await openWithRealH5wasm(pkg);
    try {
      expect(await rawMovieShape(h5, "video0/video")).toBeNull();
    } finally {
      await h5.close();
    }
  });
});
