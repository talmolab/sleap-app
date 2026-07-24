/**
 * Unit tests for the OPFS working-copy lifecycle's PURE logic:
 *  - working-copy path derivation (`workingCopyPathFor` / `newWorkingCopyPath`);
 *  - the patch-or-reseed orchestration (`commitToWorkingCopy`) via an injected
 *    ops seam — proving the control flow (when to seed, and that the old copy is
 *    only removed AFTER a fresh one exists) with no OPFS / Worker I/O.
 *
 * The I/O leaves (`seedWorkingCopy`/`saveWorkingCopy`/`exportWorkingCopy`) drive
 * real OPFS sync handles + Workers, which happy-dom lacks, so they are verified
 * by manual E2E in Chrome (same as `saveEmbeddedPkgOpfs.ts`), not here.
 */
import { describe, it, expect } from "../bun-test";
import type { Labels } from "@talmolab/sleap-io.js";
import {
  workingCopyPathFor,
  newWorkingCopyPath,
  commitToWorkingCopy,
  type WorkingCopy,
  type CommitOps,
} from "@/lib/opfsWorkingCopy";

const LABELS = { __sentinel: "labels" } as unknown as Labels;
const SOURCE = { __sentinel: "source" } as unknown as File;

function wc(opfsPath: string): WorkingCopy {
  return { opfsPath, baseline: {} as WorkingCopy["baseline"] };
}

describe("workingCopyPathFor (pure OPFS working-copy path)", () => {
  it("prefixes sleap-wc-, strips the trailing .slp, and re-appends .slp", () => {
    expect(workingCopyPathFor("train.slp", "abc")).toBe("sleap-wc-train-abc.slp");
  });

  it("keeps a .pkg segment when stripping only the final .slp", () => {
    expect(workingCopyPathFor("train.pkg.slp", "abc")).toBe(
      "sleap-wc-train.pkg-abc.slp",
    );
  });

  it("sanitizes path-unsafe characters to single dashes", () => {
    expect(workingCopyPathFor("my project/v2.slp", "9f")).toBe(
      "sleap-wc-my-project-v2-9f.slp",
    );
  });

  it("falls back to 'project' for an empty or blank name", () => {
    expect(workingCopyPathFor("", "x")).toBe("sleap-wc-project-x.slp");
    expect(workingCopyPathFor("   ", "x")).toBe("sleap-wc-project-x.slp");
  });
});

describe("newWorkingCopyPath (runtime-unique)", () => {
  it("produces a valid, unique working-copy path each call", () => {
    const a = newWorkingCopyPath("train.pkg.slp");
    const b = newWorkingCopyPath("train.pkg.slp");
    expect(a).toMatch(/^sleap-wc-train\.pkg-.+\.slp$/);
    expect(b).toMatch(/^sleap-wc-train\.pkg-.+\.slp$/);
    expect(a).not.toBe(b);
  });
});

describe("commitToWorkingCopy (patch-or-reseed orchestration)", () => {
  it("returns the patched copy and neither seeds nor removes when the patch succeeds", async () => {
    const calls: string[] = [];
    const patched = wc("sleap-wc-p-1.slp");
    const ops: CommitOps = {
      save: async () => {
        calls.push("save");
        return { kind: "patched", workingCopy: patched };
      },
      reseedSource: async () => {
        calls.push("reseedSource");
        throw new Error("should not resolve a reseed source");
      },
      newPath: () => {
        calls.push("newPath");
        return "unused";
      },
      seed: async () => {
        calls.push("seed");
        throw new Error("should not seed");
      },
      remove: async () => {
        calls.push("remove");
      },
    };
    const out = await commitToWorkingCopy(LABELS, wc("sleap-wc-old-1.slp"), {
      ops,
    });
    expect(out).toBe(patched);
    expect(calls).toEqual(["save"]);
  });

  it("re-seeds to a fresh path and removes the old copy only AFTER the new one exists", async () => {
    const calls: string[] = [];
    const old = wc("sleap-wc-old-1.slp");
    const fresh = wc("sleap-wc-new-2.slp");
    let seedArgs: unknown[] = [];
    const ops: CommitOps = {
      save: async () => {
        calls.push("save");
        return { kind: "needs-reseed", reason: "a track was added" };
      },
      reseedSource: async (w) => {
        calls.push("reseedSource:" + w.opfsPath);
        return SOURCE;
      },
      newPath: () => {
        calls.push("newPath");
        return fresh.opfsPath;
      },
      seed: async (labels, source, path) => {
        calls.push("seed:" + path);
        seedArgs = [labels, source, path];
        return fresh;
      },
      remove: async (p) => {
        calls.push("remove:" + p);
      },
    };
    const out = await commitToWorkingCopy(LABELS, old, { ops });
    expect(out).toBe(fresh);
    // Reseed source is resolved from the OLD copy, seeded at the fresh path.
    expect(seedArgs).toEqual([LABELS, SOURCE, fresh.opfsPath]);
    // Ordering matters for data safety: seed the new copy BEFORE removing old.
    expect(calls).toEqual([
      "save",
      "reseedSource:sleap-wc-old-1.slp",
      "newPath",
      "seed:sleap-wc-new-2.slp",
      "remove:sleap-wc-old-1.slp",
    ]);
  });

  it("does NOT remove the old copy if the re-seed fails (old copy stays recoverable)", async () => {
    const calls: string[] = [];
    const old = wc("sleap-wc-old-1.slp");
    const ops: CommitOps = {
      save: async () => {
        calls.push("save");
        return { kind: "needs-reseed", reason: "structural" };
      },
      reseedSource: async () => {
        calls.push("reseedSource");
        return SOURCE;
      },
      newPath: () => "sleap-wc-new-2.slp",
      seed: async () => {
        calls.push("seed");
        throw new Error("seed failed");
      },
      remove: async (p) => {
        calls.push("remove:" + p);
      },
    };
    await expect(
      commitToWorkingCopy(LABELS, old, { ops }),
    ).rejects.toThrow(/seed failed/);
    expect(calls).not.toContain("remove:sleap-wc-old-1.slp");
  });
});
