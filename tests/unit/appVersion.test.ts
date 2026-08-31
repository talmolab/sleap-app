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
  classifyVersion,
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
