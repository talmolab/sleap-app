import { describe, it, expect } from "../bun-test";
import {
  shouldBuildScrubProxy,
  type ScrubProxyPolicyInput,
} from "@/lib/transcode/proxyPolicy";

// A baseline input where every gate passes; each test flips ONE field false.
const allTrue: ScrubProxyPolicyInput = {
  enabled: true,
  isTauri: true,
  path: "/Volumes/talmo/a/b.mp4",
  sizeBytes: 200 * 1024 * 1024, // 200 MB, above the default 50 MB floor
  isExternalDecodableVideo: true,
};

describe("shouldBuildScrubProxy (worthiness gate)", () => {
  it("all conditions met → true", () => {
    expect(shouldBuildScrubProxy(allTrue)).toBe(true);
  });
  it("disabled → false", () => {
    expect(shouldBuildScrubProxy({ ...allTrue, enabled: false })).toBe(false);
  });
  it("not Tauri (browser) → false", () => {
    expect(shouldBuildScrubProxy({ ...allTrue, isTauri: false })).toBe(false);
  });
  it("not an external decodable video → false", () => {
    expect(
      shouldBuildScrubProxy({ ...allTrue, isExternalDecodableVideo: false })
    ).toBe(false);
  });
  it("local (non-network) path → false", () => {
    expect(
      shouldBuildScrubProxy({ ...allTrue, path: "/Users/me/b.mp4" })
    ).toBe(false);
  });
  it("under the size threshold → false", () => {
    expect(
      shouldBuildScrubProxy({ ...allTrue, sizeBytes: 10 * 1024 * 1024 })
    ).toBe(false);
  });
  it("respects a custom minBytes", () => {
    expect(
      shouldBuildScrubProxy({ ...allTrue, sizeBytes: 100, minBytes: 50 })
    ).toBe(true);
    expect(
      shouldBuildScrubProxy({ ...allTrue, sizeBytes: 10, minBytes: 50 })
    ).toBe(false);
  });
});
