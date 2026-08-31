/**
 * Environment panel for Python/uv toolchain configuration.
 *
 * Shows uv status, lets users pick a Python interpreter,
 * install Python versions, and manage uv tools (sleap-nn, sleap-rtc).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  XCircle,
  Loader2,
  RefreshCw,
  Terminal,
  Download,
  RotateCw,
  ArrowUpCircle,
  ArrowDownCircle,
  ExternalLink,
  Info,
  ChevronRight,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { isTauri } from "../../platform/index";
import { classifyVersion, VERSION_KIND_LABEL } from "@/lib/version";
import {
  useEnvironmentStore,
  type InstallStatus,
} from "../../stores/environmentStore";
import type { UvTool } from "../../platform/backend";
import { openExternal } from "@/lib/openExternal";
import { cn } from "@/lib/utils";
import { sleapCmd } from "@/lib/sleapPlugin";
import {
  checkUpdateCached,
  type PendingUpdate,
} from "@/lib/updateCheckCache";
import { useAppStore, type UpdateChannel } from "@/stores/appStore";
import { hasUnsavedWork } from "@/lib/unsavedGuard";
import { toast } from "@/lib/notify";

const SLEAP_NN_RELEASES_URL = "https://github.com/talmolab/sleap-nn/releases/tag";
const SLEAP_APP_RELEASES_URL = "https://github.com/talmolab/sleap-app/releases/tag";

// ---------------------------------------------------------------------------
// Shared components
// ---------------------------------------------------------------------------

function StatusIcon({ ok }: { ok: boolean }) {
  return ok ? (
    <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
  ) : (
    <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />
  );
}

function StatusRow({
  label,
  ok,
  detail,
}: {
  label: string;
  ok: boolean;
  detail?: string;
}) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <StatusIcon ok={ok} />
      <span className="text-xs font-medium">{label}</span>
      {detail && (
        <span
          className="text-xs text-muted-foreground ml-auto truncate max-w-[140px]"
          title={detail}
        >
          {detail}
        </span>
      )}
    </div>
  );
}

function PathDisplay({ path }: { path: string }) {
  return (
    <div
      className="text-[10px] text-muted-foreground pl-5 truncate"
      title={path}
    >
      {path}
    </div>
  );
}

function InstallLog({
  lines,
  status,
  target,
  onDismiss,
}: {
  lines: string[];
  status: InstallStatus;
  target: string | null;
  onDismiss: () => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "instant" });
  }, [lines.length]);

  if (status === "idle") return null;

  return (
    <div className="border border-border rounded mt-2">
      <div className="flex items-center gap-2 px-2 py-1 border-b border-border bg-muted/30">
        {status === "installing" && (
          <Loader2 className="h-3 w-3 animate-spin shrink-0" />
        )}
        {status === "done" && (
          <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" />
        )}
        {status === "error" && (
          <XCircle className="h-3 w-3 text-red-500 shrink-0" />
        )}
        <span className="text-[10px] font-medium truncate">
          {status === "installing"
            ? `Installing ${target}...`
            : status === "done"
              ? `${target} installed`
              : `Failed to install ${target}`}
        </span>
        {status !== "installing" && (
          <Button
            variant="ghost"
            size="icon"
            className="h-4 w-4 ml-auto"
            onClick={onDismiss}
          >
            <XCircle className="h-3 w-3" />
          </Button>
        )}
      </div>
      <div className="max-h-32 overflow-auto p-1 text-[10px] font-mono leading-4 text-muted-foreground">
        {lines.map((line, i) => (
          <div key={i}>{line}</div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool action button
// ---------------------------------------------------------------------------

function ToolActions({
  tool,
  installing,
  onInstall,
  onUpgrade,
  onReinstall,
}: {
  tool: UvTool | undefined;
  installing: boolean;
  onInstall: () => void;
  onUpgrade: () => void;
  onReinstall: () => void;
}) {
  if (installing) {
    return (
      <Button variant="ghost" size="sm" className="h-5 text-[10px]" disabled>
        <Loader2 className="h-3 w-3 animate-spin mr-1" />
        Installing...
      </Button>
    );
  }

  if (!tool) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="h-5 text-[10px]"
        onClick={onInstall}
      >
        <Download className="h-3 w-3 mr-1" />
        Install
      </Button>
    );
  }

  const isUpToDate = tool.updateAvailable === false;
  const updateTitle = isUpToDate
    ? "Already up to date"
    : tool.updateAvailable && tool.latestVersion
      ? `Upgrade to v${tool.latestVersion}`
      : "Upgrade to latest version";

  return (
    <div className="flex gap-1">
      <Button
        variant="ghost"
        size="sm"
        className="h-5 text-[10px]"
        onClick={onUpgrade}
        disabled={isUpToDate}
        title={updateTitle}
      >
        <ArrowUpCircle className="h-3 w-3 mr-1" />
        Update
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-5 text-[10px]"
        onClick={onReinstall}
        title="Force reinstall"
      >
        <RotateCw className="h-3 w-3 mr-1" />
        Reinstall
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// sleap-app self-update section
// ---------------------------------------------------------------------------

const UPDATE_CHANNELS: {
  value: UpdateChannel;
  label: string;
  shortLabel: string;
}[] = [
  { value: "stable", label: "Stable", shortLabel: "Stable" },
  { value: "latest", label: "Latest", shortLabel: "Latest" },
  { value: "dev", label: "Dev (main)", shortLabel: "Dev" },
];

// classifyVersion / VERSION_KIND_LABEL now live in @/lib/version, because the
// About dialog and the web menu-bar wordmark need the same wording -- see the
// import at the top of this file. What they describe is unchanged: the kind of
// build ACTUALLY running, which is distinct from channelShortLabel above (the
// channel currently selected in the dropdown, a preference that can point at a
// different version than what's installed, e.g. right after switching channels
// but before clicking Update/Switch).

// Base (major.minor.patch) comparison only -- ignores pre-release/build
// metadata, since that's all that's needed to tell whether switching
// channels would move to an older release, to pick the right icon/wording.
// Not a full semver comparator.
export function parseBaseVersion(version: string): [number, number, number] {
  const [major = 0, minor = 0, patch = 0] = version
    .split(/[-+]/)[0]
    .split(".")
    .map((n) => Number(n) || 0);
  return [major, minor, patch];
}

export function isOlderVersion(target: string, current: string): boolean {
  const t = parseBaseVersion(target);
  const c = parseBaseVersion(current);
  for (let i = 0; i < 3; i++) {
    if (t[i] !== c[i]) return t[i] < c[i];
  }
  return false;
}

/**
 * Shows the desktop app's own version, whether a newer version is available
 * on the selected update channel (via the check_update/install_update
 * commands — see src-tauri/src/update_channels.rs — the same ones App.tsx's
 * startup check uses), a release-notes link, and a manual Update button.
 * Independent of the uv/Python detection cycle above.
 */
// Whether this is an unpackaged `tauri:dev` run — checking still works (it's
// just a network call + version compare), but there's no installer for
// download_and_install() to swap, so the Update button stays hidden. This is
// entirely orthogonal to the "Dev (main)" UPDATE CHANNEL above, which is a
// normal PACKAGED build, just one built continuously off `main` instead of a
// tagged release — hence the distinct "local build" label below rather than
// reusing the word "dev" for both.
const isLocalBuild = import.meta.env.DEV;

function AppUpdateSection() {
  const [version, setVersion] = useState<string | null>(null);
  const [pendingUpdate, setPendingUpdate] = useState<PendingUpdate | null>(null);
  const [updating, setUpdating] = useState(false);
  const [checking, setChecking] = useState(false);
  const channel = useAppStore((s) => s.updateChannel);
  const setChannel = useAppStore((s) => s.setUpdateChannel);

  // Guards against a stale response from an earlier channel overwriting a
  // fresher one: check_update's requests can resolve out of order (e.g. a
  // slow "latest" GitHub-API lookup started before a fast "dev" static-URL
  // check, but resolving after it), so only the response matching the most
  // recently STARTED request is ever applied.
  const requestIdRef = useRef(0);

  // Routed through checkUpdateCached (src/lib/updateCheckCache.ts) rather
  // than invoking check_update directly: opening/closing this panel remounts
  // AppUpdateSection each time, and without the shared cache that would
  // re-hit the GitHub API on every visit to this sidebar section within the
  // same session, not just once per app start.
  //
  // allowDowngrade: true because this check is for the channel the user
  // currently has selected in the dropdown -- it should report that
  // channel's actual current version even if it's older than what's running
  // (e.g. switching off a `dev` build back to `stable`), not just "nothing
  // newer here".
  const runCheck = useCallback(async (ch: UpdateChannel, force = false) => {
    const requestId = ++requestIdRef.current;
    setChecking(true);
    setPendingUpdate(null);
    try {
      const update = await checkUpdateCached(ch, { force, allowDowngrade: true });
      if (requestIdRef.current !== requestId) return; // superseded — drop it
      setPendingUpdate(update);
      // The allowDowngrade check above never feeds the ambient "something
      // newer is out" badge (see updateCheckCache.ts) -- fire the plain
      // strict check too so App.tsx's badge stays current for the rest of
      // the session even if this panel is the only thing re-checking
      // "stable"/"latest" past the 1h cache TTL. Fire-and-forget: doesn't
      // affect what's rendered here.
      if (ch === "stable" || ch === "latest") {
        void checkUpdateCached(ch, { force }).catch(() => {});
      }
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      console.warn("[env] App update check failed:", err);
    } finally {
      if (requestIdRef.current === requestId) setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    let active = true;
    (async () => {
      try {
        const { getVersion } = await import("@tauri-apps/api/app");
        const v = await getVersion();
        if (!active) return;
        setVersion(v);
        // Only build-dev.yml's dev-channel builds carry a "+run.sha" build
        // metadata suffix -- stable/latest are always a clean tagged
        // release with no "+". Correct updateChannel's hardcoded "stable"
        // default to match, but only before the user has ever touched the
        // dropdown themselves (see updateChannelExplicitlySet's comment).
        if (
          !useAppStore.getState().updateChannelExplicitlySet &&
          v.includes("+")
        ) {
          useAppStore.setState((state) => {
            state.updateChannel = "dev";
          });
        }
      } catch (err) {
        console.warn("[env] Failed to read app version:", err);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    void runCheck(channel);
  }, [channel, runCheck]);

  if (!isTauri) return null;

  const doUpdate = async () => {
    if (!pendingUpdate) return;
    // Installing swaps the app's files and relaunches the process — a full
    // restart, not a hot-reload — so warn first if there's anything that
    // hasn't been saved to disk yet.
    if (hasUnsavedWork(useAppStore.getState())) {
      const proceed = window.confirm(
        "You have unsaved changes. Installing this update will restart SLEAP. Continue?"
      );
      if (!proceed) return;
    }
    setUpdating(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      // Pinned to the exact version shown/clicked: install_update refuses
      // (and reports back) if a newer release landed on this channel in the
      // moments since we last checked, rather than silently installing a
      // different version than the one the user agreed to. allowDowngrade
      // must match the runCheck call above that produced pendingUpdate.
      await invoke(sleapCmd("install_update"), {
        channel,
        expectedVersion: pendingUpdate.version,
        allowDowngrade: true,
      });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (err) {
      console.error("[env] App update failed:", err);
      toast.error("Update failed", {
        description: err instanceof Error ? err.message : String(err),
      });
      setUpdating(false);
      // Forced: install_update's own rejection (e.g. a newer version landed
      // on this channel since we last checked) means the cached result is
      // now known-stale -- reusing it here would just reproduce the same
      // rejection on the next click until the 1h cache TTL happens to expire.
      void runCheck(channel, true);
    }
  };

  const latestVersion = pendingUpdate?.version ?? (version ? version : null);
  const updateAvailable = !!pendingUpdate;
  // With allowDowngrade, "available" can mean this channel's version is
  // actually OLDER than what's running (e.g. moving off a `dev` build back
  // to `stable`) -- distinguish that so the wording/icon don't say "update"
  // for what's really a downgrade.
  const isSwitchDowngrade =
    updateAvailable &&
    !!version &&
    !!latestVersion &&
    isOlderVersion(latestVersion, version);
  const channelShortLabel =
    UPDATE_CHANNELS.find((c) => c.value === channel)?.shortLabel ?? channel;
  // Dev-channel builds live under a single rolling `dev` release tag,
  // not their own `v{version}` tag, so there's no per-version release page to
  // link to (unlike stable/latest, which are always a real GitHub Release).
  // Also hidden on a local build, same reasoning as the arrow above: it
  // links to notes for a version there's no installer here to apply.
  const hasReleaseNotesPage =
    updateAvailable && channel !== "dev" && !isLocalBuild;

  return (
    <section>
      <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
        SLEAP App
      </h4>
      {/* Row 1: status + version/channel — always full opacity, never
          disabled by isLocalBuild (only the channel control below is). */}
      <div className="flex items-center gap-2 py-0.5">
        <StatusIcon ok={!!version} />
        <span className="text-xs font-medium">sleap-app</span>
        {version && (
          <span className="text-xs text-muted-foreground">
            v{version}
            <span className="text-muted-foreground/70">
              {" "}
              · {channelShortLabel}
            </span>
          </span>
        )}
        {version && (
          <Badge
            variant="outline"
            className="text-[10px] px-1.5 py-0 h-4 rounded-sm text-muted-foreground"
            title="Inferred from the version string: a `-pre.release` suffix means a pre-release, a `+build.meta` suffix means a continuous Dev-channel build, otherwise it's a full Stable release."
          >
            {VERSION_KIND_LABEL[classifyVersion(version)]}
          </Badge>
        )}
        {isLocalBuild && (
          <Badge
            variant="secondary"
            className="text-[10px] px-1.5 py-0 h-4 rounded-sm"
            title="Running via `tauri:dev` (unpackaged) — channel checks still work, but there's no installer to apply an update to. Run `bun run tauri:build` to actually install one."
          >
            local build
          </Badge>
        )}
        {/* A local build can't install anything (Update stays disabled
            below), so "→ vX" here would read as actionable when it isn't.
            "up to date" still shows -- that's just informational either
            way. */}
        {latestVersion && !(isLocalBuild && updateAvailable) && (
          <span
            className={cn(
              "text-xs",
              !updateAvailable
                ? "text-green-500"
                : isSwitchDowngrade
                  ? "text-blue-500"
                  : "text-orange-500"
            )}
          >
            {!updateAvailable
              ? "up to date"
              : isSwitchDowngrade
                ? `→ v${latestVersion} (switch)`
                : `→ v${latestVersion}`}
          </span>
        )}
        {hasReleaseNotesPage && (
          <button
            onClick={() =>
              openExternal(`${SLEAP_APP_RELEASES_URL}/v${latestVersion}`)
            }
            title="View release notes"
            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
          >
            <ExternalLink className="h-3 w-3" />
            Release Notes
          </button>
        )}
      </div>

      {/* Row 2: channel control + Update action, on its own line so row 1
          (which can already carry a version/channel/badge/notes-link combo)
          doesn't wrap. */}
      <div
        className={cn(
          "flex items-center gap-1.5 py-0.5 pl-5",
          isLocalBuild && "opacity-60"
        )}
      >
        <span className="text-[10px] text-muted-foreground">Channel</span>
        <Select
          value={channel}
          onValueChange={(v) => setChannel(v as UpdateChannel)}
          disabled={checking || updating || isLocalBuild}
        >
          <SelectTrigger className="h-5 w-auto gap-1 px-1.5 text-[10px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {UPDATE_CHANNELS.map((c) => (
              <SelectItem key={c.value} value={c.value} className="text-xs">
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Info className="h-3 w-3 text-muted-foreground cursor-help" />
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-64 space-y-1 text-left">
              <p>
                <span className="font-semibold">Stable</span> — full releases
                only. Recommended for most users.
              </p>
              <p>
                <span className="font-semibold">Latest</span> — whichever is
                newest: a full release or a pre-release.
              </p>
              <p>
                <span className="font-semibold">Dev (main)</span> — Latest
                changes from GitHub (<code>main</code> branch). May be less
                stable than a released version.
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "h-5 text-[10px] ml-auto",
            (isLocalBuild || !updateAvailable) && "opacity-60"
          )}
          onClick={doUpdate}
          disabled={updating || isLocalBuild || !updateAvailable}
          title={
            isLocalBuild
              ? "Running via tauri:dev — there's no installer to apply this update to. Run `bun run tauri:build` to actually install one."
              : updateAvailable
                ? isSwitchDowngrade
                  ? `Download and install v${latestVersion} (this channel's current version, older than what's running), then relaunch`
                  : "Download and install the new version, then relaunch"
                : "You're already on the newest version for this channel"
          }
        >
          {updating ? (
            <Loader2 className="h-3 w-3 animate-spin mr-1" />
          ) : isSwitchDowngrade ? (
            <ArrowDownCircle className="h-3 w-3 mr-1" />
          ) : (
            <ArrowUpCircle className="h-3 w-3 mr-1" />
          )}
          {updating ? "Updating..." : isSwitchDowngrade ? "Switch" : "Update"}
        </Button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export function EnvironmentPanel() {
  const {
    uv,
    tools,
    interpreters,
    downloadable,
    selectedPythonPath,
    pythonCheck,
    detectionStatus,
    detectionError,
    installStatus,
    installLog,
    installTarget,
    refresh,
    selectPython,
    doInstallPython,
    doInstallTool,
    doUpgradeTool,
    doReinstallTool,
    doUpdateUv,
    doInstallUv,
    clearInstallLog,
  } = useEnvironmentStore();

  // Auto-detect on mount
  useEffect(() => {
    if (isTauri && detectionStatus === "idle") {
      refresh();
    }
  }, [refresh, detectionStatus]);

  // Collapsed by default: uv provisions Python itself (including
  // downloading one, if none exists at all — see uv's own default
  // python-downloads: automatic) whenever a specific interpreter isn't
  // selected, so most users never need to open this at all.
  const [showAdvancedPython, setShowAdvancedPython] = useState(false);

  if (!isTauri) {
    return (
      <div className="p-2 text-xs text-muted-foreground">
        <p>Environment detection is only available in the desktop app.</p>
        <p className="mt-1">
          Run <code className="bg-muted px-1 rounded">sleap</code> as a
          desktop application to configure Python environments.
        </p>
      </div>
    );
  }

  const sleapNnTool = tools.find((t) => t.name === "sleap-nn");
  const sleapRtcTool = tools.find((t) => t.name === "sleap-rtc");
  const isDetecting = detectionStatus === "checking";
  const detected = detectionStatus === "done" || detectionStatus === "error";
  const isInstalling = installStatus === "installing";

  const managedInterps = interpreters.filter((i) => i.source === "managed");
  const systemInterps = interpreters.filter((i) => i.source === "system");

  return (
    <div className="flex flex-col gap-3 -m-2">
      {/* Header */}
      <div className="flex items-center gap-2 px-2 py-1 border-b border-border shrink-0">
        <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">Environment</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 ml-auto"
          onClick={refresh}
          disabled={isDetecting}
          title="Refresh environment detection"
        >
          <RefreshCw
            className={`h-3 w-3 ${isDetecting ? "animate-spin" : ""}`}
          />
        </Button>
      </div>

      <div className="px-2 flex flex-col gap-3">
        <AppUpdateSection />

        {/* Loading */}
        {isDetecting && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Detecting environment...
          </div>
        )}

        {detectionError && (
          <div className="text-xs text-red-500 bg-red-500/10 rounded px-2 py-1">
            {detectionError}
          </div>
        )}

        {/* Section 1: Package Manager */}
        {detected && (
          <section>
            <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
              Package Manager
            </h4>
            {/* Row 1: status + version — Update/Install moved to its own
                row below, same reasoning as the SLEAP App/sleap-nn
                sections above: icon + name + version + status text +
                Detected badge + action button all in one non-wrapping row
                overflowed a narrow panel once the up-to-date/outdated
                status text was added. */}
            <div className="flex items-center gap-2 py-0.5">
              <StatusIcon ok={uv?.available ?? false} />
              <span className="text-xs font-medium">uv</span>
              {uv?.available && uv.version && (
                <span className="text-xs text-muted-foreground">
                  v{uv.version}
                </span>
              )}
              {/* uv.updateAvailable is null until the (network-dependent,
                  best-effort) `uv self update --dry-run` check resolves --
                  see detect_uv/check_uv_self_update in environment.rs. Same
                  up-to-date/outdated status text as the UV TOOLS section
                  below, just for uv itself. */}
              {uv?.available && uv.updateAvailable !== null && (
                <span
                  className={cn(
                    "text-xs",
                    uv.updateAvailable ? "text-orange-500" : "text-green-500"
                  )}
                >
                  {uv.updateAvailable
                    ? uv.latestVersion
                      ? `→ v${uv.latestVersion}`
                      : "update available"
                    : "up to date"}
                </span>
              )}
            </div>

            {/* Row 2: detection badge + action, on its own line. */}
            <div className="flex items-center gap-2 py-0.5 pl-5">
              {/* Explicit detection declaration (auto-detected on mount, before
                  any install). Makes "found vs not found" unmistakable. */}
              <Badge
                variant="secondary"
                className={`text-[10px] px-1.5 py-0 h-4 rounded-sm ${
                  uv?.available
                    ? "bg-green-500/10 text-green-500"
                    : "bg-red-500/10 text-red-500"
                }`}
              >
                {uv?.available ? "Detected" : "Not detected"}
              </Badge>
              <div className="ml-auto">
                {uv?.available ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 text-[10px]"
                    onClick={doUpdateUv}
                    disabled={
                      isInstalling ||
                      uv.updateAvailable === false ||
                      uv.selfUpdateSupported === false
                    }
                    title={
                      uv.selfUpdateSupported === false
                        ? "This uv was installed via a package manager — update it with `brew upgrade`, `pip install --upgrade uv`, or similar instead."
                        : uv.updateAvailable === false
                          ? "Already up to date"
                          : uv.updateAvailable && uv.latestVersion
                            ? `Update to v${uv.latestVersion}`
                            : "Update uv to latest version"
                    }
                  >
                    <ArrowUpCircle className="h-3 w-3 mr-1" />
                    Update
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-5 text-[10px]"
                    onClick={doInstallUv}
                    disabled={isInstalling}
                    title="Install uv via official installer"
                  >
                    <Download className="h-3 w-3 mr-1" />
                    Install
                  </Button>
                )}
              </div>
            </div>
            {!uv?.available && (
              <div className="text-[10px] text-muted-foreground pl-5">
                No existing uv found on this system — install it to enable
                training &amp; inference.
              </div>
            )}
            {uv?.path && <PathDisplay path={uv.path} />}
            {uv?.pythonDir && (
              <div className="text-[10px] text-muted-foreground pl-5 mt-0.5">
                Managed Pythons: <span className="truncate" title={uv.pythonDir}>{uv.pythonDir}</span>
              </div>
            )}
          </section>
        )}

        {/* Section 2: Python Interpreter — collapsed by default and
            relabeled "Advanced": uv already provisions a suitable Python
            on its own (downloading one if none exists at all) whenever no
            specific interpreter is selected here, so this is a manual
            override for the rare case someone wants sleap-nn built against
            a particular Python, not something most users ever need to
            open. */}
        {detected && uv?.available && (
          <section>
            <button
              onClick={() => setShowAdvancedPython((v) => !v)}
              className="flex items-center gap-1 w-full text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors mb-1"
            >
              <ChevronRight
                className={cn(
                  "h-3 w-3 transition-transform",
                  showAdvancedPython && "rotate-90"
                )}
              />
              Advanced: Python Interpreter Manager
            </button>

            {showAdvancedPython && (
              <div>
                {interpreters.length > 0 ? (
                  <Select
                    value={selectedPythonPath ?? ""}
                    onValueChange={(path) => selectPython(path)}
                  >
                    <SelectTrigger className="h-7 text-xs">
                      <SelectValue placeholder="Select interpreter..." />
                    </SelectTrigger>
                    <SelectContent>
                      {managedInterps.length > 0 && (
                        <SelectGroup>
                          <SelectLabel className="text-[10px]">
                            uv Managed
                          </SelectLabel>
                          {managedInterps.map((i) => (
                            <SelectItem
                              key={i.path}
                              value={i.path!}
                              className="text-xs"
                            >
                              Python {i.version}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      )}
                      {systemInterps.length > 0 && (
                        <SelectGroup>
                          <SelectLabel className="text-[10px]">
                            System
                          </SelectLabel>
                          {systemInterps.map((i) => (
                            <SelectItem
                              key={i.path}
                              value={i.path!}
                              className="text-xs"
                            >
                              Python {i.version}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      )}
                    </SelectContent>
                  </Select>
                ) : (
                  <div className="text-xs text-muted-foreground py-1">
                    No Python interpreters found.
                  </div>
                )}

                {/* Selected interpreter details */}
                {selectedPythonPath && (
                  <div className="mt-1.5 pl-1">
                    <PathDisplay path={selectedPythonPath} />
                    {pythonCheck && (
                      <div className="mt-1">
                        {pythonCheck.sleapNnVersion ? (
                          // Importable directly in the selected interpreter.
                          <StatusRow
                            label="sleap-nn"
                            ok
                            detail={`v${pythonCheck.sleapNnVersion}`}
                          />
                        ) : sleapNnTool ? (
                          // Not in THIS interpreter, but installed as an isolated uv
                          // tool — which is what training/inference actually runs
                          // (the `sleap-nn` shim uses its own venv). Info, not error.
                          <>
                            <div className="flex items-center gap-2 py-0.5">
                              <Info className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                              <span className="text-xs font-medium">
                                sleap-nn
                              </span>
                              <span className="text-[10px] text-muted-foreground ml-auto">
                                v{sleapNnTool.version} (uv tool)
                              </span>
                            </div>
                            <div className="text-[10px] text-muted-foreground pl-5">
                              Not installed in this interpreter — training
                              uses the isolated uv-tool install, so this is
                              expected.
                            </div>
                          </>
                        ) : (
                          // Not importable here and no uv tool — genuinely missing.
                          <StatusRow
                            label="sleap-nn"
                            ok={false}
                            detail="Not installed"
                          />
                        )}
                      </div>
                    )}
                    {!pythonCheck && selectedPythonPath && (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Checking packages...
                      </div>
                    )}
                  </div>
                )}

                {/* Install new Python */}
                {downloadable.length > 0 && (
                  <div className="mt-2 flex items-center gap-1.5">
                    <Select
                      onValueChange={(version) => doInstallPython(version)}
                      disabled={isInstalling}
                    >
                      <SelectTrigger className="h-6 text-[10px] flex-1">
                        <SelectValue placeholder="Install Python..." />
                      </SelectTrigger>
                      <SelectContent>
                        {downloadable.map((d) => (
                          <SelectItem
                            key={d.key}
                            value={d.version}
                            className="text-xs"
                          >
                            Python {d.version}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {/* Section 3: UV Tools */}
        {detected && uv?.available && (
          <section>
            <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
              UV Tools
            </h4>

            {/* sleap-nn: status/version on their own line, actions on the
                next one -- crammed into a single non-wrapping row, the
                Update/Reinstall buttons got pushed off and clipped on a
                narrow panel. */}
            <div className="flex items-center gap-2 py-0.5">
              <StatusIcon ok={!!sleapNnTool} />
              <span className="text-xs font-medium">sleap-nn</span>
              {sleapNnTool?.version && (
                <span className="text-xs text-muted-foreground">
                  v{sleapNnTool.version}
                </span>
              )}
              {sleapNnTool?.latestVersion && (
                <>
                  <span
                    className={cn(
                      "text-xs",
                      sleapNnTool.updateAvailable
                        ? "text-orange-500"
                        : "text-green-500"
                    )}
                  >
                    {sleapNnTool.updateAvailable
                      ? `→ v${sleapNnTool.latestVersion}`
                      : "up to date"}
                  </span>
                  <button
                    onClick={() =>
                      openExternal(
                        `${SLEAP_NN_RELEASES_URL}/v${sleapNnTool.latestVersion}`
                      )
                    }
                    title="View release notes"
                    className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <ExternalLink className="h-3 w-3" />
                    Release Notes
                  </button>
                </>
              )}
            </div>
            <div className="flex items-center py-0.5 pl-5">
              <div className="ml-auto">
                <ToolActions
                  tool={sleapNnTool}
                  installing={
                    isInstalling &&
                    (installTarget?.includes("sleap-nn") ?? false)
                  }
                  onInstall={() => doInstallTool("sleap-nn")}
                  onUpgrade={() => doUpgradeTool("sleap-nn")}
                  onReinstall={() => doReinstallTool("sleap-nn")}
                />
              </div>
            </div>

            {/* sleap-rtc */}
            <div className="flex items-center gap-2 py-0.5 mt-1">
              <StatusIcon ok={!!sleapRtcTool} />
              <span className="text-xs font-medium">sleap-rtc</span>
              {sleapRtcTool?.version && (
                <span className="text-xs text-muted-foreground">
                  v{sleapRtcTool.version}
                </span>
              )}
              <div className="ml-auto">
                <ToolActions
                  tool={sleapRtcTool}
                  installing={
                    isInstalling &&
                    (installTarget?.includes("sleap-rtc") ?? false)
                  }
                  onInstall={() => doInstallTool("sleap-rtc")}
                  onUpgrade={() => doUpgradeTool("sleap-rtc")}
                  onReinstall={() => doReinstallTool("sleap-rtc")}
                />
              </div>
            </div>
          </section>
        )}

        {/* Install log (shared for all install operations) */}
        <InstallLog
          lines={installLog}
          status={installStatus}
          target={installTarget}
          onDismiss={clearInstallLog}
        />
      </div>
    </div>
  );
}
