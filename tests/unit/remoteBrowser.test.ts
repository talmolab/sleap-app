import { describe, it, expect } from "../bun-test";
import type { FileEntry } from "@/lib/sleapConnect";
import {
  DEFAULT_SORT,
  baseName,
  fileKind,
  filterLabel,
  formatModified,
  formatSize,
  joinPath,
  matchesFilter,
  matchesSearch,
  mountRootFor,
  normalizeFilter,
  parentPath,
  pathTrail,
  sortEntries,
} from "@/lib/remoteBrowser";

const f = (name: string, extra: Partial<FileEntry> = {}): FileEntry => ({ name, isDir: false, ...extra });
const d = (name: string, extra: Partial<FileEntry> = {}): FileEntry => ({ name, isDir: true, ...extra });
const names = (es: FileEntry[]) => es.map((e) => e.name);

describe("paths", () => {
  it("joins, splits and names paths", () => {
    expect(joinPath("/a/", "b")).toBe("/a/b");
    expect(joinPath("/", "b")).toBe("/b");
    expect(parentPath("/a/b/")).toBe("/a");
    expect(parentPath("/a")).toBe("/");
    expect(baseName("/a/b.slp")).toBe("b.slp");
  });

  it("mountRootFor picks the longest containing mount", () => {
    expect(mountRootFor("/vast/exp1/x", ["/vast", "/vast/exp1"])).toBe("/vast/exp1");
    expect(mountRootFor("/vaster", ["/vast"])).toBeNull();
  });

  it("pathTrail lists every folder from the mount root down", () => {
    expect(pathTrail("/vast/exp1/videos", ["/vast"])).toEqual(["/vast", "/vast/exp1", "/vast/exp1/videos"]);
    expect(pathTrail("/vast", ["/vast"])).toEqual(["/vast"]);
    expect(pathTrail("/x/y", [])).toEqual(["/", "/x", "/x/y"]);
  });
});

describe("kinds + filters", () => {
  it("classifies by extension, case-insensitively", () => {
    expect(fileKind(f("Flies.SLP"))).toBe("labels");
    expect(fileKind(f("a.mp4"))).toBe("video");
    expect(fileKind(d("models.slp"))).toBe("folder");
    expect(fileKind(f("README"))).toBe("other");
  });

  it("matchesFilter lets folders through and checks files' extensions", () => {
    const exts = normalizeFilter([".SLP"]);
    expect(matchesFilter(f("a.slp"), exts)).toBe(true);
    expect(matchesFilter(f("a.mp4"), exts)).toBe(false);
    expect(matchesFilter(d("videos"), exts)).toBe(true);
    expect(matchesFilter(f("a.mp4"), null)).toBe(true);
  });

  it("filterLabel names known kinds", () => {
    expect(filterLabel([".slp"])).toBe("SLEAP labels (.slp)");
    expect(filterLabel([".xyz"])).toBe(".xyz");
  });

  it("matchesSearch is a case-insensitive substring match; blank matches all", () => {
    expect(matchesSearch(f("Flies_v003.slp"), "v003")).toBe(true);
    expect(matchesSearch(f("Flies.slp"), "FLIES")).toBe(true);
    expect(matchesSearch(f("a.slp"), "  ")).toBe(true);
    expect(matchesSearch(f("a.slp"), "b")).toBe(false);
  });
});

describe("sortEntries", () => {
  const entries = [f("b10.slp", { size: 5, modified: 300 }), d("zeta", { modified: 100 }), f("b2.mp4", { size: 50, modified: 200 }), d("alpha", { modified: 400 })];

  it("defaults to folders first, then natural name order", () => {
    expect(names(sortEntries(entries, DEFAULT_SORT))).toEqual(["alpha", "zeta", "b2.mp4", "b10.slp"]);
  });

  it("sorts by size and date modified in either direction", () => {
    expect(names(sortEntries(entries, { key: "size", dir: "desc", foldersFirst: false }))).toEqual(["b2.mp4", "b10.slp", "alpha", "zeta"]);
    expect(names(sortEntries(entries, { key: "modified", dir: "desc", foldersFirst: false }))).toEqual(["alpha", "b10.slp", "b2.mp4", "zeta"]);
  });

  it("date last opened puts never-opened entries last in both directions", () => {
    const lastOpened = { "/w/b2.mp4": 10, "/w/zeta": 20 };
    const asc = sortEntries(entries, { key: "lastOpened", dir: "asc", foldersFirst: false }, { dir: "/w", lastOpened });
    const desc = sortEntries(entries, { key: "lastOpened", dir: "desc", foldersFirst: false }, { dir: "/w", lastOpened });
    expect(names(asc)).toEqual(["b2.mp4", "zeta", "alpha", "b10.slp"]);
    expect(names(desc)).toEqual(["zeta", "b2.mp4", "alpha", "b10.slp"]);
  });
});

describe("formatting", () => {
  it("formats sizes", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2.5 * 1024 ** 2)).toBe("2.5 MB");
    expect(formatSize(3 * 1024 ** 3)).toBe("3.00 GB");
  });

  it("formats dates relative to today", () => {
    const now = new Date(2026, 9, 20, 15, 0);
    const at = (dayOffset: number) => new Date(2026, 9, 20 + dayOffset, 9, 5).getTime() / 1000;
    expect(formatModified(at(0), now)).toStartWith("Today at");
    expect(formatModified(at(-1), now)).toStartWith("Yesterday at");
    expect(formatModified(at(-3), now)).toContain("2026");
    expect(formatModified(undefined, now)).toBe("—");
  });
});
