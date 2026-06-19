/**
 * `isImageSequenceVideo` decides whether `resolveExternalVideos` should build an
 * ImageVideoBackend (vs. an mp4box single-file backend). The browser's streaming
 * reader leaves external videos backendless, so this classification is what keeps
 * an image-sequence from being (wrongly) routed to mp4box — which hangs on a JPEG.
 */
import { describe, it, expect } from "../bun-test";
import { Video } from "@talmolab/sleap-io.js";
import { isImageSequenceVideo } from "@/lib/resolveVideos";

describe("isImageSequenceVideo", () => {
  it("detects a single image-extension filename", () => {
    expect(isImageSequenceVideo(new Video({ filename: "frames/img.00.jpg" }))).toBe(true);
    expect(isImageSequenceVideo(new Video({ filename: "a.PNG" }))).toBe(true);
    expect(isImageSequenceVideo(new Video({ filename: "b.tiff" }))).toBe(true);
  });

  it("detects a list of image paths", () => {
    expect(
      isImageSequenceVideo(new Video({ filename: ["a.png", "b.png", "c.png"] }))
    ).toBe(true);
  });

  it("detects via the loader's backendError kind", () => {
    expect(
      isImageSequenceVideo(
        new Video({
          filename: "weird-name",
          backendError: { kind: "image-sequence", message: "missing" },
        })
      )
    ).toBe(true);
  });

  it("is false for real video files", () => {
    expect(isImageSequenceVideo(new Video({ filename: "movie.mp4" }))).toBe(false);
    expect(isImageSequenceVideo(new Video({ filename: "clip.webm" }))).toBe(false);
    expect(isImageSequenceVideo(new Video({ filename: "norpix.seq" }))).toBe(false);
  });
});
