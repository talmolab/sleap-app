/**
 * The range of sleap-nn versions this build of the app installs.
 *
 * The app's train, predict and track flows have not been tried against
 * sleap-nn 0.4 yet, so every install and update it runs stays below 0.4. Raise
 * the cap here, in one place, once they have.
 */

import type { UvTool } from "@/platform/backend";

/** The first sleap-nn version the app does not install. */
export const SLEAP_NN_VERSION_CAP = "0.4";

/** The PEP 440 specifier appended to every sleap-nn install requirement. */
export const SLEAP_NN_VERSION_SPECIFIER = `<${SLEAP_NN_VERSION_CAP}`;

/**
 * The requirement handed to `uv tool install`, for example
 * `sleap-nn[torch-cpu,export]<0.4`.
 *
 * `uv` records the specifier with the tool, so a later `uv tool upgrade` also
 * stays below the cap.
 */
export function sleapNnInstallSpec(extras: readonly string[]): string {
  const extrasPart = extras.length > 0 ? `[${extras.join(",")}]` : "";
  return `sleap-nn${extrasPart}${SLEAP_NN_VERSION_SPECIFIER}`;
}

/** `[major, minor]` of a version such as `0.4.0`, `0.4.0rc1` or `v0.3.5`. */
function majorMinor(version: string): [number, number] {
  const [major = "0", minor = "0"] = version.trim().replace(/^v/i, "").split(".");
  return [parseInt(major, 10) || 0, parseInt(minor, 10) || 0];
}

/**
 * Whether `version` is below the cap, so the app would install it. A
 * pre-release of the capped version (`0.4.0rc1`) is at the cap, as it is for
 * the `<0.4` specifier.
 */
export function isSleapNnVersionBelowCap(version: string): boolean {
  const [major, minor] = majorMinor(version);
  const [capMajor, capMinor] = majorMinor(SLEAP_NN_VERSION_CAP);
  return major < capMajor || (major === capMajor && minor < capMinor);
}

/**
 * Hide a sleap-nn update the app would not install.
 *
 * `uv tool list --outdated` reports the newest release on the index and takes
 * no account of the version range recorded with the tool. When an update is
 * flagged and that release is at or above the cap, whether a newer version
 * below the cap exists is not known, so the update state becomes unknown
 * (`null`): the Update button stays usable and nothing announces a version the
 * app won't install.
 *
 * Everything else passes through unchanged: other tools, an update below the
 * cap, and a tool that is up to date. That includes a sleap-nn that is already
 * at or above the cap and up to date, which must keep reading as up to date so
 * that Update is not offered for it (see `doUpgradeTool`).
 */
export function capSleapNnUpdate(tool: UvTool): UvTool {
  if (tool.name !== "sleap-nn") return tool;
  if (tool.updateAvailable !== true || !tool.latestVersion) return tool;
  if (isSleapNnVersionBelowCap(tool.latestVersion)) return tool;
  return { ...tool, updateAvailable: null, latestVersion: null };
}

/** The extras the app manages besides the torch one, as install extras. */
export function exportExtras(installed: {
  onnx: boolean;
  tensorrt: boolean;
}): string[] {
  // TensorRT export is built on the ONNX toolchain, so it brings `export`.
  const wantOnnx = installed.onnx || installed.tensorrt;
  return [
    ...(wantOnnx ? ["export"] : []),
    ...(installed.tensorrt ? ["tensorrt"] : []),
  ];
}
