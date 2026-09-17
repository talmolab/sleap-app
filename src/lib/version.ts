/**
 * The running app's version, and what KIND of build it is.
 *
 * `__APP_VERSION__` is injected by Vite from package.json (see vite.config.ts
 * `define`). CI stamps package.json immediately before Vite runs -- build.yml
 * from the release tag when bundling the desktop app, deploy.yml per web
 * target -- so this constant is the version of the thing the user is ACTUALLY
 * running, on the desktop shell and on every deployed web path alike. The
 * committed package.json value is only ever seen in local development, which
 * is why nothing should hardcode a version string instead of reading this.
 *
 * Under `bun test` there is no Vite `define` at all, so the reference is
 * guarded and falls back to "dev" (same guard as useWindowTitle used to carry
 * on its own).
 */
export const APP_VERSION =
  typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";

// Classifies a version from its own semver shape, so users who don't
// recognize semver conventions still see in plain text what kind of build
// they're on. Deliberately derived from the VERSION rather than from any
// selected update channel: the channel dropdown is a preference that can point
// somewhere other than what's installed (e.g. right after switching channels
// but before clicking Update/Switch), whereas this always describes the build
// that is actually running -- which is what an About box has to report.
//
// Dev builds are stamped `BASE+<count>.<short_sha>` by build-dev.yml (<count>
// being how far `main` has advanced past BASE's own tag, so it restarts at
// each new release), and web /main/ builds `BASE+main.<short_sha>` by
// deploy.yml (both build metadata); a `-` before any build metadata is a
// pre-release identifier (e.g. `0.1.2-2`); anything else is a plain tagged
// release.
export type VersionKind = "stable" | "prerelease" | "dev";

export function classifyVersion(version: string): VersionKind {
  if (version.includes("+")) return "dev";
  if (version.includes("-")) return "prerelease";
  return "stable";
}

export const VERSION_KIND_LABEL: Record<VersionKind, string> = {
  stable: "Stable release",
  prerelease: "Pre-release",
  dev: "Dev build",
};

/** Build kind of the version this bundle was compiled with. */
export const APP_VERSION_KIND: VersionKind = classifyVersion(APP_VERSION);

/** e.g. "Pre-release" -- the channel wording shown next to the version. */
export const APP_VERSION_KIND_LABEL = VERSION_KIND_LABEL[APP_VERSION_KIND];

/**
 * Base of the published documentation site. Absolute on purpose: the desktop
 * shell and `bun run dev` both serve the app from somewhere that is not
 * app.sleap.ai, so a root-relative "/docs/" would resolve to a local 404 in
 * exactly the two environments hardest to notice it in.
 */
export const DOCS_BASE_URL = "https://app.sleap.ai/docs";

/**
 * Which published docs version this build should link to.
 *
 * Docs are versioned on their OWN axis, independent of the app's channel paths
 * (/, /main/, /dev/, /latest/, /v<tag>/) -- see deploy.yml. The two only reuse
 * the words "latest" and "dev"; nothing nests one inside the other. The
 * mapping is derived from the running version so a frozen build never points
 * at docs describing features it does not have:
 *
 *   dev build      `0.1.2-2+main.abc1234`  -> /docs/dev/     (tracks main)
 *   pre-release    `0.1.2-2`               -> /docs/latest/  (moving)
 *   stable release `0.1.1`                 -> /docs/v0.1.1/  (pinned, permanent)
 *
 * Stable builds pin to their own permanent folder rather than to /docs/stable/,
 * which keeps a desktop 0.1.1 install reading 0.1.1 docs long after 0.2.0 has
 * moved /docs/stable/ on. Pre-releases are the one case that drifts: their tags
 * carry the -N rebuild suffix (v0.1.2-1, v0.1.2-2, ...) and deliberately get no
 * permanent docs folder, so they share the moving /docs/latest/ and a frozen
 * pre-release build's link follows it. /docs/stable/ still exists for humans --
 * it is what bare app.sleap.ai/docs redirects to, and a row in the version
 * dropdown -- it is just not what any build links to.
 */
export function docsUrlForVersion(version: string): string {
  switch (classifyVersion(version)) {
    case "dev":
      return `${DOCS_BASE_URL}/dev/`;
    case "prerelease":
      return `${DOCS_BASE_URL}/latest/`;
    case "stable":
      return `${DOCS_BASE_URL}/v${version}/`;
  }
}

/** Documentation URL matching the version this bundle was compiled with. */
export const DOCS_URL = docsUrlForVersion(APP_VERSION);
