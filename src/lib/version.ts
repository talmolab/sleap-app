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
 * The three moving docs pointers deploy.yml publishes. Deliberately the same
 * three strings as appStore's `UpdateChannel`, so the desktop mapping is the
 * identity -- duplicated as a local type only to keep this module free of a
 * store import.
 */
export type DocsChannel = "stable" | "latest" | "dev";

/** A docs folder name: a moving pointer, or a permanent `v<tag>` folder. */
export type DocsVersion = DocsChannel | (string & {});

/** URL of a published docs folder. */
export function docsUrlFor(version: DocsVersion): string {
  return `${DOCS_BASE_URL}/${version}/`;
}

/**
 * Docs version for a WEB build, from the channel path it is served under
 * (Vite's BASE_URL, which deploy.yml sets per target as VITE_BASE_PATH).
 *
 * The app channel you are standing in decides the docs you get, so
 * app.sleap.ai/latest links to /docs/latest/ and app.sleap.ai/dev to
 * /docs/dev/. Two paths do not map to a like-named docs folder:
 *
 *   /main/   -> dev     there is no /docs/main/; /docs/dev/ IS main's docs,
 *                       rebuilt on the same push that rebuilds /main/.
 *   /v<pre>/ -> latest   pre-release tags get no permanent docs folder (they
 *                       carry the -N rebuild suffix), so they share /docs/latest/.
 *
 * A permanent stable tag path keeps its own pinned docs, which is the one case
 * where a frozen app build reads frozen docs: /v0.1.1/ -> /docs/v0.1.1/.
 */
export function docsVersionForBasePath(basePath: string): DocsVersion {
  const segment = basePath.replace(/^\/+/, "").replace(/\/+$/, "");
  if (segment === "" || segment === "stable") return "stable";
  if (segment === "main" || segment === "dev") return "dev";
  if (segment === "latest") return "latest";
  // Permanent per-release path. Plain tags have a docs folder of the same
  // name; a -N suffix marks a pre-release, which does not.
  if (/^v\d+\.\d+\.\d+$/.test(segment)) return segment;
  if (/^v\d+\.\d+\.\d+-\d+$/.test(segment)) return "latest";
  return "stable";
}

/**
 * The update channel a build belongs to, read off its own version string.
 *
 * Mirrors the detection in EnvironmentPanel's AppUpdateSection, which corrects
 * the store's hardcoded "stable" default on a fresh profile -- but that only
 * runs once the Environment panel has mounted, and a Help link has to be right
 * before the user has ever opened it.
 */
export function channelForVersion(version: string): DocsChannel {
  switch (classifyVersion(version)) {
    case "dev":
      return "dev";
    case "prerelease":
      // Pre-releases are what the "latest" channel ships.
      return "latest";
    case "stable":
      return "stable";
  }
}

/**
 * Docs version for a DESKTOP build. There is no base path to read -- the
 * bundle is served from the Tauri webview's own origin -- so the channel comes
 * from the update channel the app is actually on: whatever the Environment
 * panel shows, the Help link agrees with.
 *
 * An explicit choice always wins, matching how updateChannelExplicitlySet
 * gates auto-detection everywhere else. Until the user makes one, the running
 * build's own version decides, so a dev-channel install does not link to
 * stable docs just because nobody has touched the dropdown.
 */
export function docsVersionForDesktop(
  channel: DocsChannel,
  channelExplicitlySet: boolean,
  version: string,
): DocsVersion {
  return channelExplicitlySet ? channel : channelForVersion(version);
}
