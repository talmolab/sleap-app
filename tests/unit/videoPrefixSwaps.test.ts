import { describe, it, expect } from "../bun-test";
import {
  applyPrefixSwap,
  mergeVideoPrefixSwap,
  MAX_VIDEO_PREFIX_SWAPS,
  type VideoPrefixSwap,
} from "@/lib/videoPrefixSwaps";

describe("applyPrefixSwap (boundary-safe head swap)", () => {
  it("swaps a leading prefix, reaching a sibling subtree", () => {
    // The motivating case: .slp under /Volumes/talmo/elise, video under a
    // SIBLING subtree /Volumes/talmo/mustafa — only the mount root is shared.
    expect(
      applyPrefixSwap(
        "/root/vast/mustafa/session/clip.mp4",
        "/root/vast",
        "/Volumes/talmo",
      ),
    ).toBe("/Volumes/talmo/mustafa/session/clip.mp4");
  });

  it("normalizes backslashes before matching", () => {
    expect(
      applyPrefixSwap("D:\\old\\proj\\a.mp4", "D:/old", "/mnt/new"),
    ).toBe("/mnt/new/proj/a.mp4");
  });

  it("prepends newPrefix onto a relative path when oldPrefix is empty", () => {
    expect(
      applyPrefixSwap("videos/a.mp4", "", "/home/u/sleap"),
    ).toBe("/home/u/sleap/videos/a.mp4");
  });

  it("never prepends onto an absolute path when oldPrefix is empty", () => {
    expect(applyPrefixSwap("/already/abs/a.mp4", "", "/home/u")).toBeNull();
  });

  it("only matches on a directory boundary (no partial-segment match)", () => {
    // "/root/va" must NOT match inside "/root/vast/..."
    expect(
      applyPrefixSwap("/root/vast/a.mp4", "/root/va", "/new"),
    ).toBeNull();
  });

  it("returns null when the stored path doesn't start with oldPrefix", () => {
    expect(
      applyPrefixSwap("/other/tree/a.mp4", "/root/vast", "/Volumes/talmo"),
    ).toBeNull();
  });

  it("returns null for an empty stored path", () => {
    expect(applyPrefixSwap("", "/root/vast", "/Volumes/talmo")).toBeNull();
  });

  it("tolerates a trailing slash on newPrefix", () => {
    expect(
      applyPrefixSwap("/root/vast/a.mp4", "/root/vast", "/Volumes/talmo/"),
    ).toBe("/Volumes/talmo/a.mp4");
  });
});

describe("mergeVideoPrefixSwap (dedupe, newest-first, capped)", () => {
  const swap = (o: string, n: string): VideoPrefixSwap => ({
    oldPrefix: o,
    newPrefix: n,
  });

  it("inserts a new swap at the front", () => {
    const list = [swap("/a", "/b")];
    const merged = mergeVideoPrefixSwap(list, swap("/c", "/d"));
    expect(merged).toEqual([swap("/c", "/d"), swap("/a", "/b")]);
  });

  it("dedupes an identical swap and moves it to the front", () => {
    const list = [swap("/a", "/b"), swap("/c", "/d")];
    const merged = mergeVideoPrefixSwap(list, swap("/c", "/d"));
    expect(merged).toEqual([swap("/c", "/d"), swap("/a", "/b")]);
    expect(merged.length).toBe(2);
  });

  it("treats a different newPrefix for the same oldPrefix as distinct", () => {
    const list = [swap("/a", "/b")];
    const merged = mergeVideoPrefixSwap(list, swap("/a", "/z"));
    expect(merged).toEqual([swap("/a", "/z"), swap("/a", "/b")]);
  });

  it("does not mutate the input list", () => {
    const list = [swap("/a", "/b")];
    mergeVideoPrefixSwap(list, swap("/c", "/d"));
    expect(list).toEqual([swap("/a", "/b")]);
  });

  it("caps the list at MAX_VIDEO_PREFIX_SWAPS, dropping the oldest", () => {
    let list: VideoPrefixSwap[] = [];
    for (let i = 0; i < MAX_VIDEO_PREFIX_SWAPS + 10; i++) {
      list = mergeVideoPrefixSwap(list, swap(`/old${i}`, `/new${i}`));
    }
    expect(list.length).toBe(MAX_VIDEO_PREFIX_SWAPS);
    // Newest is at the front; the very first inserted has been evicted.
    expect(list[0]).toEqual(
      swap(`/old${MAX_VIDEO_PREFIX_SWAPS + 9}`, `/new${MAX_VIDEO_PREFIX_SWAPS + 9}`),
    );
    expect(list.some((s) => s.oldPrefix === "/old0")).toBe(false);
  });
});
