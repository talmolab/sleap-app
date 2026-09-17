/**
 * Tests for external HDF5 video sources — a `.pkg.slp` / `.h5` used AS a video
 * rather than as the project file (see `src/lib/hdf5VideoSource.ts`).
 *
 * Everything here is the decoder-independent part: the extension table, the
 * dataset-detection rules (ported from Python `HDF5Video.__attrs_post_init__`),
 * and the picker filters. Actually decoding embedded PNGs out of a container
 * needs h5wasm + a Worker, which don't run under the bun test runner, so that
 * stays in manual/E2E coverage.
 */

import { describe, it, expect } from "../bun-test";
import { Video } from "@talmolab/sleap-io.js";
import {
  HDF5_VIDEO_EXTS,
  Hdf5DatasetPickCanceled,
  NoHdf5VideoDatasetError,
  detectHdf5VideoDataset,
  hdf5HintsForVideo,
  isHdf5VideoPath,
  listHdf5VideoDatasets,
  resolveHdf5Dataset,
  storedHdf5Dataset,
  type Hdf5Structure,
} from "@/lib/hdf5VideoSource";
import { locateVideoFilters, SUPPORTED_VIDEO_EXTS } from "@/lib/resolveVideos";

// ---------------------------------------------------------------------------
// Mock container: mirrors StreamingH5File's read API (structural Hdf5Structure)
// so the detection rules are testable without h5wasm or a Worker.
// `groups` maps a group name to its children; `datasets` maps a dataset path to
// its shape. Anything else rejects, exactly as the real reader does.
// ---------------------------------------------------------------------------
function mockContainer(spec: {
  groups?: Record<string, string[]>;
  datasets?: Record<string, number[]>;
}): Hdf5Structure {
  const groups = spec.groups ?? {};
  const datasets = spec.datasets ?? {};
  const roots = [
    ...Object.keys(groups),
    ...Object.keys(datasets).filter((d) => !d.includes("/")),
  ];
  return {
    keys: () => roots,
    getKeys: async (path) => {
      if (path in groups) return groups[path]!;
      throw new Error(`not a group: ${path}`);
    },
    getDatasetMeta: async (path) => {
      if (path in datasets) return { shape: datasets[path]!, dtype: "uint8" };
      throw new Error(`not a dataset: ${path}`);
    },
  };
}

/** A single-video SLEAP package: `video0/{video,frame_numbers,source_video}`. */
const onePackage = mockContainer({
  groups: {
    video0: ["frame_numbers", "source_video", "video"],
    metadata: [],
  },
  datasets: { videos_json: [1], frames: [1] },
});

/** A plain labels `.slp`: no embedded images anywhere. */
const labelsOnly = mockContainer({
  groups: { metadata: [] },
  datasets: { videos_json: [1], frames: [3], instances: [6], points: [12] },
});

describe("isHdf5VideoPath", () => {
  it("accepts every HDF5 container extension, .pkg.slp included", () => {
    expect(isHdf5VideoPath("labels.v001.pkg.slp")).toBe(true);
    expect(isHdf5VideoPath("/data/proj/labels.slp")).toBe(true);
    expect(isHdf5VideoPath("movie.h5")).toBe(true);
    expect(isHdf5VideoPath("movie.HDF5")).toBe(true);
    expect(isHdf5VideoPath(["frames.pkg.slp"])).toBe(true);
  });

  it("rejects media containers and extension-less names", () => {
    for (const name of ["clip.mp4", "clip.avi", "clip.seq", "clip", "clip.png"]) {
      expect(isHdf5VideoPath(name)).toBe(false);
    }
  });

  it("mirrors Python HDF5Video.EXTS", () => {
    // sleap-io `io/video_reading.py`: EXTS = ("h5", "hdf5", "slp")
    expect([...HDF5_VIDEO_EXTS].sort()).toEqual(["h5", "hdf5", "slp"]);
  });

  it("stays out of the media-import extension table", () => {
    // A dropped/imported `.slp` must keep meaning "open this project".
    for (const ext of HDF5_VIDEO_EXTS) {
      expect(SUPPORTED_VIDEO_EXTS).not.toContain(ext);
    }
  });
});

describe("listHdf5VideoDatasets", () => {
  it("finds every video group, lowest index first", async () => {
    const h5 = mockContainer({
      groups: {
        video10: ["video"],
        video2: ["video", "frame_numbers"],
        video0: ["video"],
        metadata: [],
      },
    });
    expect(await listHdf5VideoDatasets(h5)).toEqual([
      "video0/video",
      "video2/video",
      "video10/video",
    ]);
  });

  it("ignores groups with no video dataset and root datasets", async () => {
    expect(await listHdf5VideoDatasets(labelsOnly)).toEqual([]);
  });
});

describe("detectHdf5VideoDataset", () => {
  it("finds the embedded-image dataset in a package", async () => {
    expect(await detectHdf5VideoDataset(onePackage)).toBe("video0/video");
  });

  it("prefers a rank-4 dataset (a raw HDF5 movie), as Python does", async () => {
    const h5 = mockContainer({
      groups: { video0: ["video"] },
      datasets: { vid: [100, 480, 640, 3] },
    });
    expect(await detectHdf5VideoDataset(h5)).toBe("vid");
  });

  it("returns null for a labels-only .slp", async () => {
    expect(await detectHdf5VideoDataset(labelsOnly)).toBeNull();
  });
});

describe("resolveHdf5Dataset", () => {
  const multi = mockContainer({
    groups: { video0: ["video"], video1: ["video"], video2: ["video"] },
  });

  it("trusts the dataset the .slp recorded, without probing", async () => {
    // A package holds many videos; only the stored dataset says which one this
    // Video is, so it must win over detection order.
    let probed = false;
    const watched: Hdf5Structure = {
      keys: () => {
        probed = true;
        return [];
      },
      getKeys: multi.getKeys,
      getDatasetMeta: multi.getDatasetMeta,
    };
    expect(
      await resolveHdf5Dataset(watched, "p.pkg.slp", { dataset: "video2/video" })
    ).toBe("video2/video");
    expect(probed).toBe(false);
  });

  it("auto-picks the only video without prompting", async () => {
    let asked = false;
    const dataset = await resolveHdf5Dataset(onePackage, "p.pkg.slp", {
      pickDataset: async () => {
        asked = true;
        return null;
      },
    });
    expect(dataset).toBe("video0/video");
    expect(asked).toBe(false);
  });

  it("asks which video when a package holds several", async () => {
    const seen: string[][] = [];
    const dataset = await resolveHdf5Dataset(multi, "p.pkg.slp", {
      pickDataset: async (options) => {
        seen.push(options);
        return options[1]!;
      },
    });
    expect(dataset).toBe("video1/video");
    expect(seen).toEqual([["video0/video", "video1/video", "video2/video"]]);
  });

  it("takes the first video when no chooser is injected (load-time path)", async () => {
    // Auto-resolution on project load must not pop a modal; those videos carry
    // a stored dataset anyway, so this is only the degenerate fallback.
    expect(await resolveHdf5Dataset(multi, "p.pkg.slp")).toBe("video0/video");
  });

  it("reports cancellation distinctly from a bad file", async () => {
    await expect(
      resolveHdf5Dataset(multi, "p.pkg.slp", { pickDataset: async () => null })
    ).rejects.toBeInstanceOf(Hdf5DatasetPickCanceled);
  });

  it("explains a labels-only .slp instead of failing opaquely", async () => {
    const err = await resolveHdf5Dataset(labelsOnly, "labels.slp").catch(
      (e) => e
    );
    expect(err).toBeInstanceOf(NoHdf5VideoDatasetError);
    expect((err as Error).message).toContain("labels.slp");
    expect((err as Error).message).toContain("no video data");
  });
});

describe("hints carried from the referencing .slp", () => {
  it("reads the dataset out of backendMetadata", () => {
    const video = new Video({
      filename: "/data/labels.pkg.slp",
      openBackend: false,
      backendMetadata: { dataset: "video3/video" },
    });
    expect(storedHdf5Dataset(video)).toBe("video3/video");
  });

  it("treats a missing or empty dataset as unknown", () => {
    const blank = new Video({
      filename: "/data/labels.pkg.slp",
      openBackend: false,
      backendMetadata: { dataset: "" },
    });
    expect(storedHdf5Dataset(blank)).toBeNull();
    const none = new Video({ filename: "x.pkg.slp", openBackend: false });
    expect(storedHdf5Dataset(none)).toBeNull();
  });

  it("forwards the encoding metadata a legacy package needs to decode right", () => {
    // channel_order is the one that silently corrupts colors when dropped:
    // packages written before SLP 1.4 hold BGR-encoded PNGs.
    const video = new Video({
      filename: "/data/labels.pkg.slp",
      openBackend: false,
      backendMetadata: {
        dataset: "video0/video",
        format: "png",
        channel_order: "BGR",
        fps: 30,
        shape: [1000, 384, 384, 1],
      },
    });
    expect(hdf5HintsForVideo(video)).toEqual({
      dataset: "video0/video",
      format: "png",
      channelOrder: "BGR",
      fps: 30,
      shape: [1000, 384, 384, 1],
    });
  });
});

describe("locateVideoFilters", () => {
  it("offers the missing source's own extension first", () => {
    // Legacy-GUI parity: `Missing file type (*.slp)` then everything else
    // (sleap/gui/dialogs/missingfiles.py).
    const filters = locateVideoFilters("/old/machine/labels.v001.pkg.slp");
    expect(filters[0]!.extensions).toEqual(["slp"]);
    expect(filters[1]!.extensions).toContain("slp");
    expect(filters[1]!.extensions).toContain("mp4");
  });

  it("still lets a .pkg.slp source be replaced by a plain video", () => {
    const all = locateVideoFilters("labels.pkg.slp")[1]!.extensions;
    for (const ext of SUPPORTED_VIDEO_EXTS) expect(all).toContain(ext);
  });

  it("offers every relinkable source when no single extension applies", () => {
    for (const current of [null, undefined, "weird.xyz"]) {
      const filters = locateVideoFilters(current);
      expect(filters).toHaveLength(1);
      expect(filters[0]!.extensions).toContain("slp");
      expect(filters[0]!.extensions).toContain("mp4");
    }
  });

  it("leads with the extension of an mp4-backed video too", () => {
    expect(locateVideoFilters("/data/clip.MP4")[0]!.extensions).toEqual(["mp4"]);
  });
});
