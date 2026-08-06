import { describe, it, expect } from "../bun-test";
import { videoBasename, videoFilenameMatches } from "@/lib/videoFilter";

describe("videoBasename", () => {
  it("returns the last path segment of a string filename", () => {
    expect(videoBasename("/base/dir/clip.mp4")).toBe("clip.mp4");
    expect(videoBasename("C:\\videos\\clip.mp4")).toBe("clip.mp4");
  });
  it("uses the first entry for an image-sequence (string[]) filename", () => {
    expect(videoBasename(["/imgs/frame_000.png", "/imgs/frame_001.png"])).toBe(
      "frame_000.png",
    );
  });
});

describe("videoFilenameMatches", () => {
  it("matches a case-insensitive substring of the basename", () => {
    expect(videoFilenameMatches("/base/MyClip.mp4", "clip")).toBe(true);
    expect(videoFilenameMatches("/base/MyClip.mp4", "CLIP")).toBe(true);
    expect(videoFilenameMatches("/base/MyClip.mp4", "xyz")).toBe(false);
  });
  it("matches against the basename only, not the directory", () => {
    expect(videoFilenameMatches("/clip_dir/other.mp4", "clip")).toBe(false);
  });
  it("empty / whitespace query matches everything", () => {
    expect(videoFilenameMatches("/base/anything.mp4", "")).toBe(true);
    expect(videoFilenameMatches("/base/anything.mp4", "   ")).toBe(true);
  });
  it("matches the first entry of an image-sequence filename", () => {
    expect(videoFilenameMatches(["/imgs/frame_000.png"], "frame_0")).toBe(true);
  });
});
