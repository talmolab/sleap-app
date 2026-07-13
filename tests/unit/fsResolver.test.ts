/**
 * Tests for the desktop (Tauri) FsResolver builder (src/lib/fsResolver.ts).
 *
 * The resolver is what sleap-io.js consults to resolve external / ImageVideo
 * source paths against the labels-file directory during load (issue #213). Only
 * `exists` participates in that resolution; `sameFile`/`realpath` back the
 * label-merge Matchers phase, which this app does not drive, so they degrade
 * conservatively. The module-global registration (`installTauriFsResolver`) isn't
 * exercised here because `getFsResolver` is not re-exported for read-back.
 */
import { describe, it, expect } from "../bun-test";
import { buildTauriFsResolver } from "@/lib/fsResolver";

describe("buildTauriFsResolver", () => {
  it("delegates exists() to the provided probe verbatim", async () => {
    const seen: string[] = [];
    const resolver = buildTauriFsResolver(async (p) => {
      seen.push(p);
      return p === "L:/proj/raw/f0.jpg";
    });
    expect(await resolver.exists("L:/proj/raw/f0.jpg")).toBe(true);
    expect(await resolver.exists("L:/proj/missing.jpg")).toBe(false);
    // Passed through unchanged (forward-slash candidates from the upstream
    // resolver reach the probe as-is; std::fs accepts them on Windows).
    expect(seen).toEqual(["L:/proj/raw/f0.jpg", "L:/proj/missing.jpg"]);
  });

  it("degrades sameFile() to false and realpath() to identity (Matchers unused)", async () => {
    const resolver = buildTauriFsResolver(async () => true);
    expect(await resolver.sameFile("/a", "/a")).toBe(false);
    expect(await resolver.realpath("/a/b/c")).toBe("/a/b/c");
  });
});
