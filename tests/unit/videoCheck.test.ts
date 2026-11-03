import { describe, it, expect } from "../bun-test";
import {
  quickCheck,
  pickSeekSamples,
  runFrameCheck,
  frameCheckPassed,
  formatFrameRanges,
  reencodedPath,
  decideReencodeSwap,
  labelShiftWarning,
  displayOrder,
  keyframeGop,
  reencodeBitrate,
  reencodeCommand,
  nativeDecodeArgs,
  nativeDecodeClears,
  clearedResult,
  type FrameReader,
} from "@/lib/videoCheck";

/** Evenly spaced frame times at `fps`. */
function cfrTimes(n: number, fps = 30): number[] {
  return Array.from({ length: n }, (_, i) => i / fps);
}

/** A seeded LCG so sample picks are reproducible. */
function seeded(seed = 1): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 2 ** 32;
    return s / 2 ** 32;
  };
}

describe("quickCheck", () => {
  it("passes a constant-rate video", () => {
    expect(quickCheck({ kind: "mp4box", frameTimes: cfrTimes(300) })).toEqual({
      status: "ok",
      findings: [],
    });
  });

  it("skips embedded/image frames and passes .seq", () => {
    expect(quickCheck({ kind: "images", frameTimes: null }).status).toBe("skip");
    expect(quickCheck({ kind: "seq", frameTimes: null }).status).toBe("ok");
  });

  it("is unknown for a time-seeking reader with no frame times (AVI)", () => {
    const r = quickCheck({ kind: "avi", frameTimes: null });
    expect(r.status).toBe("unknown");
    expect(r.findings[0].code).toBe("time-seek");
  });

  it("is ok for a position reader with no frame times", () => {
    expect(quickCheck({ kind: "mp4box", frameTimes: null }).status).toBe("ok");
  });

  it("warns when frames are in decode order (B-frames through MediaBunny)", () => {
    // I P B B pattern: presentation times 0, 3, 1, 2, 6, 4, 5 …
    const times = [0, 3, 1, 2, 6, 4, 5].map((t) => t / 30);
    const r = quickCheck({ kind: "mediabunny", frameTimes: times });
    expect(r.status).toBe("warn");
    expect(r.findings.map((f) => f.code)).toContain("out-of-order");
  });

  it("judges frame spacing in display order, so B-frame order alone isn't a variable rate", () => {
    const times: number[] = [];
    for (let g = 0; g < 50; g++) times.push(...[0, 3, 1, 2].map((t) => (g * 4 + t) / 30));
    const r = quickCheck({ kind: "mediabunny", frameTimes: times });
    expect(r.findings.map((f) => f.code)).toEqual(["out-of-order"]);
  });

  it("warns on repeated timestamps", () => {
    const times = cfrTimes(10);
    times[5] = times[4];
    const r = quickCheck({ kind: "mp4box", frameTimes: times });
    expect(r.status).toBe("warn");
    expect(r.findings[0].code).toBe("duplicate-times");
  });

  it("flags a variable frame rate as warn only for time-mapped readers", () => {
    // Every 10th gap is doubled: 10% irregular, well over the threshold.
    const times: number[] = [0];
    for (let i = 1; i < 200; i++) times.push(times[i - 1] + (i % 10 === 0 ? 2 : 1) / 30);
    const avi = quickCheck({ kind: "media-element", frameTimes: times });
    expect(avi.status).toBe("warn");
    expect(avi.findings[0].code).toBe("variable-rate");
    const mp4 = quickCheck({ kind: "mp4box", frameTimes: times });
    expect(mp4.status).toBe("ok");
    expect(mp4.findings[0].severity).toBe("info");
  });

  it("tolerates an occasional dropped frame", () => {
    const times: number[] = [0];
    for (let i = 1; i < 1000; i++) times.push(times[i - 1] + (i === 500 ? 2 : 1) / 30);
    expect(quickCheck({ kind: "media-element", frameTimes: times })).toEqual({
      status: "ok",
      findings: [],
    });
  });
});

describe("pickSeekSamples", () => {
  it("returns distinct in-range frames including the last", () => {
    const s = pickSeekSamples(10_000, 20, seeded());
    expect(s.length).toBe(20);
    expect(new Set(s).size).toBe(20);
    expect(s).toContain(9_999);
    expect(s.every((i) => i >= 0 && i < 10_000)).toBe(true);
  });

  it("spreads samples across the video", () => {
    const s = [...pickSeekSamples(10_000, 20, seeded(7))].sort((a, b) => a - b);
    expect(s[0]).toBeLessThan(500);
    expect(s[s.length - 2]).toBeGreaterThan(9_000);
  });

  it("takes every frame of a short video", () => {
    expect([...pickSeekSamples(5, 20, seeded())].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });

  it("handles empty input", () => {
    expect(pickSeekSamples(0, 20)).toEqual([]);
    expect(pickSeekSamples(100, 0)).toEqual([]);
  });
});

/**
 * A fake reader: `bad` frames fail; in the seek phase (`opened > 1`),
 * `shifted` frames return their neighbour's pixels.
 */
function fakeReaders(opts: { count: number; bad?: number[]; shifted?: number[]; throwOn?: number[] }) {
  let opened = 0;
  const closed: number[] = [];
  const reads: Array<{ reader: number; index: number; fingerprint: boolean }> = [];
  const openReader = async (): Promise<FrameReader> => {
    const id = ++opened;
    return {
      frameCount: opts.count,
      async read(index, fingerprint) {
        reads.push({ reader: id, index, fingerprint });
        if (opts.throwOn?.includes(index)) throw new Error("decoder error");
        if (opts.bad?.includes(index)) return { ok: false };
        const shown = id > 1 && opts.shifted?.includes(index) ? index + 1 : index;
        return { ok: true, fingerprint: fingerprint ? `f${shown}` : undefined };
      },
      close() {
        closed.push(id);
      },
    };
  };
  return { openReader, reads, closed, opened: () => opened };
}

describe("runFrameCheck", () => {
  it("passes a clean video, using a fresh reader for the seek phase", async () => {
    const f = fakeReaders({ count: 200 });
    const r = await runFrameCheck({ openReader: f.openReader, sampleCount: 10, random: seeded() });
    expect(frameCheckPassed(r)).toBe(true);
    expect(r.frameCount).toBe(200);
    expect(r.seekTested).toBe(10);
    expect(f.opened()).toBe(2);
    expect(f.closed).toEqual([1, 2]);
    // In-order pass reads every frame once, fingerprinting only the samples.
    const firstPass = f.reads.filter((x) => x.reader === 1);
    expect(firstPass.map((x) => x.index)).toEqual(Array.from({ length: 200 }, (_, i) => i));
    expect(firstPass.filter((x) => x.fingerprint).length).toBe(10);
  });

  it("reports frames that fail or throw in order, and skips them in the seek phase", async () => {
    const f = fakeReaders({ count: 50, bad: [10, 11, 12], throwOn: [49] });
    const r = await runFrameCheck({ openReader: f.openReader, sampleCount: 50, random: seeded() });
    expect(r.unreadable).toEqual([10, 11, 12, 49]);
    expect(r.seekTested).toBe(46);
    expect(frameCheckPassed(r)).toBe(false);
  });

  it("reopens a reader that stays broken after a failure, so it doesn't fail every later frame", async () => {
    // Like the UI-thread MP4 reader: once frame 5 errors, it throws for everything after.
    let opened = 0;
    const openReader = async (): Promise<FrameReader> => {
      opened++;
      let broken = false;
      return {
        frameCount: 20,
        stuckAfterError: true,
        async read(index, fingerprint) {
          if (broken || index === 5) {
            broken = true;
            throw new Error("EncodingError");
          }
          return { ok: true, fingerprint: fingerprint ? `f${index}` : undefined };
        },
        close() {},
      };
    };
    const r = await runFrameCheck({ openReader, sampleCount: 20, random: seeded() });
    expect(r.unreadable).toEqual([5]);
    expect(r.seekUnreadable).toEqual([]);
    // Phase 1, the reopen after frame 5, and phase 2.
    expect(opened).toBe(3);
  });

  it("doesn't reopen a reader that recovers from errors by itself", async () => {
    const f = fakeReaders({ count: 30, bad: [4, 9, 14] });
    const r = await runFrameCheck({ openReader: f.openReader, sampleCount: 5, random: seeded() });
    expect(r.unreadable).toEqual([4, 9, 14]);
    expect(f.opened()).toBe(2); // one per phase
  });

  it("reports frames that show a different image when jumped to", async () => {
    const f = fakeReaders({ count: 20, shifted: [3, 17] });
    const r = await runFrameCheck({ openReader: f.openReader, sampleCount: 20, random: seeded() });
    expect(r.unreadable).toEqual([]);
    expect(r.seekMismatches).toEqual([3, 17]);
  });

  it("reports progress for both phases", async () => {
    const f = fakeReaders({ count: 60 });
    const seen: string[] = [];
    await runFrameCheck({
      openReader: f.openReader,
      sampleCount: 3,
      random: seeded(),
      onProgress: (p) => seen.push(`${p.phase}:${p.done}/${p.total}`),
    });
    expect(seen).toContain("read:60/60");
    expect(seen).toContain("seek:3/3");
  });

  it("stops and closes the reader when canceled", async () => {
    const f = fakeReaders({ count: 1000 });
    const controller = new AbortController();
    const run = runFrameCheck({
      openReader: f.openReader,
      signal: controller.signal,
      onProgress: (p) => {
        if (p.done > 100) controller.abort();
      },
    });
    let error: unknown = null;
    try {
      await run;
    } catch (err) {
      error = err;
    }
    expect((error as DOMException).name).toBe("AbortError");
    expect(f.closed).toEqual([1]);
  });
});

describe("formatFrameRanges", () => {
  it("compresses runs", () => {
    expect(formatFrameRanges([0, 1, 2, 5, 9, 10])).toBe("0–2, 5, 9–10");
  });

  it("truncates long lists", () => {
    expect(formatFrameRanges([1, 3, 5, 7, 9], 2)).toBe("1, 3, and 3 more");
  });
});

describe("reencodedPath", () => {
  it("swaps the extension for .reencoded.mp4 in the same folder", () => {
    expect(reencodedPath("/data/mouse.avi")).toBe("/data/mouse.reencoded.mp4");
    expect(reencodedPath("C:\\data\\run.1.mov")).toBe("C:\\data\\run.1.reencoded.mp4");
  });

  it("handles names without an extension or with a dotted folder", () => {
    expect(reencodedPath("/data.v2/clip")).toBe("/data.v2/clip.reencoded.mp4");
    expect(reencodedPath("/data/.hidden")).toBe("/data/.hidden.reencoded.mp4");
  });
});

describe("decideReencodeSwap", () => {
  it("swaps when the frame count matches", () => {
    expect(decideReencodeSwap({ oldCount: 100, newCount: 100, labeledCount: 5 })).toEqual({
      ok: true,
      note: null,
    });
  });

  it("swaps with a note when counts differ but nothing is labeled", () => {
    const d = decideReencodeSwap({ oldCount: 100, newCount: 98, labeledCount: 0 });
    expect(d.ok).toBe(true);
    expect(d.ok && d.note).toContain("98 frames");
  });

  it("swaps an original that never opened, warning only when it has labels", () => {
    expect(decideReencodeSwap({ oldCount: null, newCount: 98, labeledCount: 0 })).toEqual({
      ok: true,
      note: null,
    });
    const d = decideReencodeSwap({ oldCount: null, newCount: 98, labeledCount: 2 });
    expect(d.ok && d.note).toContain("couldn't be compared");
  });

  it("refuses when counts differ and the video has labels", () => {
    const d = decideReencodeSwap({ oldCount: 100, newCount: 98, labeledCount: 3 });
    expect(d.ok).toBe(false);
    expect(!d.ok && d.reason).toContain("3 labeled frames");
  });
});

describe("labelShiftWarning", () => {
  it("warns only for a labeled video that showed problems", () => {
    expect(labelShiftWarning(0, true)).toBeNull();
    expect(labelShiftWarning(4, false)).toBeNull();
    expect(labelShiftWarning(4, true)).toContain("4 labeled frames");
  });
});

describe("displayOrder", () => {
  it("sorts frame numbers by timestamp", () => {
    expect(displayOrder(5, [0, 3, 1, 2, 4])).toEqual([0, 2, 3, 1, 4]);
  });

  it("keeps the order when times are in order, missing, or the wrong length", () => {
    expect(displayOrder(3, [0, 1, 2])).toEqual([0, 1, 2]);
    expect(displayOrder(3, null)).toEqual([0, 1, 2]);
    expect(displayOrder(3, [0, 1])).toEqual([0, 1, 2]);
  });

  it("breaks timestamp ties by frame number", () => {
    expect(displayOrder(3, [1, 0, 1])).toEqual([1, 0, 2]);
  });
});

describe("re-encode defaults (match sio reencode)", () => {
  it("puts a keyframe every second", () => {
    expect(keyframeGop(30)).toBe(30);
    expect(keyframeGop(100)).toBe(100);
    expect(keyframeGop(14.99)).toBe(15);
    expect(keyframeGop(0.4)).toBe(1);
  });

  it("assumes 30 fps when the frame rate is unknown", () => {
    expect(keyframeGop(undefined)).toBe(30);
    expect(keyframeGop(0)).toBe(30);
  });

  it("uses mediabunny's bitrate rule: 3 Mbps at 1080p medium, scaled by preset and size", () => {
    expect(reencodeBitrate("medium", 1920, 1080)).toBe(3_000_000);
    expect(reencodeBitrate("high", 1920, 1080)).toBe(6_000_000);
    expect(reencodeBitrate("low", 1920, 1080)).toBe(1_800_000);
    const small = reencodeBitrate("medium", 1024, 1024);
    expect(small).toBeGreaterThan(1_000_000);
    expect(small).toBeLessThan(3_000_000);
  });

  it("builds sio's libx264 command for each preset", () => {
    const cmd = reencodeCommand("a.avi", "a.reencoded.mp4", 25, "medium");
    expect(cmd).toContain("-crf 25");
    expect(cmd).toContain("-g 25");
    expect(cmd).toContain("-bf 0");
    expect(cmd).toContain('"a.reencoded.mp4"');
    expect(reencodeCommand("a", "b", 25, "high")).toContain("-crf 18");
    expect(reencodeCommand("a", "b", 25, "low")).toContain("-crf 32");
  });
});

describe("desktop native first pass", () => {
  it("decodes every frame to nowhere, with progress and errors only", () => {
    const args = nativeDecodeArgs("/v.mp4");
    expect(args.slice(0, 4)).toEqual(["-v", "error", "-i", "/v.mp4"]);
    expect(args).toContain("passthrough");
    expect(args.slice(-3)).toEqual(["-f", "null", "-"]);
  });

  it("clears an MP4 only when ffmpeg decoded every frame the app sees, with no errors", () => {
    expect(nativeDecodeClears("mp4box", 100, { decoded: 100, errors: [] })).toBe(true);
    expect(nativeDecodeClears("mp4box", 100, { decoded: 96, errors: [] })).toBe(false);
    expect(nativeDecodeClears("mp4box", 100, { decoded: 100, errors: ["Invalid NAL unit size"] })).toBe(false);
  });

  it("never clears a reader that finds frames by time", () => {
    for (const kind of ["mediabunny", "avi", "media-element", null] as const) {
      expect(nativeDecodeClears(kind, 100, { decoded: 100, errors: [] })).toBe(false);
    }
  });

  it("reports a cleared video as fully read with no jumps tested", () => {
    expect(clearedResult(2560)).toEqual({
      frameCount: 2560,
      unreadable: [],
      seekTested: 0,
      seekMismatches: [],
      seekUnreadable: [],
    });
  });
});

