/**
 * Unit tests for the labels-draft path derivation (pure). The OPFS write/remove
 * leaves drive real OPFS, which happy-dom lacks, so they're manual-E2E-verified
 * (like the other OPFS helpers), not here.
 */
import { describe, it, expect } from "../bun-test";
import { draftPathFor, newDraftPath } from "@/lib/labelsDraft";

describe("draftPathFor (pure OPFS labels-draft path)", () => {
  it("prefixes sleap-draft-, strips the trailing .slp, and re-appends .slp", () => {
    expect(draftPathFor("train.slp", "abc")).toBe("sleap-draft-train-abc.slp");
  });

  it("keeps a .pkg segment when stripping only the final .slp", () => {
    expect(draftPathFor("train.pkg.slp", "abc")).toBe(
      "sleap-draft-train.pkg-abc.slp",
    );
  });

  it("sanitizes path-unsafe characters to single dashes", () => {
    expect(draftPathFor("my project/v2.slp", "9f")).toBe(
      "sleap-draft-my-project-v2-9f.slp",
    );
  });

  it("falls back to 'project' for an empty or blank name", () => {
    expect(draftPathFor("", "x")).toBe("sleap-draft-project-x.slp");
    expect(draftPathFor("   ", "x")).toBe("sleap-draft-project-x.slp");
  });
});

describe("newDraftPath (runtime-unique)", () => {
  it("produces a valid, unique draft path each call", () => {
    const a = newDraftPath("train.pkg.slp");
    const b = newDraftPath("train.pkg.slp");
    expect(a).toMatch(/^sleap-draft-train\.pkg-.+\.slp$/);
    expect(b).toMatch(/^sleap-draft-train\.pkg-.+\.slp$/);
    expect(a).not.toBe(b);
  });
});
