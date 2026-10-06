/**
 * Tests for @/lib/version -- the single source of the running build's version
 * and channel wording, shared by the window title, the About dialog and the
 * web menu-bar wordmark.
 *
 * The point of the module is that no UI hardcodes a version, so these tests
 * assert the DERIVATION rather than any literal: under `bun test` there is no
 * Vite `define`, so APP_VERSION is the "dev" fallback.
 */

import { describe, it, expect } from "../bun-test";
import {
  APP_VERSION,
  APP_VERSION_KIND,
  APP_VERSION_KIND_LABEL,
  channelForVersion,
  classifyVersion,
  DOCS_BASE_URL,
  docsUrlFor,
  docsVersionForBasePath,
  docsVersionForDesktop,
  VERSION_KIND_LABEL,
} from "@/lib/version";

describe("classifyVersion (build shapes CI actually produces)", () => {
  it("treats a plain release tag as stable", () => {
    expect(classifyVersion("0.1.2")).toBe("stable");
  });

  it("treats a numeric pre-release tag as a pre-release", () => {
    // What `gh release create v0.1.2-2 --prerelease` yields once build.yml
    // strips the leading "v".
    expect(classifyVersion("0.1.2-2")).toBe("prerelease");
  });

  it("treats a dev-channel build as a dev build", () => {
    // build-dev.yml stamps BASE+<run_number>.<short_sha>.
    expect(classifyVersion("0.1.2-1+9.c1949e7")).toBe("dev");
  });

  it("treats a web /main/ build as a dev build", () => {
    // deploy.yml stamps <highest-tag>+main.<short_sha> for app.sleap.ai/main/,
    // which has no desktop counterpart to be a release of.
    expect(classifyVersion("0.1.2-2+main.5cff4f5")).toBe("dev");
  });

  it("lets build metadata win over a pre-release identifier", () => {
    // A dev build off a pre-release base has BOTH markers; it is still a dev
    // build, which is why the "+" test comes first.
    expect(classifyVersion("0.1.2-2+9.abc1234")).toBe("dev");
  });
});

describe("channel wording", () => {
  it("labels every kind in plain language", () => {
    expect(VERSION_KIND_LABEL.stable).toBe("Stable release");
    expect(VERSION_KIND_LABEL.prerelease).toBe("Pre-release");
    expect(VERSION_KIND_LABEL.dev).toBe("Dev build");
  });

  it("derives the running build's label from its own version", () => {
    expect(APP_VERSION_KIND).toBe(classifyVersion(APP_VERSION));
    expect(APP_VERSION_KIND_LABEL).toBe(VERSION_KIND_LABEL[APP_VERSION_KIND]);
  });
});

describe("APP_VERSION", () => {
  it("is a non-empty string even without Vite's define", () => {
    // Guarded reference: `bun test` has no `define`, so this is "dev" here and
    // the CI-stamped version in every real build.
    expect(typeof APP_VERSION).toBe("string");
    expect(APP_VERSION.length).toBeGreaterThan(0);
  });
});

describe("docsVersionForBasePath (web: the channel path you are standing in)", () => {
  it("maps each app channel path to the like-named docs pointer", () => {
    expect(docsVersionForBasePath("/latest/")).toBe("latest");
    expect(docsVersionForBasePath("/dev/")).toBe("dev");
    expect(docsVersionForBasePath("/main/")).toBe("main");
    expect(docsVersionForBasePath("/")).toBe("stable");
  });

  it("keeps /main/ and /dev/ on separate docs folders", () => {
    // Both document `main`, but on different cadences -- deploy.yml writes
    // /docs/main/ on every push and /docs/dev/ only with the nightly desktop
    // dev build -- so sharing one folder would make it lag one of the two.
    expect(docsVersionForBasePath("/main/")).toBe("main");
    expect(docsVersionForBasePath("/dev/")).toBe("dev");
  });

  it("pins a permanent stable release path to its own docs folder", () => {
    expect(docsVersionForBasePath("/v0.1.1/")).toBe("v0.1.1");
    expect(docsVersionForBasePath("/v0.2.0/")).toBe("v0.2.0");
  });

  it("sends a permanent PRE-release path to /docs/latest/", () => {
    // The -N suffix marks a pre-release, and those get no permanent docs
    // folder to pin to (deploy.yml), so they share the moving pointer.
    expect(docsVersionForBasePath("/v0.1.2-1/")).toBe("latest");
    expect(docsVersionForBasePath("/v0.1.2-2/")).toBe("latest");
  });

  it("tolerates missing or unusual slashes and unknown paths", () => {
    expect(docsVersionForBasePath("latest")).toBe("latest");
    expect(docsVersionForBasePath("/latest")).toBe("latest");
    expect(docsVersionForBasePath("")).toBe("stable");
    expect(docsVersionForBasePath("/stable/")).toBe("stable");
    expect(docsVersionForBasePath("/something-else/")).toBe("stable");
  });
});

describe("docsVersionForDesktop (desktop: the update channel you are on)", () => {
  it("follows an explicitly chosen channel, whatever is installed", () => {
    // The whole point: pick Dev in the Environment panel and Help goes to
    // /docs/dev/, even though the running build is still a stable tag.
    expect(docsVersionForDesktop("dev", true, "0.1.1")).toBe("dev");
    expect(docsVersionForDesktop("latest", true, "0.1.1")).toBe("latest");
    expect(docsVersionForDesktop("stable", true, "0.1.2-2+9.abc1234")).toBe("stable");
  });

  it("falls back to the running build's own channel before any choice", () => {
    // updateChannel is hardcoded "stable" on a fresh profile and only corrected
    // once the Environment panel mounts, so the Help link cannot trust it yet.
    expect(docsVersionForDesktop("stable", false, "0.1.2-2+9.abc1234")).toBe("dev");
    expect(docsVersionForDesktop("stable", false, "0.1.2-2")).toBe("latest");
    expect(docsVersionForDesktop("stable", false, "0.1.1")).toBe("stable");
  });
});

describe("channelForVersion", () => {
  it("reads the channel off a version's own shape", () => {
    expect(channelForVersion("0.1.1")).toBe("stable");
    expect(channelForVersion("0.1.2-2")).toBe("latest");
    expect(channelForVersion("0.1.2-2+main.5cff4f5")).toBe("dev");
  });

  it("agrees with classifyVersion, differing only in what it calls a pre-release", () => {
    // classifyVersion describes the BUILD ("prerelease"); this names the
    // CHANNEL that ships it ("latest").
    expect(classifyVersion("0.1.2-2")).toBe("prerelease");
    expect(channelForVersion("0.1.2-2")).toBe("latest");
  });
});

describe("docsUrlFor", () => {
  it("builds an absolute URL under the docs base", () => {
    // Absolute so it resolves from the Tauri webview and `bun run dev`, where
    // a root-relative "/docs/" would 404 locally.
    expect(DOCS_BASE_URL).toBe("https://app.sleap.ai/docs");
    expect(docsUrlFor("dev")).toBe("https://app.sleap.ai/docs/dev/");
    expect(docsUrlFor("v0.1.1")).toBe("https://app.sleap.ai/docs/v0.1.1/");
  });

  it("never nests a docs version under an app channel path", () => {
    // The two version axes are siblings under app.sleap.ai and only reuse the
    // words "latest"/"dev" -- /latest/docs/ would mean two different things.
    for (const v of ["stable", "latest", "dev", "v0.1.1"] as const) {
      const url = docsUrlFor(v);
      expect(url.startsWith("https://app.sleap.ai/docs/")).toBe(true);
      expect(url.slice("https://app.sleap.ai/docs/".length)).not.toContain("/docs");
    }
  });
});
