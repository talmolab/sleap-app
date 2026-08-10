/**
 * Tests for the NWB export command's pure helpers.
 *
 * NWB export runs the sleap-nn venv's sleap-io in a subprocess (desktop only):
 * the app serializes the current labels to a temp `.slp`, then a Rust command
 * (`export_nwb`) shells out to `sio.save_file(sio.load_file(tmp), out.nwb)`.
 * These helpers cover the pure bits the command depends on — output/temp filename
 * derivation, the image-sequence guard (the ndx-pose writer can't store
 * image-sequence videos — a shared SLEAP/pynwb limitation), and recognizing the
 * "sleap-nn env missing" error so the UI can prompt to install it.
 */

import { describe, it, expect } from "../bun-test";
import { Labels, Skeleton, Video, LabeledFrame } from "@talmolab/sleap-io.js";
import {
  deriveNwbFilename,
  tempSlpPathFor,
  hasImageSequenceVideo,
  isSleapNnMissingError,
} from "@/commands/exportNwbCommands";

describe("deriveNwbFilename", () => {
  it("defaults to labels.nwb when there is no project filename", () => {
    expect(deriveNwbFilename(null)).toBe("labels.nwb");
  });

  it("swaps a .slp extension for .nwb", () => {
    expect(deriveNwbFilename("session.slp")).toBe("session.nwb");
  });

  it("strips a .pkg.slp double extension", () => {
    expect(deriveNwbFilename("x.pkg.slp")).toBe("x.nwb");
  });

  it("swaps .json and is a no-op-ish on .nwb", () => {
    expect(deriveNwbFilename("y.json")).toBe("y.nwb");
    expect(deriveNwbFilename("z.nwb")).toBe("z.nwb");
  });

  it("preserves the directory portion of a path", () => {
    expect(deriveNwbFilename("/a/b/proj.slp")).toBe("/a/b/proj.nwb");
  });
});

describe("tempSlpPathFor", () => {
  it("derives a sibling temp path that still ends in .slp (so sio.load_file works)", () => {
    expect(tempSlpPathFor("/a/b/out.nwb")).toBe("/a/b/out.export.tmp.slp");
  });

  it("ends in .slp even when the output has no .nwb extension", () => {
    const p = tempSlpPathFor("weird");
    expect(p.endsWith(".slp")).toBe(true);
  });
});

describe("hasImageSequenceVideo", () => {
  function labelsWith(video: Video): Labels {
    const skeleton = new Skeleton({ nodes: [], name: "s" });
    return new Labels({
      skeletons: [skeleton],
      videos: [video],
      labeledFrames: [new LabeledFrame({ video, frameIdx: 0, instances: [] })],
    });
  }

  it("is false for a normal single-file video", () => {
    expect(hasImageSequenceVideo(labelsWith(new Video({ filename: "movie.mp4" })))).toBe(false);
  });

  it("is true when any video is an image-sequence (array of image paths)", () => {
    expect(
      hasImageSequenceVideo(labelsWith(new Video({ filename: ["a.png", "b.png"] })))
    ).toBe(true);
  });

  it("is true for a single image-extension filename", () => {
    expect(hasImageSequenceVideo(labelsWith(new Video({ filename: "frames/img.00.jpg" })))).toBe(
      true
    );
  });
});

describe("isSleapNnMissingError", () => {
  it("recognizes the Rust sentinel", () => {
    expect(isSleapNnMissingError("SLEAP_NN_NOT_INSTALLED")).toBe(true);
  });

  it("recognizes the resolver's human message", () => {
    expect(
      isSleapNnMissingError(
        "sleap-nn environment not found at /x — install sleap-nn before training."
      )
    ).toBe(true);
  });

  it("matches even when wrapped by the invoke error envelope", () => {
    expect(isSleapNnMissingError("Error: SLEAP_NN_NOT_INSTALLED")).toBe(true);
  });

  it("is false for an unrelated error", () => {
    expect(isSleapNnMissingError("RuntimeError: unable to write attribute")).toBe(false);
  });
});
