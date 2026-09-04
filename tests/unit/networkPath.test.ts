import { describe, it, expect } from "../bun-test";
import { isNetworkPath } from "@/lib/transcode/networkPath";

describe("isNetworkPath (network-mount heuristic)", () => {
  it("flags macOS network mounts", () => {
    expect(isNetworkPath("/Volumes/talmo/a/b.mp4")).toBe(true);
  });
  it("flags Windows UNC paths", () => {
    expect(isNetworkPath("\\\\server\\share\\b.mp4")).toBe(true);
  });
  it("flags common Linux mount roots", () => {
    expect(isNetworkPath("/mnt/nas/b.mp4")).toBe(true);
    expect(isNetworkPath("/media/nas/b.mp4")).toBe(true);
  });
  it("matches the mount prefixes case-insensitively", () => {
    expect(isNetworkPath("/VOLUMES/talmo/b.mp4")).toBe(true);
    expect(isNetworkPath("/Mnt/nas/b.mp4")).toBe(true);
    expect(isNetworkPath("/Media/nas/b.mp4")).toBe(true);
  });
  it("does not flag local paths", () => {
    expect(isNetworkPath("/Users/me/b.mp4")).toBe(false);
    expect(isNetworkPath("C:/Users/me/b.mp4")).toBe(false);
  });
});
