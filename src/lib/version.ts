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
// Dev builds are stamped `BASE+<run_number>.<short_sha>` by build-dev.yml, and
// web /main/ builds `BASE+main.<short_sha>` by deploy.yml (both build
// metadata); a `-` before any build metadata is a pre-release identifier (e.g.
// `0.1.2-2`); anything else is a plain tagged release.
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
