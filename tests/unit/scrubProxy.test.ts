/**
 * Unit tests for the scrub-proxy orchestration (temp → frame-exact gate →
 * atomic publish, with a convert-once cache + concurrent-miss dedup). All
 * platform I/O is injected via a fake {@link TranscodeDeps} (mirrors
 * transcode.test.ts); the real ffmpeg/ffprobe sidecars are covered by manual
 * desktop E2E, not here.
 *
 * The CORRECTNESS invariant under test: a proxy is published ONLY when its
 * decodable frame count matches the source exactly. On any mismatch (or an
 * unknown count) the build is discarded and the caller falls back to the
 * ORIGINAL path, so a proxy can never misalign SLEAP labels (which key off
 * frame index) with the frames on screen.
 */

import { beforeEach, describe, expect, it } from "../bun-test";
import {
  computeCacheKey,
  proxyCacheFilename,
} from "@/lib/transcode/transcodeCache";
import {
  __resetEncoderCache,
  type TranscodeDeps,
} from "@/lib/transcode/transcodeVideo";
import {
  ensureScrubProxyPath,
  PROXY_GOP,
  PROXY_SUBDIR,
} from "@/lib/transcode/scrubProxy";

const SOURCE = "/v.mp4";
// Matches the fake stat() below, so the tests can recompute the exact cache path.
const KEY = computeCacheKey(SOURCE, 1234, 99);
const CACHE_PATH = `/cache/${PROXY_SUBDIR}/${proxyCacheFilename(KEY, PROXY_GOP)}`;
const TEMP_PATH = `${CACHE_PATH}.part`;

/**
 * An `exec` fake whose ONLY ffprobe use is frame counting: route on tool,
 * return `libopenh264` for the encoder probe, and canned `nb_read_frames` JSON
 * per file so `probeFrameCount` yields the count `countFor(path)` returns
 * (`null` → empty `streams`, which parses back to `null`).
 */
function frameExec(
  countFor: (path: string) => number | null
): TranscodeDeps["exec"] {
  return async (tool, args) => {
    if (tool === "ffmpeg") {
      return { stdout: " V....D libopenh264 x", stderr: "", code: 0 };
    }
    const path = args[args.length - 1];
    const n = countFor(path);
    const stdout =
      n == null
        ? JSON.stringify({ streams: [] })
        : JSON.stringify({ streams: [{ nb_read_frames: n }] });
    return { stdout, stderr: "", code: 0 };
  };
}

// ── Fake deps (mirrors transcode.test.ts) ────────────────────────────────────
function makeFakeDeps(overrides: Partial<TranscodeDeps> = {}): {
  deps: TranscodeDeps;
  calls: {
    ran: string[][];
    renamed: [string, string][];
    removed: string[];
    probed: string[];
  };
  fs: Set<string>;
} {
  const fs = new Set<string>(); // paths that "exist"
  const calls = {
    ran: [] as string[][],
    renamed: [] as [string, string][],
    removed: [] as string[],
    probed: [] as string[],
  };
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
    // Default: encoder probe → libopenh264; frame counts match (source == proxy).
    exec: async (tool, args) => {
      if (tool === "ffmpeg") {
        return { stdout: " V....D libopenh264 x", stderr: "", code: 0 };
      }
      calls.probed.push(args[args.length - 1]);
      return {
        stdout: JSON.stringify({ streams: [{ nb_read_frames: 100 }] }),
        stderr: "",
        code: 0,
      };
    },
    runTranscode: async (args) => {
      calls.ran.push(args);
      fs.add(args[args.length - 1]); // simulate ffmpeg writing the temp output
    },
    ...overrides,
  };
  return { deps, calls, fs };
}

describe("ensureScrubProxyPath", () => {
  beforeEach(() => {
    // selectEncoder memoizes module-globally; reset so each test drives its own
    // fake exec deterministically.
    __resetEncoderCache();
  });

  it("cache hit: returns the cached proxy immediately (no transcode, no frame probe)", async () => {
    const { deps, calls, fs } = makeFakeDeps();
    fs.add(CACHE_PATH); // pretend the proxy was published earlier

    const res = await ensureScrubProxyPath(SOURCE, deps);

    expect(res).toEqual({ path: CACHE_PATH, isProxy: true });
    expect(calls.ran).toHaveLength(0); // no ffmpeg
    expect(calls.probed).toHaveLength(0); // a cached proxy already passed the gate
    expect(calls.renamed).toHaveLength(0);
  });

  it("cache miss, frame counts EQUAL: transcodes with the short GOP, gate passes, publishes", async () => {
    const { deps, calls } = makeFakeDeps(); // default exec: matching counts

    const res = await ensureScrubProxyPath(SOURCE, deps);

    expect(res).toEqual({ path: CACHE_PATH, isProxy: true });
    // one build, into the `.part` temp, with the short-GOP proxy profile
    expect(calls.ran).toHaveLength(1);
    expect(calls.ran[0][calls.ran[0].indexOf("-g") + 1]).toBe(String(PROXY_GOP));
    expect(calls.ran[0][calls.ran[0].length - 1]).toBe(TEMP_PATH);
    // frame-exact gate probed BOTH the source and the freshly built proxy temp
    expect(calls.probed).toContain(SOURCE);
    expect(calls.probed).toContain(TEMP_PATH);
    // atomic publish: temp → final
    expect(calls.renamed).toEqual([[TEMP_PATH, CACHE_PATH]]);
  });

  it("cache miss, frame counts DIFFER: discards the temp, falls back to the original (no publish)", async () => {
    const { deps, calls } = makeFakeDeps({
      // source = 100 frames, proxy temp = 99 → mismatch
      exec: frameExec((p) => (p.endsWith(".part") ? 99 : 100)),
    });

    const res = await ensureScrubProxyPath(SOURCE, deps);

    expect(res).toEqual({ path: SOURCE, isProxy: false });
    expect(calls.ran).toHaveLength(1); // it did build...
    expect(calls.removed).toContain(TEMP_PATH); // ...but threw the temp away
    expect(calls.renamed).toHaveLength(0); // nothing published
  });

  it("cache miss, a frame probe returns null: same fallback as a mismatch (never risk misalignment)", async () => {
    const { deps, calls } = makeFakeDeps({
      // proxy temp probe is unknown (null) → cannot verify → fall back
      exec: frameExec((p) => (p.endsWith(".part") ? null : 100)),
    });

    const res = await ensureScrubProxyPath(SOURCE, deps);

    expect(res).toEqual({ path: SOURCE, isProxy: false });
    expect(calls.removed).toContain(TEMP_PATH);
    expect(calls.renamed).toHaveLength(0);
  });

  it("runTranscode throws: removes the partial temp, propagates the error, publishes nothing", async () => {
    const { deps, calls } = makeFakeDeps({
      runTranscode: async () => {
        throw new Error("boom");
      },
    });

    await expect(ensureScrubProxyPath(SOURCE, deps)).rejects.toThrow("boom");

    expect(calls.removed).toContain(TEMP_PATH);
    expect(calls.renamed).toHaveLength(0);
    expect(calls.probed).toHaveLength(0); // no frame check after a failed build
  });

  it("concurrent cache-miss dedups: builds once, both callers share the published proxy", async () => {
    const { deps, calls } = makeFakeDeps();

    const [a, b] = await Promise.all([
      ensureScrubProxyPath(SOURCE, deps),
      ensureScrubProxyPath(SOURCE, deps),
    ]);

    expect(a).toEqual({ path: CACHE_PATH, isProxy: true });
    expect(b).toEqual(a);
    expect(calls.ran).toHaveLength(1); // the same source is built exactly once
    expect(calls.renamed).toEqual([[TEMP_PATH, CACHE_PATH]]);
  });

  it("publish-rename failure is success when the proxy is already present (lost race)", async () => {
    // Belt-and-suspenders for a race that slips past the in-flight dedup (e.g. a
    // second app instance sharing the cache dir): our rename fails because a racer
    // already published the proxy and moved our `.part` — but the result we wanted
    // is on disk, so return it instead of throwing. Mirrors the legacy transcode path.
    let published = false; // becomes true once "the racer" publishes the proxy
    const { deps } = makeFakeDeps({
      exists: async (p) => p === CACHE_PATH && published, // absent at the top-check
      runTranscode: async () => {
        published = true; // a concurrent run publishes the final + consumes the temp
      },
      rename: async () => {
        throw new Error("No such file or directory");
      },
    });

    expect(await ensureScrubProxyPath(SOURCE, deps)).toEqual({
      path: CACHE_PATH,
      isProxy: true,
    });
  });
});
