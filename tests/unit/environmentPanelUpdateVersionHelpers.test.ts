/**
 * Unit tests for EnvironmentPanel's pure version-display helpers (channel
 * switch / downgrade support -- see src-tauri/src/update_channels.rs's
 * `should_offer_update` for the matching backend-side tests).
 */

import { describe, it, expect } from "../bun-test";
// classifyVersion moved to @/lib/version when the About dialog and the web
// menu-bar wordmark started needing the same wording; the update-comparison
// helpers below are still EnvironmentPanel's own.
import { classifyVersion } from "@/lib/version";
import {
  parseBaseVersion,
  isOlderVersion,
} from "@/components/panels/EnvironmentPanel";

describe("classifyVersion", () => {
  it("classifies a plain tagged release as stable", () => {
    expect(classifyVersion("1.5.0")).toBe("stable");
  });

  it("classifies a numeric prerelease tag as prerelease", () => {
    expect(classifyVersion("1.5.0-2")).toBe("prerelease");
  });

  it("classifies a build-metadata-suffixed version as dev", () => {
    expect(classifyVersion("1.5.0+42.abc1234")).toBe("dev");
  });
});

describe("parseBaseVersion", () => {
  it("strips prerelease and build metadata down to major.minor.patch", () => {
    expect(parseBaseVersion("1.5.0+42.abc1234")).toEqual([1, 5, 0]);
    expect(parseBaseVersion("1.5.0-2")).toEqual([1, 5, 0]);
    expect(parseBaseVersion("1.5.0")).toEqual([1, 5, 0]);
  });
});

describe("isOlderVersion", () => {
  it("is false when the target is a genuinely newer release", () => {
    expect(isOlderVersion("1.5.0", "1.4.0")).toBe(false);
  });

  it("is false for the same base version", () => {
    expect(isOlderVersion("1.5.0", "1.5.0")).toBe(false);
  });

  // The scenario from the conversation: switching the channel dropdown from
  // "dev" (running 1.5.0+42.abc1234) to "stable" (whose manifest points at
  // the plain 1.5.0 tag) is a same-base "switch", not an upgrade -- and
  // switching to an actually-older stable tag (1.4.0) is a real downgrade.
  it("ignores build metadata when the base version matches", () => {
    expect(isOlderVersion("1.5.0", "1.5.0+42.abc1234")).toBe(false);
  });

  it("is true when the target's base version is behind what's running", () => {
    expect(isOlderVersion("1.4.0", "1.5.0+42.abc1234")).toBe(true);
  });
});
