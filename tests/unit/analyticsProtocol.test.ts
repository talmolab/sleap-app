/**
 * The analytics wire protocol (lib/analytics/protocol.ts): what a value is
 * reduced to before it can leave the machine.
 *
 * The scrubbing tests are the privacy contract. Every string in them that
 * looks like a path, a filename, a URL or an address is one a real error
 * message could contain, and none of it may survive.
 */
import { describe, it, expect } from "../bun-test";
import {
  LIMITS,
  MAX_MESSAGE,
  bucket,
  buildLegacyPing,
  errorFingerprint,
  isValidEventName,
  legacyPlatform,
  sanitizeProps,
  scrubText,
  summarizeStack,
} from "@/lib/analytics/protocol";

describe("scrubText", () => {
  const cases: [string, string][] = [
    // POSIX paths
    ["ENOENT: no such file, open '/Users/jane/lab/mouse_17/session.slp'", "ENOENT: no such file, open '<path>'"],
    ["Failed to read /home/jdoe/data/fly.mp4: permission denied", "Failed to read <path> permission denied"],
    ["could not open ~/Documents/experiment 3/labels.slp", "could not open <path>"],
    // Windows paths
    ["Cannot open C:\\Users\\Jane Doe\\videos\\clip.avi", "Cannot open <path>"],
    ["Cannot open D:/data/run1/video.mp4 (locked)", "Cannot open <path> (locked)"],
    ["share \\\\labserver\\raw\\cohort2\\a.mp4 unreachable", "share <path> unreachable"],
    // URLs of every scheme the app handles
    ["GET https://storage.example.org/bucket/secret-study/v.mp4?sig=abc failed", "GET <url> failed"],
    ["fetch file:///Users/jane/a.slp", "fetch <url>"],
    ["blob:http://localhost:5173/1b2c-3d4e revoked", "<url> revoked"],
    ["asset://localhost/%2FUsers%2Fjane%2Fa.mp4 404", "<url> 404"],
    // Paths with spaces, quoted and unquoted: the tail carries the name
    ["open \"C:\\Users\\Jane Mary Doe\\My Videos\\a b.mp4\" failed", "open \"<path>\" failed"],
    ["open /Volumes/Lab NAS/Jane Doe/raw data/a.avi failed", "open <path> failed"],
    ["read C:\\Users\\Jane Mary Doe\\clip.avi failed", "read <path> failed"],
    // Bare filenames
    ["Video mouse_cohort2_day3.mp4 has no frames", "Video <file> has no frames"],
    ["labels.v003.pkg.slp is format 3.0", "<file> is format 3.0"],
    ["Wrote predictions.h5 and config.yaml", "Wrote <file> and <file>"],
    // Email
    ["contact jane.doe@university.edu for access", "contact <email> for access"],
  ];

  for (const [input, expected] of cases) {
    it(`scrubs: ${input.slice(0, 48)}`, () => {
      expect(scrubText(input)).toBe(expected);
    });
  }

  it("never lets a path separator, home directory or user name through", () => {
    const messages = [
      "open '/Users/jane/lab/mouse_17/session.slp' failed",
      "C:\\Users\\jane\\Desktop\\study\\a.mp4 not found",
      "read /Volumes/LabNAS/jane/raw/a.avi",
      "https://jane:pw@host.example/private/a.slp",
      "open C:\\Users\\Mary jane\\Desktop\\a.mp4",
      "open /Users/mary jane/Desktop/a.mp4",
    ];
    for (const message of messages) {
      const out = scrubText(message);
      expect(out).not.toContain("jane");
      expect(out).not.toMatch(/Users|Volumes|Desktop|host\.example/);
    }
  });

  it("leaves an ordinary message alone", () => {
    expect(scrubText("Cannot read properties of undefined (reading 'nodes')")).toBe(
      "Cannot read properties of undefined (reading 'nodes')",
    );
    expect(scrubText("Frame 120/300 out of range")).toBe("Frame 120/300 out of range");
  });

  it("collapses whitespace and caps the length", () => {
    expect(scrubText("a\n\n  b\tc")).toBe("a b c");
    const long = scrubText("x".repeat(5000));
    expect(long.length).toBe(MAX_MESSAGE);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("errorFingerprint", () => {
  it("is the same for one failure on two different files and frames", () => {
    const a = errorFingerprint("uncaught", "Frame 12 of /Users/a/one.mp4 failed to decode");
    const b = errorFingerprint("uncaught", "Frame 9041 of C:\\data\\two.mp4 failed to decode");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });

  it("differs between different errors and between kinds", () => {
    const base = errorFingerprint("uncaught", "x is not a function");
    expect(errorFingerprint("uncaught", "y is not a function")).not.toBe(base);
    expect(errorFingerprint("render", "x is not a function")).not.toBe(base);
  });
});

describe("summarizeStack", () => {
  it("keeps function, bundle file and position, and drops the origin and directories", () => {
    const v8 = [
      "TypeError: x is not a function",
      "    at loadProject (https://app.sleap.ai/latest/assets/index-BxK2a9.js:412:1877)",
      "    at async https://app.sleap.ai/latest/assets/index-BxK2a9.js:98:12",
      "    at Object.execute (http://localhost:49231/assets/commands-D3f.js:7:3301)",
    ].join("\n");
    expect(summarizeStack(v8)).toBe(
      "loadProject@index-BxK2a9.js:412:1877 < @index-BxK2a9.js:98:12 < Object.execute@commands-D3f.js:7:3301",
    );
  });

  it("reads JavaScriptCore / Firefox frames too", () => {
    const jsc = "decode@tauri://localhost/assets/video-9a.js:3:150\n@tauri://localhost/assets/index-1.js:1:9";
    expect(summarizeStack(jsc)).toBe("decode@video-9a.js:3:150 < @index-1.js:1:9");
  });

  it("contains no host, scheme or local path", () => {
    const stack = "    at f (file:///Users/jane/dev/sleap-app/src/lib/thing.ts:10:2)";
    const out = summarizeStack(stack);
    expect(out).toBe("f@thing.ts:10:2");
    expect(out).not.toMatch(/jane|Users|file:/);
  });

  it("is empty for a missing or frameless stack", () => {
    expect(summarizeStack(undefined)).toBe("");
    expect(summarizeStack("Error: no frames here")).toBe("");
  });

  it("stops after the top frames", () => {
    const many = Array.from({ length: 30 }, (_, i) => `    at f${i} (https://h/a.js:${i}:1)`).join("\n");
    expect(summarizeStack(many).split(" < ")).toHaveLength(4);
  });
});

describe("sanitizeProps", () => {
  it("keeps scalars and drops everything the service would drop", () => {
    expect(
      sanitizeProps({
        text: "ok",
        n: 3,
        ratio: 0.5,
        flag: false,
        nothing: null,
        missing: undefined,
        list: [1, 2],
        nested: { a: 1 },
        infinite: Number.POSITIVE_INFINITY,
        notANumber: Number.NaN,
        "bad key": 1,
        "path/like": 1,
        "9leading": 1,
        "m:file.save": 2,
      }),
    ).toEqual({ text: "ok", n: 3, ratio: 0.5, flag: false, nothing: null, "m:file.save": 2 });
  });

  it("truncates long strings to the service's limit", () => {
    expect((sanitizeProps({ s: "x".repeat(9999) }).s as string).length).toBe(LIMITS.maxString);
  });

  it("keeps at most maxKeys entries", () => {
    const many = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(sanitizeProps(many))).toHaveLength(LIMITS.maxPropsKeys);
    expect(Object.keys(sanitizeProps(many, 5))).toHaveLength(5);
  });

  it("is empty for nothing", () => {
    expect(sanitizeProps(undefined)).toEqual({});
    expect(sanitizeProps(null)).toEqual({});
  });
});

describe("event names", () => {
  it("accepts catalog-style names and rejects anything else", () => {
    for (const ok of ["session_start", "usage", "a.b_c1"]) expect(isValidEventName(ok)).toBe(true);
    for (const bad of ["", "Has Space", "UPPER", "1st", "a/b", "x".repeat(65)]) {
      expect(isValidEventName(bad)).toBe(false);
    }
  });
});

describe("bucket", () => {
  it("reports sizes as ranges, never exact counts", () => {
    expect([0, 1, 2, 5, 6, 20, 21, 100, 101, 500, 501, 2000, 2001, 10000, 10001].map(bucket)).toEqual([
      "0", "1", "2-5", "2-5", "6-20", "6-20", "21-100", "21-100", "101-500", "101-500",
      "501-2k", "501-2k", "2k-10k", "2k-10k", "10k+",
    ]);
    expect(bucket(null)).toBe("0");
    expect(bucket(Number.NaN)).toBe("0");
    expect(bucket(-4)).toBe("0");
  });
});

describe("the legacy /ping", () => {
  // These mirror talmolab/sleap-analytics-service: CLIENT_REPORTED_FIELDS in
  // app/routers.py (the absent-field tripwire) and REQUIRED_BY_DESIGN in
  // app/schemas.py. If that service's lists change, so must this.
  const WATCHED_BY_THE_SERVICE = ["sleap_version", "python_version", "tf_version", "conda_env", "platform"];

  const ping = buildLegacyPing({ version: "0.2.0", pythonVersion: "3.12.4", platform: "macOS-14.5-arm64" });

  it("sends every field the service watches for, as a string", () => {
    expect(Object.keys(ping).sort()).toEqual([...WATCHED_BY_THE_SERVICE].sort());
    for (const key of WATCHED_BY_THE_SERVICE) {
      expect(typeof (ping as unknown as Record<string, unknown>)[key]).toBe("string");
    }
  });

  it("marks the row as this app, out of reach of the SLEAP version chart", () => {
    expect(ping.sleap_version).toBe("sleap-app/0.2.0");
    // The dashboard extracts ^\d+\.\d+ for version adoption; a prefixed value
    // must not match, or app 0.2 would be charted as an old SLEAP release.
    expect(/^(\d+\.\d+)/.test(ping.sleap_version)).toBe(false);
  });

  it("does not count toward conda installs or claim a TensorFlow version", () => {
    expect(ping.conda_env).toBe("");
    expect(ping.tf_version).toBe("N/A");
  });

  it("falls back to N/A when no Python environment is installed", () => {
    expect(buildLegacyPing({ version: "0.2.0", platform: "Linux" }).python_version).toBe("N/A");
    expect(buildLegacyPing({ version: "0.2.0", pythonVersion: null, platform: "" }).platform).toBe("unknown");
  });
});

describe("legacyPlatform", () => {
  // The reporting repo (check_stats.py) classifies the OS by substring and
  // reads the major version with ^(Windows|macOS)-(\d+).
  it("leads with the family name the reporting repo matches on", () => {
    expect(legacyPlatform({ os: "macos", osVersion: "14.5", arch: "arm64" })).toBe("macOS-14.5-arm64");
    expect(legacyPlatform({ os: "windows", osVersion: "11", arch: "x86_64" })).toBe("Windows-11-x86_64");
    expect(legacyPlatform({ os: "linux", osVersion: "ubuntu-22.04", arch: "x86_64" })).toBe(
      "Linux-ubuntu-22.04-x86_64",
    );
  });

  it("omits what is unknown rather than inventing it", () => {
    expect(legacyPlatform({ os: "macos" })).toBe("macOS");
    expect(legacyPlatform({ os: "windows", osVersion: null, arch: "x86_64" })).toBe("Windows-x86_64");
    expect(legacyPlatform({ os: "" })).toBe("unknown");
  });

  it("matches the reporting repo's major-version pattern", () => {
    const major = /^(Windows|macOS)-(\d+)/;
    expect(major.exec(legacyPlatform({ os: "macos", osVersion: "14.5", arch: "arm64" }))?.[2]).toBe("14");
    expect(major.exec(legacyPlatform({ os: "windows", osVersion: "11", arch: "x86_64" }))?.[2]).toBe("11");
  });
});
