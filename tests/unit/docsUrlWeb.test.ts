/**
 * Which docs URL a WEB build resolves to (@/lib/docsUrl).
 *
 * The mappings themselves are unit-tested in appVersion.test.ts; what matters
 * here is that the right INPUT is consulted -- reading the wrong one is the
 * actual bug this module exists to fix. The Help link used to be derived from
 * the build's version STRING, so a pre-release sent you to /docs/latest/ no
 * matter which channel path you were standing in.
 *
 * Desktop mode needs its own file: with `--isolate` each test file gets one
 * module registry, and bun's `mock.module` cannot be undone mid-file, so the
 * isTauri mock is per-file (same split as aboutDialogVersion{,Desktop}).
 */

import { describe, it, expect, vi } from "../bun-test";

vi.mock("@/lib/platform", () => ({
  isTauri: false,
  isMac: false,
  modKey: "Ctrl",
  altKey: "Alt",
}));

describe("getDocsUrl on the web (follows the channel path it is served under)", () => {
  it("derives the docs version from BASE_URL, not from the app version", async () => {
    const { docsUrlFor, docsVersionForBasePath } = await import("@/lib/version");
    const { getDocsUrl } = await import("@/lib/docsUrl");

    // Asserted as a relationship rather than a literal, so this does not depend
    // on whatever BASE_URL the test runner itself reports.
    const base = import.meta.env?.BASE_URL ?? "/";
    expect(getDocsUrl()).toBe(docsUrlFor(docsVersionForBasePath(base)));
  });

  it("maps every deployed channel path to the right docs URL", async () => {
    const { docsUrlFor, docsVersionForBasePath } = await import("@/lib/version");
    const cases: Array<[string, string]> = [
      ["/", "https://app.sleap.ai/docs/stable/"],
      ["/latest/", "https://app.sleap.ai/docs/latest/"],
      ["/dev/", "https://app.sleap.ai/docs/dev/"],
      // Its own folder, not /docs/dev/: /main/ rebuilds per commit while
      // /dev/ moves only with the nightly desktop dev build.
      ["/main/", "https://app.sleap.ai/docs/main/"],
      // Permanent stable tag: pinned docs of the same name.
      ["/v0.1.1/", "https://app.sleap.ai/docs/v0.1.1/"],
      // Permanent PRE-release tag: no pinned docs folder, shares the pointer.
      ["/v0.1.2-2/", "https://app.sleap.ai/docs/latest/"],
    ];
    for (const [basePath, expected] of cases) {
      expect(docsUrlFor(docsVersionForBasePath(basePath))).toBe(expected);
    }
  });
});
