/**
 * The range of sleap-nn versions this build of the app installs, channel
 * selection (`stable` vs `prerelease`), PEP 440 version comparison, PyPI
 * release filtering, and uv install argument helpers.
 *
 * - `stable`: full releases `<0.5` (currently 0.3.x, or 0.4.0+ once final ships).
 * - `prerelease`: pre-releases and full releases `>=0.4.0a0,<0.5` alongside
 *   `sleap-io>=0.10.0a0,<0.11.0` for native SLP 3.0, DARK refinement, and `bbox_detr`.
 */

import type { PyPiPackageVersions, UvTool } from "@/platform/backend";

/** Release channel for the managed `sleap-nn` uv tool. */
export type SleapNnChannel = "stable" | "prerelease";

/** Default sleap-nn channel on this build before the user picks one explicitly. */
export const DEFAULT_SLEAP_NN_CHANNEL: SleapNnChannel = "prerelease";

/** The first sleap-nn 0.4 release the app targets (pre-release inclusive). */
export const SLEAP_NN_VERSION_FLOOR = "0.4.0a0";

/** The first sleap-nn version the app does not install. */
export const SLEAP_NN_VERSION_CAP = "0.5";

/** The PEP 440 specifier for the stable sleap-nn channel (`<0.5`). */
export const SLEAP_NN_STABLE_SPECIFIER = `<${SLEAP_NN_VERSION_CAP}`;

/** The PEP 440 specifier for the pre-release sleap-nn channel (`>=0.4.0a0,<0.5`). */
export const SLEAP_NN_VERSION_SPECIFIER = `>=${SLEAP_NN_VERSION_FLOOR},<${SLEAP_NN_VERSION_CAP}`;

/** The first sleap-io 0.10 pre-release compatible with SLP 3.0. */
export const SLEAP_IO_VERSION_FLOOR = "0.10.0a0";

/** The first sleap-io version sleap-nn 0.4 does not accept. */
export const SLEAP_IO_VERSION_CAP = "0.11";

/** The first sleap-io version sleap-nn 0.3.x does not accept. */
export const SLEAP_IO_LEGACY_CAP = "0.10";

/**
 * Companion `sleap-io` constraint passed via `--with` to `uv tool install` on
 * the pre-release channel.
 *
 * Kept as bare `sleap-io` (NEVER `sleap-io[pyav]`) so sleap-nn's own PEP 508
 * environment marker excluding `pyav` on macOS <= 13 arm64 stays intact.
 */
export const SLEAP_IO_WITH_SPEC = `sleap-io>=${SLEAP_IO_VERSION_FLOOR},<0.11.0`;

/** Python version range required by sleap-nn 0.3.5+ and 0.4 (`>=3.11,<3.14`). */
export const SLEAP_NN_PYTHON_SPEC = ">=3.11,<3.14";

/** PEP 440 version specifier for the chosen sleap-nn channel. */
export function sleapNnVersionSpecifier(
  channel: SleapNnChannel = DEFAULT_SLEAP_NN_CHANNEL
): string {
  return channel === "stable"
    ? SLEAP_NN_STABLE_SPECIFIER
    : SLEAP_NN_VERSION_SPECIFIER;
}

/**
 * The requirement handed to `uv tool install`, for example
 * `sleap-nn[torch-cpu]>=0.4.0a0,<0.5` (pre-release channel) or
 * `sleap-nn[torch-cpu]<0.5` (stable channel).
 *
 * `uv` records the specifier with the tool, so a later `uv tool upgrade` also
 * stays within the supported range.
 */
export function sleapNnInstallSpec(
  extras: readonly string[],
  channel: SleapNnChannel = DEFAULT_SLEAP_NN_CHANNEL
): string {
  const extrasPart = extras.length > 0 ? `[${extras.join(",")}]` : "";
  return `sleap-nn${extrasPart}${sleapNnVersionSpecifier(channel)}`;
}

/**
 * Extra CLI flags handed to `uv tool install` for sleap-nn.
 *
 * Always includes `--torch-backend=auto`. On the `prerelease` channel it also
 * passes `--with sleap-io>=0.10.0a0,<0.11.0` so `uv` resolves the matching
 * pre-release `sleap-io` without enabling global `--prerelease=allow`. On the
 * `stable` channel `--with` is omitted so `sleap-nn` resolves its own stable
 * `sleap-io` dependency.
 */
export function sleapNnUvExtraArgs(
  prefixArgs: readonly string[] = [],
  channel: SleapNnChannel = DEFAULT_SLEAP_NN_CHANNEL
): string[] {
  if (channel === "stable") {
    return [...prefixArgs, "--torch-backend=auto"];
  }
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

/**
 * Whether `version` is a PEP 440 pre-release or dev release (e.g. `0.4.0a0`,
 * `0.4.0rc1`, `0.10.0a0`, `0.4.0.dev0`).
 *
 * Derived strictly from the version string — never from a selected channel —
 * so badges always describe what is actually installed.
 */
export function isPep440Prerelease(version: string | null | undefined): boolean {
  const parsed = parseSleapNnVersion(version);
  if (!parsed) return false;
  return parsed.stage < 3 || parsed.devNum !== null;
}

/** `[major, minor]` of a version such as `0.4.0`, `0.4.0a0` or `v0.3.5`. */
function majorMinor(version: string): [number, number] {
  const [major = "0", minor = "0"] = version.trim().replace(/^v/i, "").split(".");
  return [parseInt(major, 10) || 0, parseInt(minor, 10) || 0];
}

/** Whether `version` is strictly below `cap` (`major.minor`, pre-releases included). */
function isVersionBelowCap(version: string, cap: string): boolean {
  const [major, minor] = majorMinor(version);
  const [capMajor, capMinor] = majorMinor(cap);
  return major < capMajor || (major === capMajor && minor < capMinor);
}

/**
 * Whether `version` is below the cap, so the app would install it. A
 * pre-release of the capped version (`0.5.0a0`) is at the cap, as it is for
 * the `<0.5` specifier.
 */
export function isSleapNnVersionBelowCap(version: string): boolean {
  return isVersionBelowCap(version, SLEAP_NN_VERSION_CAP);
}

/**
 * Whether `version` is below the supported 0.4 floor (`< 0.4.0a0`, e.g. `0.3.5`).
 */
export function isSleapNnVersionBelowFloor(version: string | null | undefined): boolean {
  const cmp = comparePep440Versions(version, SLEAP_NN_VERSION_FLOOR);
  return cmp !== null && cmp < 0;
}

/** Pick the highest PEP 440 version from `versions` matching `predicate`. */
function pickMaxVersion(
  versions: readonly string[],
  predicate: (v: string) => boolean
): string | null {
  let best: string | null = null;
  for (const raw of versions) {
    const v = raw.trim().replace(/^v/i, "");
    if (!parseSleapNnVersion(v) || !predicate(v)) continue;
    if (best === null || (comparePep440Versions(v, best) ?? 0) > 0) {
      best = v;
    }
  }
  return best;
}

/**
 * Pick the newest installable `sleap-nn` version from PyPI for `channel`:
 * - `stable`: newest non-prerelease strictly below `0.5` (e.g. `0.3.5`, or `0.4.0` once released).
 * - `prerelease`: newest version (pre-release or final) strictly below `0.5`
 *   (e.g. `0.4.0a0`, `0.4.0a1`, `0.4.0rc0`, `0.4.0`).
 */
export function pickLatestSleapNnVersion(
  versions: readonly string[],
  channel: SleapNnChannel
): string | null {
  return pickMaxVersion(versions, (v) => {
    if (!isSleapNnVersionBelowCap(v)) return false;
    if (channel === "stable" && isPep440Prerelease(v)) return false;
    return true;
  });
}

/**
 * Pick the newest compatible `sleap-io` version from PyPI for `channel` and
 * the target/installed `sleap-nn` line:
 * - For `sleap-nn >= 0.4.0a0` (or `prerelease` channel): `< 0.11` (allowing
 *   pre-releases on `prerelease`, stable-only on `stable`).
 * - For `sleap-nn < 0.4.0a0` on `stable` (e.g. `0.3.5`, which requires
 *   `sleap-io < 0.10`): stable-only `< 0.10`.
 */
export function pickLatestSleapIoVersion(
  versions: readonly string[],
  channel: SleapNnChannel,
  sleapNnVersion?: string | null
): string | null {
  const allow010 =
    channel === "prerelease" ||
    (sleapNnVersion != null && sleapNnSupportsSlp3(sleapNnVersion));
  const cap = allow010 ? SLEAP_IO_VERSION_CAP : SLEAP_IO_LEGACY_CAP;
  return pickMaxVersion(versions, (v) => {
    if (!isVersionBelowCap(v, cap)) return false;
    if (channel === "stable" && isPep440Prerelease(v)) return false;
    return true;
  });
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
 * Adjust sleap-nn update metadata against the active channel's supported floor
 * & cap (fallback when PyPI version lists aren't available):
 *
 * - **`prerelease` channel:**
 *   1. Floor (`< 0.4.0a0`): `uv tool list --outdated` ignores pre-releases for
 *      stable installs like `0.3.5`, leaving `updateAvailable: false`. Force
 *      `updateAvailable: true` targeting `0.4.0a0` when no newer in-range
 *      version was reported.
 *   2. Cap (`>= 0.5`): hide any release at or above the cap.
 * - **`stable` channel:**
 *   - Hide pre-releases and any release at or above `0.5`; do NOT force `0.3.x`
 *     onto `0.4.0a0`.
 *
 * Everything else passes through unchanged, including an up-to-date sleap-nn
 * already at or above the cap (which must keep reading as up to date so Update
 * is never offered to downgrade it).
 */
export function capSleapNnUpdate(
  tool: UvTool,
  channel: SleapNnChannel = DEFAULT_SLEAP_NN_CHANNEL
): UvTool {
  if (tool.name !== "sleap-nn") return tool;

  if (channel === "stable") {
    if (tool.updateAvailable !== true || !tool.latestVersion) return tool;
    if (
      isSleapNnVersionBelowCap(tool.latestVersion) &&
      !isPep440Prerelease(tool.latestVersion)
    ) {
      return tool;
    }
    return { ...tool, updateAvailable: null, latestVersion: null };
  }

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

/**
 * Reconcile a `uv tool list` entry for `sleap-nn` against `channel` and
 * optional PyPI release metadata.
 *
 * `updateAvailable` is ONLY `true` for genuine upgrades (newer version on the
 * chosen channel, strictly below `0.5`) — never for channel downgrades (such
 * as `0.4.0a0` when switching to `stable`, where the newest stable is `0.3.5`),
 * so startup toasts and ambient badges never nag about downgrades.
 */
export function reconcileSleapNnTool(
  tool: UvTool,
  channel: SleapNnChannel = DEFAULT_SLEAP_NN_CHANNEL,
  pypi?: Pick<PyPiPackageVersions, "sleapNn"> | null
): UvTool {
  if (tool.name !== "sleap-nn") return tool;

  const target =
    pypi && pypi.sleapNn.length > 0
      ? pickLatestSleapNnVersion(pypi.sleapNn, channel)
      : null;

  if (!target || !tool.version) {
    return capSleapNnUpdate(tool, channel);
  }

  // Never offer to move an env that is already at or above the <0.5 cap.
  if (!isSleapNnVersionBelowCap(tool.version)) {
    return capSleapNnUpdate(tool, channel);
  }

  const cmp = comparePep440Versions(tool.version, target);
  if (cmp === null) return capSleapNnUpdate(tool, channel);

  if (cmp < 0) {
    return {
      ...tool,
      updateAvailable: true,
      latestVersion: target,
    };
  }

  // Up to date (cmp === 0) OR installed is newer than the selected channel's
  // target (cmp > 0, handled as a deliberate channel Switch in the panel — not
  // an ambient update).
  return {
    ...tool,
    updateAvailable: false,
    latestVersion: tool.version,
  };
}

/** Full Environment-panel view of sleap-nn + bundled sleap-io status for a channel. */
export interface SleapNnStatusView {
  /** Target sleap-nn version that Install / Update / Switch would land on this channel. */
  targetVersion: string | null;
  /** Target sleap-io version for this channel / sleap-nn line. */
  targetSleapIoVersion: string | null;
  /** True when installed sleap-nn is strictly older than the channel's target (<0.5). */
  sleapNnUpdateAvailable: boolean;
  /**
   * True when installed sleap-nn is a <0.5 pre-release and the user selected
   * `stable` whose latest release is older (e.g. 0.4.0a0 -> 0.3.5), or offline
   * on `stable` with a pre-release installed.
   */
  isSwitchDowngrade: boolean;
  /** True when the sleap-io inside sleap-nn's venv has a newer compatible release on PyPI. */
  sleapIoUpdateAvailable: boolean;
  /** Whether the installed sleap-nn version string itself is a PEP 440 pre-release. */
  installedIsPrerelease: boolean;
  /** Whether the installed sleap-io version string itself is a PEP 440 pre-release. */
  installedSleapIoIsPrerelease: boolean;
}

/**
 * Pure status resolver used by EnvironmentPanel and UpdateIndicator to present
 * sleap-nn channel state, pre-release badges, channel switches, and bundled
 * `--with sleap-io` updates consistently.
 */
export function resolveSleapNnStatus(input: {
  tool: UvTool | undefined;
  channel: SleapNnChannel;
  pypi: PyPiPackageVersions | null;
  installedSleapIoVersion: string | null | undefined;
}): SleapNnStatusView {
  const { tool, channel, pypi, installedSleapIoVersion } = input;
  const installed = tool?.version ?? null;
  const installedIsPrerelease = isPep440Prerelease(installed);
  const installedSleapIoIsPrerelease = isPep440Prerelease(installedSleapIoVersion);

  const pypiTargetNn =
    pypi && pypi.sleapNn.length > 0
      ? pickLatestSleapNnVersion(pypi.sleapNn, channel)
      : null;

  const targetVersion =
    pypiTargetNn ??
    (tool?.updateAvailable && tool.latestVersion
      ? tool.latestVersion
      : channel === "prerelease"
        ? SLEAP_NN_VERSION_FLOOR
        : null);

  let sleapNnUpdateAvailable = false;
  let isSwitchDowngrade = false;

  if (installed && isSleapNnVersionBelowCap(installed)) {
    if (pypiTargetNn) {
      const cmp = comparePep440Versions(installed, pypiTargetNn);
      if (cmp !== null && cmp < 0) {
        sleapNnUpdateAvailable = true;
      } else if (cmp !== null && cmp > 0) {
        isSwitchDowngrade = true;
      }
    } else if (tool?.updateAvailable === true) {
      sleapNnUpdateAvailable = true;
    } else if (channel === "stable" && installedIsPrerelease) {
      // Offline on `stable` while a pre-release is installed: still allow
      // switching back to stable rather than trapping the user.
      isSwitchDowngrade = true;
    }
  }

  const targetSleapIoVersion =
    pypi && pypi.sleapIo.length > 0
      ? pickLatestSleapIoVersion(
          pypi.sleapIo,
          channel,
          installed ?? targetVersion
        )
      : channel === "prerelease"
        ? SLEAP_IO_VERSION_FLOOR
        : null;

  let sleapIoUpdateAvailable = false;
  if (
    installed &&
    installedSleapIoVersion &&
    pypi &&
    pypi.sleapIo.length > 0 &&
    !isSwitchDowngrade &&
    isSleapNnVersionBelowCap(installed)
  ) {
    const ioTarget = pickLatestSleapIoVersion(pypi.sleapIo, channel, installed);
    if (ioTarget) {
      const ioCmp = comparePep440Versions(installedSleapIoVersion, ioTarget);
      if (ioCmp !== null && ioCmp < 0) {
        sleapIoUpdateAvailable = true;
      }
    }
  }

  return {
    targetVersion,
    targetSleapIoVersion,
    sleapNnUpdateAvailable,
    isSwitchDowngrade,
    sleapIoUpdateAvailable,
    installedIsPrerelease,
    installedSleapIoIsPrerelease,
  };
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
