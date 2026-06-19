/**
 * Tests for the post-removal selection helper. Pure: backend-less videos.
 */

import { describe, it, expect } from "../bun-test";
import { Video } from "@talmolab/sleap-io.js";
import { nextSelectedVideo } from "@/lib/removeVideo";

const mk = (filename: string) => new Video({ filename, openBackend: false });

describe("nextSelectedVideo", () => {
  it("selects the video that takes the removed middle slot", () => {
    const a = mk("a"), b = mk("b"), c = mk("c");
    expect(nextSelectedVideo([a, b, c], b)).toBe(c);
  });

  it("selects the new last video when the last is removed", () => {
    const a = mk("a"), b = mk("b"), c = mk("c");
    expect(nextSelectedVideo([a, b, c], c)).toBe(b);
  });

  it("selects the first remaining when the first is removed", () => {
    const a = mk("a"), b = mk("b"), c = mk("c");
    expect(nextSelectedVideo([a, b, c], a)).toBe(b);
  });

  it("returns null when the only video is removed", () => {
    const a = mk("a");
    expect(nextSelectedVideo([a], a)).toBeNull();
  });
});
