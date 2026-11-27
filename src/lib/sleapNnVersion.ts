/**
 * The range of sleap-nn versions this build of the app installs, plus PEP 440
 * version comparison and uv install argument helpers.
 *
 * This release targets sleap-nn 0.4 (`>=0.4.0a0,<0.5`) alongside sleap-io
 * `>=0.10.0a0,<0.11.0` for native SLP 3.0, DARK refinement, and `bbox_detr`.
 */

import type { UvTool } from "@/platform/backend";

/** The first sleap-nn 0.4 release the app targets (pre-release inclusive). */
export const SLEAP_NN_VERSION_FLOOR = "0.4.0a0";

/** The first sleap-nn version the app does not install. */
export const SLEAP_NN_VERSION_CAP = "0.5";

/** The PEP 440 specifier appended to every sleap-nn install requirement. */
export const SLEAP_NN_VERSION_SPECIFIER = `>=${SLEAP_NN_VERSION_FLOOR},<${SLEAP_NN_VERSION_CAP}`;

/**
 * Companion `sleap-io` constraint passed via `--with` to `uv tool install`.
 *
 * Kept as bare `sleap-io` (NEVER `sleap-io[pyav]`) so sleap-nn's own PEP 508
 * environment marker excluding `pyav` on macOS <= 13 arm64 stays intact.
 */
export const SLEAP_IO_WITH_SPEC = "sleap-io>=0.10.0a0,<0.11.0";

/** Python version range required by sleap-nn 0.4 (`>=3.11,<3.14`). */
export const SLEAP_NN_PYTHON_SPEC = ">=3.11,<3.14";

/**
 * The requirement handed to `uv tool install`, for example
 * `sleap-nn[torch-cpu,export]>=0.4.0a0,<0.5`.
 *
 * `uv` records the specifier with the tool, so a later `uv tool upgrade` also
 * stays within the supported range.
 */
export function sleapNnInstallSpec(extras: readonly string[]): string {
  const extrasPart = extras.length > 0 ? `[${extras.join(",")}]` : "";
  return `sleap-nn${extrasPart}${SLEAP_NN_VERSION_SPECIFIER}`;
}

/**
 * Extra CLI flags handed to `uv tool install` for sleap-nn.
 *
 * Always includes `--torch-backend=auto` and `--with sleap-io>=0.10.0a0,<0.11.0`
 * so `uv` resolves the matching pre-release `sleap-io` without enabling global
 * `--prerelease=allow`.
 */
export function sleapNnUvExtraArgs(prefixArgs: readonly string[] = []): string[] {
  return [
    ...prefixArgs,
    "--torch-backend=auto",
    "--with",
    SLEAP_IO_WITH_SPEC,
  ];
}

/** Parsed PEP 440 version for ordering comparisons. */
export interface ParsedPep440Version {
  release: number[];
  /**
   * Pre/final/post rank:
   * -1 = dev, 0 = a/alpha, 1 = b/beta, 2 = rc/c, 3 = final, 4 = post.
   */
  stage: number;
  stageNum: number;
  /** Optional `.devN` trailing a pre/post tag (lower than non-dev at same stage). */
  devNum: number | null;
}

const PEP440_RE =
  /^v?(\d+(?:\.\d+)*)(?:[._-]?(a|alpha|b|beta|rc|c)(\d*))?(?:[._-]?post(\d*))?(?:[._-]?dev(\d*))?(?:\+[A-Za-z0-9._-]+)?$/i;

/**
 * Parse a PEP 440 version string such as `0.4.0a0`, `0.4.0rc1`, `0.3.5`,
 * `v0.4.0`, or `0.4.0.dev1`. Returns `null` for unparseable strings.
 */
export function parseSleapNnVersion(
  version: string | null | undefined
): ParsedPep440Version | null {
  if (!version) return null;
  const trimmed = version.trim();
  const m = PEP440_RE.exec(trimmed);
  if (!m) return null;
  const release = m[1].split(".").map((n) => parseInt(n, 10));
  if (release.some((n) => !Number.isFinite(n))) return null;

  const preTag = m[2]?.toLowerCase();
  const preNum = m[3] ? parseInt(m[3], 10) : 0;
  const hasPost = m[4] !== undefined;
  const postNum = m[4] ? parseInt(m[4], 10) : 0;
  const hasDev = m[5] !== undefined;
  const devNum = m[5] ? parseInt(m[5], 10) : 0;

  let stage = 3; // final
  let stageNum = 0;
  if (preTag) {
    stage = preTag === "a" || preTag === "alpha" ? 0 : preTag === "b" || preTag === "beta" ? 1 : 2;
    stageNum = preNum;
  } else if (hasPost) {
    stage = 4;
    stageNum = postNum;
  } else if (hasDev) {
    stage = -1;
    stageNum = devNum;
  }

  return {
    release,
    stage,
    stageNum,
    devNum: hasDev && stage !== -1 ? devNum : null,
  };
}

/**
 * Compare two PEP 440 version strings (`-1`, `0`, `1`), or `null` if either
 * string cannot be parsed.
 *
 * Follows PEP 440 ordering: `0.3.5 < 0.4.0.dev0 < 0.4.0a0 < 0.4.0a1 < 0.4.0b0 < 0.4.0rc1 < 0.4.0 < 0.4.0.post1`.
 */
export function comparePep440Versions(
  a: string | null | undefined,
  b: string | null | undefined
): number | null {
  const pa = parseSleapNnVersion(a);
  const pb = parseSleapNnVersion(b);
  if (!pa || !pb) return null;

  const len = Math.max(pa.release.length, pb.release.length);
  for (let i = 0; i < len; i++) {
    const ai = pa.release[i] ?? 0;
    const bi = pb.release[i] ?? 0;
    if (ai !== bi) return ai < bi ? -1 : 1;
  }
  if (pa.stage !== pb.stage) return pa.stage < pb.stage ? -1 : 1;
  if (pa.stageNum !== pb.stageNum) return pa.stageNum < pb.stageNum ? -1 : 1;

  // A `.devN` on the same pre/post stage sorts before the non-dev release.
  if (pa.devNum !== pb.devNum) {
    if (pa.devNum !== null && pb.devNum === null) return -1;
    if (pa.devNum === null && pb.devNum !== null) return 1;
    return (pa.devNum ?? 0) < (pb.devNum ?? 0) ? -1 : 1;
  }
  return 0;
}

/** `[major, minor]` of a version such as `0.4.0`, `0.4.0a0` or `v0.3.5`. */
function majorMinor(version: string): [number, number] {
  const [major = "0", minor = "0"] = version.trim().replace(/^v/i, "").split(".");
  return [parseInt(major, 10) || 0, parseInt(minor, 10) || 0];
}

/**
 * Whether `version` is below the cap, so the app would install it. A
 * pre-release of the capped version (`0.5.0a0`) is at the cap, as it is for
 * the `<0.5` specifier.
 */
export function isSleapNnVersionBelowCap(version: string): boolean {
  const [major, minor] = majorMinor(version);
  const [capMajor, capMinor] = majorMinor(SLEAP_NN_VERSION_CAP);
  return major < capMajor || (major === capMajor && minor < capMinor);
}

/**
 * Whether `version` is below the supported 0.4 floor (`< 0.4.0a0`, e.g. `0.3.5`).
 */
export function isSleapNnVersionBelowFloor(version: string | null | undefined): boolean {
  const cmp = comparePep440Versions(version, SLEAP_NN_VERSION_FLOOR);
  return cmp !== null && cmp < 0;
}

/**
 * Resolve the installed `sleap-nn` version from environment store state,
 * preferring the `uv tool` entry (the actual managed runtime) and falling
 * back to `pythonCheck` (manually inspected interpreter).
 */
export function installedSleapNnVersion(env: {
  tools?: readonly UvTool[];
  pythonCheck?: { sleapNnVersion?: string | null } | null;
}): string | null {
  const uvVersion = env.tools?.find((t) => t.name === "sleap-nn")?.version ?? null;
  return uvVersion ?? env.pythonCheck?.sleapNnVersion ?? null;
}

/**
 * Whether the given installed `sleap-nn` version supports SLP 3.0 natively
 * (`>= 0.4.0a0`, via `sleap-io >= 0.10.0a0` and `node_loss_mask: true`).
 *
 * Returns `false` when the version is unknown so callers stay conservative
 * (falling back to the 2.x job copy when unsure).
 */
export function sleapNnSupportsSlp3(version: string | null | undefined): boolean {
  const cmp = comparePep440Versions(version, SLEAP_NN_VERSION_FLOOR);
  return cmp !== null && cmp >= 0;
}

/**
 * Whether a Python version string (e.g. `"3.12.7"`, `"3.10.14"`, `"3.14.0"`)
 * satisfies sleap-nn 0.4's `>=3.11,<3.14` requirement.
 */
export function isPythonVersionCompatible(version: string | null | undefined): boolean {
  if (!version) return false;
  const parsed = parseSleapNnVersion(version);
  if (!parsed || parsed.release.length < 2) return false;
  const [major, minor] = parsed.release;
  return major === 3 && minor >= 11 && minor < 14;
}

/**
 * Adjust sleap-nn update metadata against this app's supported floor & cap:
 *
 * 1. **Floor (`< 0.4.0a0`):** `uv tool list --outdated` ignores pre-releases for
 *    stable installs like `0.3.5`, leaving `updateAvailable: false` and disabling
 *    the Update button. Force `updateAvailable: true` (targeting `0.4.0a0` when
 *    no newer in-range version was reported) so `0.3.5` users can upgrade in one
 *    click.
 * 2. **Cap (`>= 0.5`):** `uv tool list --outdated` reports the newest release on
 *    the index without consulting the tool's specifier. Hide any release at or
 *    above the cap (`updateAvailable: null`, `latestVersion: null`).
 *
 * Everything else passes through unchanged, including an up-to-date sleap-nn
 * already at or above the cap (which must keep reading as up to date so Update
 * is never offered to downgrade it).
 */
export function capSleapNnUpdate(tool: UvTool): UvTool {
  if (tool.name !== "sleap-nn") return tool;

  if (tool.version && isSleapNnVersionBelowFloor(tool.version)) {
    if (
      tool.updateAvailable === true &&
      tool.latestVersion &&
      isSleapNnVersionBelowCap(tool.latestVersion) &&
      !isSleapNnVersionBelowFloor(tool.latestVersion)
    ) {
      return tool;
    }
    return {
      ...tool,
      updateAvailable: true,
      latestVersion: SLEAP_NN_VERSION_FLOOR,
    };
  }

  if (tool.updateAvailable !== true || !tool.latestVersion) return tool;
  if (isSleapNnVersionBelowCap(tool.latestVersion)) return tool;
  return { ...tool, updateAvailable: null, latestVersion: null };
}

/** The extras the app manages besides the torch one, as install extras. */
export function exportExtras(installed: {
  onnx: boolean;
  tensorrt: boolean;
  backbones?: boolean;
}): string[] {
  // TensorRT export is built on the ONNX toolchain, so it brings `export`.
  const wantOnnx = installed.onnx || installed.tensorrt;
  return [
    ...(wantOnnx ? ["export"] : []),
    ...(installed.tensorrt ? ["tensorrt"] : []),
    ...(installed.backbones ? ["backbones"] : []),
  ];
}
