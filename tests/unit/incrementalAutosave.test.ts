/**
 * Unit tests for the incremental-autosave orchestration (Phase 2b core).
 *
 * This is the runtime-agnostic "brain" the debounced autosave tick calls once
 * the feature flag is on: given the drained dirty-frame set, decide whether to
 * rewrite the whole base, append a delta record per dirty frame, or do nothing;
 * then drive an injected JournalStore. The storage leaves (OPFS/Tauri append)
 * and the live wiring live elsewhere; here everything runs against an in-memory
 * store + in-memory Labels so the decision + encode/append flow is CI-covered.
 */
import { describe, it, expect } from "../bun-test";
import {
  decideAutosaveWrite,
  frameHasAdvancedInstanceFields,
  runIncrementalAutosave,
  baseBakPath,
  replayJournal,
  InMemoryJournalStore,
  DEFAULT_JOURNAL_MAX_BYTES,
} from "@/lib/incrementalAutosave";
import {
  decodeJournal,
  buildBaseIndex,
  encodeFrameDelta,
  frameDeltaToRecord,
} from "@/lib/autosaveJournal";
import type { FrameKey } from "@/lib/autosaveDirty";
import {
  Labels,
  LabeledFrame,
  Instance,
  Video,
  Skeleton,
  Track,
} from "@talmolab/sleap-io.js";

function makeSkeleton(): Skeleton {
  const s = new Skeleton({ nodes: ["a", "b"], name: "s" });
  s.addEdge(s.nodes[0], s.nodes[1]);
  return s;
}
function makeVideo(name: string): Video {
  return new Video({
    filename: `/v/${name}.mp4`,
    backendMetadata: { shape: [100, 480, 640, 3] },
    openBackend: false,
  });
}
function makeBase() {
  const sk = makeSkeleton();
  const video = makeVideo("main");
  const trackA = new Track("A");
  const frames: LabeledFrame[] = [];
  for (let i = 0; i < 4; i++) {
    const inst = Instance.fromArray([[i, i], [i + 1, i + 1]], sk);
    inst.track = trackA;
    frames.push(new LabeledFrame({ video, frameIdx: i, instances: [inst] }));
  }
  const labels = new Labels({
    labeledFrames: frames,
    skeletons: [sk],
    videos: [video],
    tracks: [trackA],
  });
  return { labels, sk, video, trackA, frames };
}

describe("decideAutosaveWrite", () => {
  const base = {
    hasBase: true,
    needsFullSnapshot: false,
    dirtyFrameCount: 2,
    journalBytes: 0,
    journalMaxBytes: DEFAULT_JOURNAL_MAX_BYTES,
  };
  it("first write (no base yet) with pending work → full", () => {
    expect(decideAutosaveWrite({ ...base, hasBase: false })).toBe("full");
  });
  it("first write with nothing pending → noop", () => {
    expect(
      decideAutosaveWrite({ ...base, hasBase: false, dirtyFrameCount: 0 }),
    ).toBe("noop");
  });
  it("structural change → full", () => {
    expect(decideAutosaveWrite({ ...base, needsFullSnapshot: true })).toBe("full");
  });
  it("nothing pending (has base) → noop", () => {
    expect(decideAutosaveWrite({ ...base, dirtyFrameCount: 0 })).toBe("noop");
  });
  it("dirty frames under the journal size cap → append", () => {
    expect(decideAutosaveWrite(base)).toBe("append");
  });
  it("dirty frames but journal over the size cap → full (compaction)", () => {
    expect(
      decideAutosaveWrite({ ...base, journalBytes: DEFAULT_JOURNAL_MAX_BYTES + 1 }),
    ).toBe("full");
  });
});

describe("frameHasAdvancedInstanceFields", () => {
  it("is false for plain user/predicted instances", () => {
    const { frames } = makeBase();
    expect(frameHasAdvancedInstanceFields(frames[0])).toBe(false);
  });
  it("is true when an instance carries an identity", () => {
    const { frames } = makeBase();
    (frames[0].instances[0] as unknown as { identity: unknown }).identity = { id: 1 };
    expect(frameHasAdvancedInstanceFields(frames[0])).toBe(true);
  });
  it("is true when an instance carries a category", () => {
    const { frames } = makeBase();
    (frames[0].instances[0] as unknown as { category: string }).category = "mouse";
    expect(frameHasAdvancedInstanceFields(frames[0])).toBe(true);
  });
});

describe("runIncrementalAutosave", () => {
  function deps(over: Record<string, unknown> = {}) {
    const b = makeBase();
    let baseWrites = 0;
    const store = new InMemoryJournalStore();
    return {
      b,
      store,
      get baseWrites() {
        return baseWrites;
      },
      call: (drained: { needsFullSnapshot: boolean; frames: FrameKey[] }, o: Record<string, unknown> = {}) =>
        runIncrementalAutosave({
          labels: b.labels,
          drained,
          store,
          writeBase: async () => {
            baseWrites += 1;
          },
          hasBase: true,
          journalBytes: 0,
          ...over,
          ...o,
        }),
    };
  }

  it("does nothing when the drain is empty", async () => {
    const d = deps();
    const action = await d.call({ needsFullSnapshot: false, frames: [] });
    expect(action).toBe("noop");
    expect(d.baseWrites).toBe(0);
    expect((await d.store.readAll()).length).toBe(0);
  });

  it("writes a full base and truncates the journal on a structural change", async () => {
    const d = deps();
    // Seed some journal bytes so we can prove truncation.
    await d.store.appendRecords([new Uint8Array([1, 2, 3])]);
    const action = await d.call({ needsFullSnapshot: true, frames: [] });
    expect(action).toBe("full");
    expect(d.baseWrites).toBe(1);
    expect((await d.store.readAll()).length).toBe(0); // truncated
  });

  it("appends one decodable delta per dirty frame (no base rewrite)", async () => {
    const d = deps();
    const { video } = d.b;
    const action = await d.call({
      needsFullSnapshot: false,
      frames: [
        { video, frameIdx: 1 },
        { video, frameIdx: 2 },
      ],
    });
    expect(action).toBe("append");
    expect(d.baseWrites).toBe(0);
    const { deltas, truncatedTail } = decodeJournal(await d.store.readAll());
    expect(truncatedTail).toBe(false);
    expect(deltas.map((x) => x.f).sort()).toEqual([1, 2]);
  });

  it("promotes to a full snapshot when a dirty frame carries advanced fields", async () => {
    const d = deps();
    const { video, frames } = d.b;
    (frames[1].instances[0] as unknown as { category: string }).category = "mouse";
    const action = await d.call({
      needsFullSnapshot: false,
      frames: [{ video, frameIdx: 1 }],
    });
    expect(action).toBe("full");
    expect(d.baseWrites).toBe(1);
  });

  it("writes a full base on the first write even with only frame edits", async () => {
    const d = deps();
    const { video } = d.b;
    const action = await d.call(
      { needsFullSnapshot: false, frames: [{ video, frameIdx: 1 }] },
      { hasBase: false },
    );
    expect(action).toBe("full");
    expect(d.baseWrites).toBe(1);
  });
});

describe("baseBakPath", () => {
  it("appends .bak to the base path", () => {
    expect(baseBakPath("/drafts/foo.slp")).toBe("/drafts/foo.slp.bak");
    expect(baseBakPath("proj-123.slp")).toBe("proj-123.slp.bak");
  });
});

describe("runIncrementalAutosave — previous-base retention", () => {
  it("backs up the current base BEFORE rewriting it on a full write", async () => {
    const order: string[] = [];
    const store = new InMemoryJournalStore();
    const b = makeBase();
    const action = await runIncrementalAutosave({
      labels: b.labels,
      drained: { needsFullSnapshot: true, frames: [] },
      store,
      backupBase: async () => {
        order.push("backup");
      },
      writeBase: async () => {
        order.push("write");
      },
      hasBase: true,
      journalBytes: 0,
    });
    expect(action).toBe("full");
    expect(order).toEqual(["backup", "write"]); // backup must precede the overwrite
  });

  it("does NOT back up on an append (the base is not replaced)", async () => {
    const order: string[] = [];
    const store = new InMemoryJournalStore();
    const b = makeBase();
    await runIncrementalAutosave({
      labels: b.labels,
      drained: { needsFullSnapshot: false, frames: [{ video: b.video, frameIdx: 1 }] },
      store,
      backupBase: async () => {
        order.push("backup");
      },
      writeBase: async () => {
        order.push("write");
      },
      hasBase: true,
      journalBytes: 0,
    });
    expect(order).toEqual([]);
  });

  it("a backup failure never blocks the base write (best-effort)", async () => {
    let wrote = false;
    const store = new InMemoryJournalStore();
    const b = makeBase();
    const action = await runIncrementalAutosave({
      labels: b.labels,
      drained: { needsFullSnapshot: true, frames: [] },
      store,
      backupBase: async () => {
        throw new Error("copy failed");
      },
      writeBase: async () => {
        wrote = true;
      },
      hasBase: true,
      journalBytes: 0,
    });
    expect(action).toBe("full");
    expect(wrote).toBe(true); // write still happened despite backup throwing
  });
});

describe("replayJournal", () => {
  it("applies an appended journal onto a loaded base", async () => {
    const b = makeBase();
    const store = new InMemoryJournalStore();
    // Append a delta that empties frame 0.
    const idx = buildBaseIndex(b.labels);
    const delta = encodeFrameDelta(
      new LabeledFrame({ video: b.video, frameIdx: 0, instances: [] }),
      idx,
    );
    await store.appendRecords([frameDeltaToRecord(delta)]);

    await replayJournal(store, b.labels);
    expect(b.labels.find({ video: b.video, frameIdx: 0 })[0].instances.length).toBe(0);
  });

  it("is a no-op on an empty journal", async () => {
    const b = makeBase();
    const store = new InMemoryJournalStore();
    await replayJournal(store, b.labels);
    // Frame 0 untouched.
    expect(b.labels.find({ video: b.video, frameIdx: 0 })[0].instances.length).toBe(1);
  });
});
