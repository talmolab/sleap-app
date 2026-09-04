import { describe, it, expect } from "../bun-test";
import {
  frameCountArgs,
  parseFrameCount,
  probeFrameCount,
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
