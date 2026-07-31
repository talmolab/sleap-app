/**
 * Unit tests for the PURE + injectable-fs core of the desktop (Tauri) labels-draft
 * manifest. The real `@tauri-apps/plugin-fs` leaves are manual/tauri-pilot-verified
 * (happy-dom has no Tauri fs), so here we cover: serialize/parse round-trips,
 * upsert/remove keyed by draftPath, the newest-first ordering, the "which draft to
 * recover?" decision, and a read/write round-trip through an in-memory fake fs.
 */
import { describe, it, expect } from "../bun-test";
import {
  serializeManifest,
  parseManifest,
  upsertManifestEntry,
  removeManifestEntry,
  sortEntriesNewestFirst,
  pickRestorableDraft,
  readManifestWithFs,
  writeManifestWithFs,
  MANIFEST_VERSION,
  type TauriDraftManifestEntry,
  type TauriDraftFs,
} from "@/lib/tauriDraftManifest";

function entry(
  partial: Partial<TauriDraftManifestEntry> & { draftPath: string },
): TauriDraftManifestEntry {
  return {
    projectPath: "/home/u/proj.slp",
    displayName: "proj.slp",
    savedAt: 1000,
    videoCount: 1,
    videoSignatures: ["a|10x2x2x1"],
    embedded: false,
    ...partial,
  };
}

/** Minimal in-memory {@link TauriDraftFs} for the read/write round-trip test. */
function fakeFs(): TauriDraftFs & { files: Map<string, string>; dirs: Set<string> } {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  return {
    files,
    dirs,
    async exists(path) {
      return files.has(path) || dirs.has(path);
    },
    async mkdir(path) {
      dirs.add(path);
    },
    async readTextFile(path) {
      const v = files.get(path);
      if (v === undefined) throw new Error(`ENOENT: ${path}`);
      return v;
    },
    async writeTextFile(path, contents) {
      files.set(path, contents);
    },
    async remove(path) {
      files.delete(path);
    },
  };
}

describe("serializeManifest / parseManifest", () => {
  it("round-trips entries through the on-disk JSON", () => {
    const entries = [entry({ draftPath: "/d/a.slp" }), entry({ draftPath: "/d/b.slp", savedAt: 2000 })];
    expect(parseManifest(serializeManifest(entries))).toEqual(entries);
  });

  it("stamps the schema version into the file", () => {
    const parsed = JSON.parse(serializeManifest([]));
    expect(parsed.version).toBe(MANIFEST_VERSION);
    expect(parsed.entries).toEqual([]);
  });

  it("returns [] for malformed JSON rather than throwing", () => {
    expect(parseManifest("not json {")).toEqual([]);
  });

  it("returns [] when entries is missing or the wrong shape", () => {
    expect(parseManifest("{}")).toEqual([]);
    expect(parseManifest('{"entries":"nope"}')).toEqual([]);
  });

  it("drops entries lacking a string draftPath", () => {
    const json = JSON.stringify({
      version: 1,
      entries: [{ displayName: "x" }, entry({ draftPath: "/d/ok.slp" })],
    });
    const parsed = parseManifest(json);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].draftPath).toBe("/d/ok.slp");
  });
});

describe("upsertManifestEntry / removeManifestEntry", () => {
  it("appends a new entry keyed by draftPath", () => {
    const out = upsertManifestEntry([entry({ draftPath: "/d/a.slp" })], entry({ draftPath: "/d/b.slp" }));
    expect(out.map((e) => e.draftPath)).toEqual(["/d/a.slp", "/d/b.slp"]);
  });

  it("replaces an existing entry with the same draftPath (no duplicate)", () => {
    const start = [entry({ draftPath: "/d/a.slp", savedAt: 1 })];
    const out = upsertManifestEntry(start, entry({ draftPath: "/d/a.slp", savedAt: 999 }));
    expect(out).toHaveLength(1);
    expect(out[0].savedAt).toBe(999);
  });

  it("does not mutate the input array", () => {
    const start = [entry({ draftPath: "/d/a.slp" })];
    upsertManifestEntry(start, entry({ draftPath: "/d/b.slp" }));
    expect(start).toHaveLength(1);
  });

  it("removes the entry with the given draftPath", () => {
    const start = [entry({ draftPath: "/d/a.slp" }), entry({ draftPath: "/d/b.slp" })];
    expect(removeManifestEntry(start, "/d/a.slp").map((e) => e.draftPath)).toEqual(["/d/b.slp"]);
  });
});

describe("sortEntriesNewestFirst", () => {
  it("orders by savedAt descending without mutating the input", () => {
    const start = [entry({ draftPath: "/d/a.slp", savedAt: 1 }), entry({ draftPath: "/d/b.slp", savedAt: 3 }), entry({ draftPath: "/d/c.slp", savedAt: 2 })];
    expect(sortEntriesNewestFirst(start).map((e) => e.savedAt)).toEqual([3, 2, 1]);
    expect(start.map((e) => e.savedAt)).toEqual([1, 3, 2]);
  });
});

describe("pickRestorableDraft (should we offer recovery?)", () => {
  const entries = [
    entry({ draftPath: "/d/old.slp", savedAt: 1 }),
    entry({ draftPath: "/d/new.slp", savedAt: 5 }),
    entry({ draftPath: "/d/mid.slp", savedAt: 3 }),
  ];

  it("returns null when no recorded draft still exists on disk", () => {
    expect(pickRestorableDraft(entries, () => false)).toBeNull();
  });

  it("returns null for an empty manifest", () => {
    expect(pickRestorableDraft([], () => true)).toBeNull();
  });

  it("returns the newest entry whose draft file still exists", () => {
    // Newest ("/d/new.slp") is gone (saved to disk) but two older drafts linger.
    const exists = (p: string) => p !== "/d/new.slp";
    expect(pickRestorableDraft(entries, exists)?.draftPath).toBe("/d/mid.slp");
  });

  it("prefers the newest existing draft over older ones", () => {
    expect(pickRestorableDraft(entries, () => true)?.draftPath).toBe("/d/new.slp");
  });
});

describe("readManifestWithFs / writeManifestWithFs (injected fs)", () => {
  const dir = "/appdata/sleap-drafts";
  const manifestPath = `${dir}/draft-manifest.json`;

  it("returns [] when the manifest file does not exist", async () => {
    const fs = fakeFs();
    expect(await readManifestWithFs(fs, manifestPath)).toEqual([]);
  });

  it("creates the drafts dir on first write, then round-trips entries", async () => {
    const fs = fakeFs();
    const entries = [entry({ draftPath: "/d/a.slp" }), entry({ draftPath: "/d/b.slp", savedAt: 2000 })];
    await writeManifestWithFs(fs, dir, manifestPath, entries);
    expect(fs.dirs.has(dir)).toBe(true);
    expect(await readManifestWithFs(fs, manifestPath)).toEqual(entries);
  });

  it("does not re-mkdir when the dir already exists", async () => {
    const fs = fakeFs();
    fs.dirs.add(dir);
    let mkdirCalls = 0;
    const spied: TauriDraftFs = { ...fs, mkdir: async (p) => { mkdirCalls++; await fs.mkdir(p); } };
    await writeManifestWithFs(spied, dir, manifestPath, []);
    expect(mkdirCalls).toBe(0);
  });

  it("returns [] when the on-disk manifest is corrupt", async () => {
    const fs = fakeFs();
    fs.files.set(manifestPath, "corrupt {{{");
    expect(await readManifestWithFs(fs, manifestPath)).toEqual([]);
  });
});
