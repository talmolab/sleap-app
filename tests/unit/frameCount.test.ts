import { describe, it, expect } from "../bun-test";
import {
  frameCountArgs,
  parseFrameCount,
  probeFrameCount,
  containerFrameCountArgs,
  parseContainerFrameCount,
  probeContainerFrameCount,
} from "@/lib/transcode/frameCount";
import type { TranscodeDeps } from "@/lib/transcode/transcodeVideo";

describe("frameCountArgs (ffprobe -count_frames)", () => {
  it("builds the exact ffprobe arg list with the path last", () => {
    expect(frameCountArgs("/v.mp4")).toEqual([
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-count_frames",
      "-show_entries",
      "stream=nb_read_frames",
      "-of",
      "json",
      "/v.mp4",
    ]);
  });
});

describe("parseFrameCount", () => {
  it("reads nb_read_frames from the first video stream", () => {
    expect(parseFrameCount('{"streams":[{"nb_read_frames":"42250"}]}')).toBe(
      42250
    );
  });
  it("returns null for malformed / empty / non-JSON input", () => {
    expect(parseFrameCount("{}")).toBeNull();
    expect(parseFrameCount("")).toBeNull();
    expect(parseFrameCount("not json")).toBeNull();
  });
});

describe("probeFrameCount", () => {
  it("runs ffprobe via the injected exec and parses the count", async () => {
    const deps: Pick<TranscodeDeps, "exec"> = {
      exec: async () => ({
        stdout: '{"streams":[{"nb_read_frames":"42250"}]}',
        stderr: "",
        code: 0,
      }),
    };
    expect(await probeFrameCount("/v.mp4", deps)).toBe(42250);
  });
});

describe("containerFrameCountArgs (fast: metadata, no decode)", () => {
  it("reads nb_frames from container metadata and does NOT decode", () => {
    const args = containerFrameCountArgs("/v.mp4");
    expect(args).toEqual([
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=nb_frames",
      "-of",
      "json",
      "/v.mp4",
    ]);
    // The whole point: no full-decode pass (that's the slow path).
    expect(args).not.toContain("-count_frames");
  });
});

describe("parseContainerFrameCount", () => {
  it("reads nb_frames from the first video stream", () => {
    expect(parseContainerFrameCount('{"streams":[{"nb_frames":"42250"}]}')).toBe(
      42250
    );
  });
  it("returns null when nb_frames is missing / N/A / zero / malformed", () => {
    // Some containers report no usable count → caller must fall back to the
    // exact (decode) path rather than trust a bad value.
    expect(parseContainerFrameCount('{"streams":[{"nb_frames":"N/A"}]}')).toBeNull();
    expect(parseContainerFrameCount('{"streams":[{"nb_frames":"0"}]}')).toBeNull();
    expect(parseContainerFrameCount('{"streams":[{}]}')).toBeNull();
    expect(parseContainerFrameCount("{}")).toBeNull();
    expect(parseContainerFrameCount("")).toBeNull();
  });
});

describe("probeContainerFrameCount", () => {
  it("runs the fast (metadata) ffprobe and parses nb_frames", async () => {
    const deps: Pick<TranscodeDeps, "exec"> = {
      exec: async () => ({
        stdout: '{"streams":[{"nb_frames":"42250"}]}',
        stderr: "",
        code: 0,
      }),
    };
    expect(await probeContainerFrameCount("/v.mp4", deps)).toBe(42250);
  });
});
