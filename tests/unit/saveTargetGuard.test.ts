/**
 * Unit tests for the browser same-file save guard (`isSameSaveTarget`).
 *
 * A browser re-save of a large embedded pkg.slp reads the embedded images FROM
 * the opened source while streaming the result INTO the chosen destination. If
 * the two are the same on-disk file, the destination's `createWritable()`
 * truncates the only copy, so any mid-save failure zeroes the original (this
 * already destroyed a test file). The guard refuses that case up front.
 *
 * Identity is only decidable via `FileSystemFileHandle.isSameEntry`, so these
 * tests duck-type minimal handles rather than needing a real File System Access
 * implementation (unavailable under bun/happy-dom).
 */
import { describe, it, expect } from "../bun-test";
import { isSameSaveTarget } from "@/lib/saveTargetGuard";

/** Minimal duck-typed stand-in for a FileSystemFileHandle. */
function fakeHandle(
  name: string,
  sameEntry: (other: unknown) => Promise<boolean>,
): FileSystemFileHandle {
  return {
    name,
    kind: "file",
    isSameEntry: sameEntry,
  } as unknown as FileSystemFileHandle;
}

describe("isSameSaveTarget", () => {
  it("is true when the source handle reports the destination as the same entry", async () => {
    const dest = fakeHandle("train.pkg.slp", async () => true);
    const source = fakeHandle("train.pkg.slp", async () => true);
    expect(await isSameSaveTarget(source, dest)).toBe(true);
  });

  it("is false when the source handle reports a different entry", async () => {
    const dest = fakeHandle("out.pkg.slp", async () => false);
    const source = fakeHandle("train.pkg.slp", async () => false);
    expect(await isSameSaveTarget(source, dest)).toBe(false);
  });

  it("is false (best effort) for a bare File source with no identity to compare", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "train.pkg.slp");
    const dest = fakeHandle("train.pkg.slp", async () => true);
    expect(await isSameSaveTarget(file, dest)).toBe(false);
  });

  it("is false when the identity comparison throws (best effort — never blocks a save)", async () => {
    const dest = fakeHandle("train.pkg.slp", async () => true);
    const source = fakeHandle("train.pkg.slp", async () => {
      throw new Error("isSameEntry unavailable");
    });
    expect(await isSameSaveTarget(source, dest)).toBe(false);
  });
});
