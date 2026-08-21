/**
 * Unit tests for the desktop legacy-codec transcode fallback (pure logic +
 * orchestration with injected fakes). The real ffmpeg sidecar + Tauri fs are
 * covered by manual desktop E2E, not here.
 */

import { describe, it, expect } from "../bun-test";
import { buildTranscodeArgs } from "@/lib/transcode/transcodeArgs";
import {
  computeCacheKey,
  cacheFilename,
  planCacheEviction,
  type CacheEntry,
} from "@/lib/transcode/transcodeCache";
import {
  transcodeToMp4,
  ensureDecodablePath,
  parseFfmpegProgress,
  getTranscodeCacheInfo,
  clearTranscodeCache,
  __resetEncoderCache,
  type TranscodeDeps,
  type TranscodeProgress,
} from "@/lib/transcode/transcodeVideo";
import { codecNeedsTranscode } from "@/lib/transcode/videoCodecSupport";
import {
  parseFfprobeCodec,
  parseEncoderList,
  pickH264Encoder,
} from "@/lib/transcode/videoProbe";

describe("buildTranscodeArgs (frame-exact ffmpeg args)", () => {
  it("emits the correctness-critical + WebCodecs-compat flags", () => {
    const args = buildTranscodeArgs({ input: "/in.avi", output: "/out.mp4" });
    // frame-exact: no fps resampling, every source frame kept 1:1
    expect(args).toContain("-fps_mode");
    expect(args[args.indexOf("-fps_mode") + 1]).toBe("passthrough");
    // WebCodecs-decodable output
    expect(args[args.indexOf("-pix_fmt") + 1]).toBe("yuv420p");
    // no audio, single video stream
    expect(args).toContain("-an");
    expect(args[args.indexOf("-map") + 1]).toBe("0:v:0");
    // input before -i, output last
    expect(args[args.indexOf("-i") + 1]).toBe("/in.avi");
    expect(args[args.length - 1]).toBe("/out.mp4");
    // NEVER a forced output rate (-r), which would resample and break alignment
    expect(args).not.toContain("-r");
    // explicit muxer — the temp output uses a `.part` extension ffmpeg can't map
    expect(args[args.indexOf("-f") + 1]).toBe("mp4");
  });

  it("defaults to the permissive libopenh264 encoder, overridable", () => {
    expect(buildTranscodeArgs({ input: "a", output: "b" })[
      buildTranscodeArgs({ input: "a", output: "b" }).indexOf("-c:v") + 1
    ]).toBe("libopenh264");
    const x264 = buildTranscodeArgs({
      input: "a",
      output: "b",
      encoder: "libx264",
      quality: ["-crf", "18"],
    });
    expect(x264[x264.indexOf("-c:v") + 1]).toBe("libx264");
    expect(x264).toContain("-crf");
  });

  it("can omit progress output", () => {
    expect(
      buildTranscodeArgs({ input: "a", output: "b", progress: false })
    ).not.toContain("-progress");
  });
});

describe("transcodeCache (key + eviction)", () => {
  it("cache key is deterministic and self-invalidates on size/mtime change", () => {
    const a = computeCacheKey("/v.avi", 1000, 111);
    expect(computeCacheKey("/v.avi", 1000, 111)).toBe(a); // stable
    expect(computeCacheKey("/v.avi", 1001, 111)).not.toBe(a); // size changed
    expect(computeCacheKey("/v.avi", 1000, 222)).not.toBe(a); // mtime changed
    expect(computeCacheKey("/other.avi", 1000, 111)).not.toBe(a); // path changed
    expect(cacheFilename(a)).toBe(`${a}.mp4`);
  });

  it("plans LRU eviction: drops oldest until under the byte cap", () => {
    const entries: CacheEntry[] = [
      { path: "/a.mp4", sizeBytes: 100, atimeMs: 1 }, // oldest
      { path: "/b.mp4", sizeBytes: 100, atimeMs: 2 },
      { path: "/c.mp4", sizeBytes: 100, atimeMs: 3 }, // newest
    ];
    // total 300, cap 150 → must drop the two oldest (a, b) to reach 100
    expect(planCacheEviction(entries, 150)).toEqual(["/a.mp4", "/b.mp4"]);
    // within budget → nothing
    expect(planCacheEviction(entries, 300)).toEqual([]);
    // cap <= 0 disables eviction
    expect(planCacheEviction(entries, 0)).toEqual([]);
  });
});

describe("parseFfmpegProgress", () => {
  it("parses a full progress block terminated by progress=end", () => {
    const chunk = [
      "frame=250",
      "fps=550",
      "out_time_us=10000000",
      "progress=end",
    ].join("\n");
    const [p] = parseFfmpegProgress(chunk);
    expect(p.frame).toBe(250);
    expect(p.outTimeMs).toBe(10000);
    expect(p.done).toBe(true);
  });

  it("marks continue blocks as not done and handles a trailing partial", () => {
    const [a, b] = parseFfmpegProgress(
      "frame=10\nprogress=continue\nframe=20"
    );
    expect(a.done).toBe(false);
    expect(a.frame).toBe(10);
    expect(b.frame).toBe(20); // trailing partial (no terminator yet)
    expect(b.done).toBe(false);
  });
});

describe("codecNeedsTranscode", () => {
  it("passes through the WebCodecs codecs and MJPEG (no transcode)", () => {
    for (const c of ["h264", "hevc", "vp9", "av1", "mjpeg"]) {
      expect(codecNeedsTranscode(c)).toBe(false);
    }
  });
  it("flags legacy codecs for transcode", () => {
    for (const c of ["mpeg1video", "mpeg2video", "mpeg4", "msmpeg4v3", "wmv3", "vc1"]) {
      expect(codecNeedsTranscode(c)).toBe(true);
    }
  });
  it("flags 10-bit H.264/HEVC (WebCodecs can't decode high bit depth)", () => {
    expect(codecNeedsTranscode("hevc", "yuv420p10le")).toBe(true);
    expect(codecNeedsTranscode("h264", "yuv420p")).toBe(false);
  });
});

// ── Orchestration with injected fakes ────────────────────────────────────────
function makeFakeDeps(overrides: Partial<TranscodeDeps> = {}): {
  deps: TranscodeDeps;
  calls: { ran: string[][]; renamed: [string, string][]; removed: string[] };
  fs: Set<string>;
} {
  const fs = new Set<string>(); // paths that "exist"
  const calls = { ran: [] as string[][], renamed: [] as [string, string][], removed: [] as string[] };
  const deps: TranscodeDeps = {
    cacheDir: async () => "/cache",
    join: async (...parts) => parts.join("/"),
    stat: async () => ({ size: 1234, mtimeMs: 99 }),
    exists: async (p) => fs.has(p),
    mkdir: async () => {},
    rename: async (from, to) => {
      calls.renamed.push([from, to]);
      fs.delete(from);
      fs.add(to);
    },
    remove: async (p) => {
      calls.removed.push(p);
      fs.delete(p);
    },
    readDir: async () => [],
    exec: async (tool) => {
      // Default: ffprobe reports a legacy codec (needs transcode); ffmpeg has a
      // permissive encoder. Tests override as needed.
      if (tool === "ffprobe") {
        return {
          stdout: JSON.stringify({
            streams: [{ codec_name: "mpeg4", pix_fmt: "yuv420p" }],
          }),
          stderr: "",
          code: 0,
        };
      }
      return { stdout: " V....D libopenh264 x\n V....D libx264 x", stderr: "", code: 0 };
    },
    runTranscode: async (args) => {
      calls.ran.push(args);
      // simulate ffmpeg writing the temp output (last arg)
      fs.add(args[args.length - 1]);
    },
    ...overrides,
  };
  return { deps, calls, fs };
}

describe("transcodeToMp4 orchestration", () => {
  it("cache miss: transcodes to a .part temp then atomically renames into place", async () => {
    const { deps, calls } = makeFakeDeps();
    const out = await transcodeToMp4("/v.avi", deps);

    const key = computeCacheKey("/v.avi", 1234, 99);
    const expected = `/cache/transcodes/${key}.mp4`;
    expect(out).toBe(expected);
    expect(calls.ran).toHaveLength(1);
    // ffmpeg wrote to the .part temp, not the final path
    expect(calls.ran[0][calls.ran[0].length - 1]).toBe(`${expected}.part`);
    // atomic publish: temp → final
    expect(calls.renamed).toEqual([[`${expected}.part`, expected]]);
  });

  it("cache hit: returns immediately without running ffmpeg", async () => {
    const { deps, calls, fs } = makeFakeDeps();
    const key = computeCacheKey("/v.avi", 1234, 99);
    fs.add(`/cache/transcodes/${key}.mp4`); // pretend it's already cached
    const out = await transcodeToMp4("/v.avi", deps);
    expect(out).toBe(`/cache/transcodes/${key}.mp4`);
    expect(calls.ran).toHaveLength(0);
    expect(calls.renamed).toHaveLength(0);
  });

  it("on ffmpeg failure: removes the partial temp and rethrows (no rename)", async () => {
    const { deps, calls } = makeFakeDeps({
      runTranscode: async () => {
        throw new Error("boom");
      },
    });
    await expect(transcodeToMp4("/v.avi", deps)).rejects.toThrow("boom");
    expect(calls.renamed).toHaveLength(0);
    const key = computeCacheKey("/v.avi", 1234, 99);
    expect(calls.removed).toContain(`/cache/transcodes/${key}.mp4.part`);
  });

  it("forwards progress updates", async () => {
    const seen: TranscodeProgress[] = [];
    const { deps } = makeFakeDeps({
      runTranscode: async (_args, onProgress) => {
        onProgress({ frame: 5, done: false });
        onProgress({ frame: 10, done: true });
      },
    });
    await transcodeToMp4("/v.avi", deps, { onProgress: (p) => seen.push(p) });
    expect(seen).toEqual([
      { frame: 5, done: false },
      { frame: 10, done: true },
    ]);
  });

  it("concurrent cache-miss for the same source dedups and both resolve (no rename-race)", async () => {
    // Two opens of the SAME legacy file race (dev StrictMode double-invoke, or two
    // Videos referencing one file). Both miss the cache and try to publish the
    // same temp→final path; without dedup the first rename moves `.part`→`.mp4`
    // and the second rename then finds no `.part` and throws. A convert-once cache
    // MUST serialize/dedup concurrent misses so both callers get the one mp4.
    const { deps, calls, fs } = makeFakeDeps({
      // Realistic rename: errors when the source is gone — matches std::fs::rename
      // / Tauri plugin-fs ("No such file or directory (os error 2)"). The default
      // fake's rename never checked this, which is why the stampede slipped past.
      rename: async (from, to) => {
        if (!fs.has(from)) throw new Error(`No such file or directory: ${from}`);
        calls.renamed.push([from, to]);
        fs.delete(from);
        fs.add(to);
      },
    });
    const key = computeCacheKey("/v.avi", 1234, 99);
    const expected = `/cache/transcodes/${key}.mp4`;

    const [a, b] = await Promise.all([
      transcodeToMp4("/v.avi", deps),
      transcodeToMp4("/v.avi", deps),
    ]);

    expect(a).toBe(expected);
    expect(b).toBe(expected);
    // dedup: the same source is transcoded ONCE, not twice
    expect(calls.ran).toHaveLength(1);
  });

  it("rename failure is success when the final mp4 is already present (lost publish race)", async () => {
    // Belt-and-suspenders for any residual race that slips past the in-flight
    // dedup (e.g. a second app instance sharing the cache dir): our rename fails
    // because a racer already published `.mp4` and moved the `.part` — but the
    // result we wanted is on disk, so return it instead of throwing.
    const key = computeCacheKey("/v.avi", 1234, 99);
    const expected = `/cache/transcodes/${key}.mp4`;
    let published = false; // becomes true once "the racer" publishes the final mp4
    const { deps } = makeFakeDeps({
      exists: async (p) => p === expected && published, // absent at the top-check
      runTranscode: async () => {
        published = true; // a concurrent run publishes the final + consumes the temp
      },
      rename: async () => {
        throw new Error("No such file or directory");
      },
    });
    expect(await transcodeToMp4("/v.avi", deps)).toBe(expected);
  });
});

describe("videoProbe parsers + encoder selection", () => {
  it("parseFfprobeCodec: reads codec/pixfmt/duration, lowercases, or null", () => {
    expect(
      parseFfprobeCodec(
        JSON.stringify({
          streams: [{ codec_name: "MPEG4", pix_fmt: "YUV420P", duration: "0.4" }],
        })
      )
    ).toEqual({ codec: "mpeg4", pixFmt: "yuv420p", durationMs: 400 });
    // absent duration → durationMs undefined (caller shows indeterminate bar)
    expect(
      parseFfprobeCodec(JSON.stringify({ streams: [{ codec_name: "h264" }] }))
        ?.durationMs
    ).toBeUndefined();
    expect(parseFfprobeCodec(JSON.stringify({ streams: [] }))).toBeNull();
    expect(parseFfprobeCodec("not json")).toBeNull();
  });

  it("parseEncoderList: extracts video encoder names from -encoders output", () => {
    const stdout = [
      "Encoders:",
      " V....D libx264              libx264 H.264",
      " V....D h264_videotoolbox    VideoToolbox H.264",
      " A....D aac                  AAC (audio, ignored)",
    ].join("\n");
    const names = parseEncoderList(stdout);
    expect(names).toContain("libx264");
    expect(names).toContain("h264_videotoolbox");
    expect(names).not.toContain("aac"); // audio encoder filtered out
  });

  it("pickH264Encoder: prefers libopenh264, then videotoolbox, never libx264", () => {
    expect(pickH264Encoder(["libx264", "h264_videotoolbox", "libopenh264"])).toBe(
      "libopenh264"
    );
    // no libopenh264 (this machine's homebrew build) → the permissive hw encoder
    expect(pickH264Encoder(["libx264", "h264_videotoolbox"])).toBe(
      "h264_videotoolbox"
    );
    // only GPL libx264 available → refuse (would taint a bundled build)
    expect(() => pickH264Encoder(["libx264"])).toThrow(/libopenh264/);
  });
});

describe("ensureDecodablePath (probe → decide → maybe transcode)", () => {
  it("decodable codec → returns the original path, no transcode", async () => {
    __resetEncoderCache();
    const { deps, calls } = makeFakeDeps({
      exec: async (tool) =>
        tool === "ffprobe"
          ? {
              stdout: JSON.stringify({
                streams: [{ codec_name: "h264", pix_fmt: "yuv420p" }],
              }),
              stderr: "",
              code: 0,
            }
          : { stdout: "", stderr: "", code: 0 },
    });
    const res = await ensureDecodablePath("/v.avi", deps);
    expect(res).toEqual({ path: "/v.avi", transcoded: false, codec: "h264" });
    expect(calls.ran).toHaveLength(0);
  });

  it("legacy codec → transcodes with the selected permissive encoder", async () => {
    __resetEncoderCache();
    const { deps, calls } = makeFakeDeps(); // default: ffprobe→mpeg4, ffmpeg→libopenh264
    const res = await ensureDecodablePath("/v.avi", deps);
    expect(res.transcoded).toBe(true);
    expect(res.path.endsWith(".mp4")).toBe(true);
    expect(calls.ran).toHaveLength(1);
    // the chosen encoder is threaded into the ffmpeg args
    expect(calls.ran[0][calls.ran[0].indexOf("-c:v") + 1]).toBe("libopenh264");
  });

  it("unprobeable file → returns original unchanged (lets the normal backend try)", async () => {
    __resetEncoderCache();
    const { deps, calls } = makeFakeDeps({
      exec: async () => ({ stdout: "garbage", stderr: "", code: 1 }),
    });
    const res = await ensureDecodablePath("/weird.bin", deps);
    expect(res).toEqual({ path: "/weird.bin", transcoded: false });
    expect(calls.ran).toHaveLength(0);
  });
});

describe("transcode cache maintenance", () => {
  // Minimal fake keyed by filename→size; readDir lists names, stat returns sizes.
  function cacheDeps(files: Record<string, number>) {
    const present = new Set(Object.keys(files));
    const removed: string[] = [];
    const deps = {
      cacheDir: async () => "/cache",
      join: async (...p: string[]) => p.join("/"),
      stat: async (path: string) => ({
        size: files[path.split("/").pop() ?? ""] ?? 0,
        mtimeMs: 0,
      }),
      exists: async () => false,
      mkdir: async () => {},
      rename: async () => {},
      remove: async (p: string) => {
        removed.push(p);
        present.delete(p.split("/").pop() ?? "");
      },
      readDir: async () => [...present],
      exec: async () => ({ stdout: "", stderr: "", code: 0 }),
      runTranscode: async () => {},
    } as TranscodeDeps;
    return { deps, removed };
  }

  it("getTranscodeCacheInfo sums .mp4 sizes and ignores .part temps", async () => {
    const { deps } = cacheDeps({ "a.mp4": 100, "b.mp4": 200, "c.mp4.part": 999 });
    expect(await getTranscodeCacheInfo(deps)).toEqual({ count: 2, bytes: 300 });
  });

  it("getTranscodeCacheInfo is empty when the cache dir is absent", async () => {
    const { deps } = cacheDeps({});
    deps.readDir = async () => {
      throw new Error("ENOENT");
    };
    expect(await getTranscodeCacheInfo(deps)).toEqual({ count: 0, bytes: 0 });
  });

  it("clearTranscodeCache removes .mp4 + .part; count is .mp4 only, bytes are total", async () => {
    const { deps, removed } = cacheDeps({ "a.mp4": 100, "b.mp4.part": 50 });
    const freed = await clearTranscodeCache(deps);
    expect(freed).toEqual({ count: 1, bytes: 150 });
    expect(removed).toHaveLength(2); // both the finished mp4 and the stray .part
  });
});
