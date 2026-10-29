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
  mergeDraftEntry,
  sortEntriesNewestFirst,
  pickRestorableDraft,
  readManifestWithFs,
  writeManifestWithFs,
  updateManifestWithFs,
  pruneMissingDraftsWithFs,
  withManifestLock,
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

describe("mergeDraftEntry (preserve durable fields across re-saves)", () => {
  it("preserves the prior projectPath when a re-save's path is null", () => {
    // The poison case: a resume while the source volume was unmounted nulls
    // store.projectPath, so the next autosave passes projectPath: null. Losing
    // the original's path would permanently orphan an embedded draft from its
    // images — so a transient null must NOT overwrite a known path.
    const prior = entry({ draftPath: "/d/a.slp", projectPath: "/vol/orig.pkg.slp" });
    const next = entry({ draftPath: "/d/a.slp", projectPath: null, savedAt: 2000 });
    expect(mergeDraftEntry(prior, next).projectPath).toBe("/vol/orig.pkg.slp");
  });

  it("uses the new projectPath when it is a real path (Save-As to a new location)", () => {
    const prior = entry({ draftPath: "/d/a.slp", projectPath: "/vol/orig.pkg.slp" });
    const next = entry({ draftPath: "/d/a.slp", projectPath: "/new/place.pkg.slp" });
    expect(mergeDraftEntry(prior, next).projectPath).toBe("/new/place.pkg.slp");
  });

  it("stays null when neither prior nor new has a path (never-saved project)", () => {
    const next = entry({ draftPath: "/d/a.slp", projectPath: null });
    expect(mergeDraftEntry(undefined, next).projectPath).toBeNull();
  });

  it("preserves prior source size/mtime snapshot when the re-save omits them", () => {
    const prior = entry({
      draftPath: "/d/a.slp",
      sourceSize: 123,
      sourceLastModified: 456,
    });
    const next = entry({ draftPath: "/d/a.slp", savedAt: 2000 }); // no snapshot on re-save
    const merged = mergeDraftEntry(prior, next);
    expect(merged.sourceSize).toBe(123);
    expect(merged.sourceLastModified).toBe(456);
  });

  it("carries the re-save's fresh fields (savedAt, signatures) through", () => {
    const prior = entry({ draftPath: "/d/a.slp", savedAt: 1000, videoSignatures: ["old"] });
    const next = entry({
      draftPath: "/d/a.slp",
      projectPath: null,
      savedAt: 2000,
      videoSignatures: ["new1", "new2"],
    });
    const merged = mergeDraftEntry(prior, next);
    expect(merged.savedAt).toBe(2000);
    expect(merged.videoSignatures).toEqual(["new1", "new2"]);
    expect(merged.projectPath).toBe("/home/u/proj.slp"); // prior's default path retained
  });
});

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

/** {@link fakeFs} whose reads and writes yield to the event loop first, like the
 *  real Tauri plugin's IPC, so overlapping read-modify-writes actually interleave. */
function slowFs(): ReturnType<typeof fakeFs> {
  const fs = fakeFs();
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    ...fs,
    async readTextFile(path) {
      await tick();
      return fs.readTextFile(path);
    },
    async writeTextFile(path, contents) {
      await tick();
      return fs.writeTextFile(path, contents);
    },
  };
}

describe("manifest updates under concurrency (Discard all)", () => {
  const DIR = "/data/sleap-drafts";
  const MPATH = `${DIR}/draft-manifest.json`;
  const paths = ["/d/a.slp", "/d/b.slp", "/d/c.slp"];

  async function seeded() {
    const fs = slowFs();
    await writeManifestWithFs(fs, DIR, MPATH, paths.map((p) => entry({ draftPath: p })));
    return fs;
  }

  it("loses removals when unqueued read-modify-writes overlap (the bug)", async () => {
    const fs = await seeded();
    await Promise.all(
      paths.map(async (p) => {
        const entries = await readManifestWithFs(fs, MPATH);
        await writeManifestWithFs(fs, DIR, MPATH, removeManifestEntry(entries, p));
      }),
    );
    // Each write kept the other two entries it had read: the last one wins.
    expect((await readManifestWithFs(fs, MPATH)).length).toBe(2);
  });

  it("removes every entry when the removals go through updateManifestWithFs", async () => {
    const fs = await seeded();
    await Promise.all(
      paths.map((p) =>
        updateManifestWithFs(fs, DIR, MPATH, (entries) => removeManifestEntry(entries, p)),
      ),
    );
    expect(await readManifestWithFs(fs, MPATH)).toEqual([]);
  });

  it("keeps an autosave's upsert that races a discard", async () => {
    const fs = await seeded();
    await Promise.all([
      updateManifestWithFs(fs, DIR, MPATH, (es) => removeManifestEntry(es, "/d/a.slp")),
      updateManifestWithFs(fs, DIR, MPATH, (es) =>
        upsertManifestEntry(es, entry({ draftPath: "/d/new.slp" })),
      ),
    ]);
    expect((await readManifestWithFs(fs, MPATH)).map((e) => e.draftPath).sort()).toEqual([
      "/d/b.slp",
      "/d/c.slp",
      "/d/new.slp",
    ]);
  });

  it("keeps running queued work after an earlier task fails", async () => {
    const failed = withManifestLock(async () => {
      throw new Error("disk full");
    });
    const next = withManifestLock(async () => "ran");
    await expect(failed).rejects.toThrow("disk full");
    expect(await next).toBe("ran");
  });
});

describe("pruneMissingDraftsWithFs (orphaned entries)", () => {
  const DIR = "/data/sleap-drafts";
  const MPATH = `${DIR}/draft-manifest.json`;

  it("drops entries whose draft file is gone and rewrites the manifest", async () => {
    const fs = fakeFs();
    fs.files.set("/d/kept.slp", "draft");
    await writeManifestWithFs(fs, DIR, MPATH, [
      entry({ draftPath: "/d/kept.slp" }),
      entry({ draftPath: "/d/orphan.slp" }),
    ]);
    const kept = await pruneMissingDraftsWithFs(fs, DIR, MPATH);
    expect(kept.map((e) => e.draftPath)).toEqual(["/d/kept.slp"]);
    expect((await readManifestWithFs(fs, MPATH)).map((e) => e.draftPath)).toEqual([
      "/d/kept.slp",
    ]);
  });

  it("doesn't rewrite the manifest when nothing is missing", async () => {
    const fs = fakeFs();
    fs.files.set("/d/a.slp", "draft");
    await writeManifestWithFs(fs, DIR, MPATH, [entry({ draftPath: "/d/a.slp" })]);
    let writes = 0;
    const counting: TauriDraftFs = {
      ...fs,
      writeTextFile: async (p, c) => {
        writes++;
        await fs.writeTextFile(p, c);
      },
    };
    expect(await pruneMissingDraftsWithFs(counting, DIR, MPATH)).toHaveLength(1);
    expect(writes).toBe(0);
  });

  it("keeps an entry whose existence can't be checked", async () => {
    const fs = fakeFs();
    await writeManifestWithFs(fs, DIR, MPATH, [entry({ draftPath: "/d/unknown.slp" })]);
    const failing: TauriDraftFs = {
      ...fs,
      exists: async (p) => {
        if (p === "/d/unknown.slp") throw new Error("permission denied");
        return fs.exists(p);
      },
    };
    expect(await pruneMissingDraftsWithFs(failing, DIR, MPATH)).toHaveLength(1);
  });
});
