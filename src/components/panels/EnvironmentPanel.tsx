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
  ExternalLink,
  Info,
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

const UPDATE_CHANNELS: { value: UpdateChannel; label: string }[] = [
  { value: "stable", label: "Stable" },
  { value: "latest", label: "Latest" },
  { value: "dev", label: "Dev (main)" },
];

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
  const runCheck = useCallback(async (ch: UpdateChannel, force = false) => {
    const requestId = ++requestIdRef.current;
    setChecking(true);
    setPendingUpdate(null);
    try {
      const update = await checkUpdateCached(ch, { force });
      if (requestIdRef.current !== requestId) return; // superseded — drop it
      setPendingUpdate(update);
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
        if (active) setVersion(v);
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
      // different version than the one the user agreed to.
      await invoke(sleapCmd("install_update"), {
        channel,
        expectedVersion: pendingUpdate.version,
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
  // Dev-channel builds live under a single rolling `dev` release tag,
  // not their own `v{version}` tag, so there's no per-version release page to
  // link to (unlike stable/latest, which are always a real GitHub Release).
  const hasReleaseNotesPage = updateAvailable && channel !== "dev";

  return (
    <section>
      <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
        SLEAP App
      </h4>
      {/* Row 1: status + action — always full opacity, never disabled by
          isLocalBuild (only the channel control below is). */}
      <div className="flex items-center gap-2 py-0.5">
        <StatusIcon ok={!!version} />
        <span className="text-xs font-medium">sleap-app</span>
        {version && (
          <span className="text-xs text-muted-foreground">v{version}</span>
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
        {latestVersion && (
          <span
            className={cn(
              "text-xs",
              updateAvailable ? "text-orange-500" : "text-green-500"
            )}
          >
            {updateAvailable ? `→ v${latestVersion}` : "up to date"}
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
                ? "Download and install the new version, then relaunch"
                : "You're already on the newest version for this channel"
          }
        >
          {updating ? (
            <Loader2 className="h-3 w-3 animate-spin mr-1" />
          ) : (
            <ArrowUpCircle className="h-3 w-3 mr-1" />
          )}
          {updating ? "Updating..." : "Update"}
        </Button>
      </div>

      {/* Row 2: channel control, on its own line so row 1 doesn't wrap. */}
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
            <div className="flex items-center gap-2 py-0.5">
              <StatusIcon ok={uv?.available ?? false} />
              <span className="text-xs font-medium">uv</span>
              {uv?.available && uv.version && (
                <span className="text-xs text-muted-foreground">
                  v{uv.version}
                </span>
              )}
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
                    disabled={isInstalling}
                    title="Update uv to latest version"
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

        {/* Section 2: Python Interpreter */}
        {detected && uv?.available && (
          <section>
            <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
              Python Interpreter
            </h4>

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
                      <SelectLabel className="text-[10px]">System</SelectLabel>
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
                          <span className="text-xs font-medium">sleap-nn</span>
                          <span className="text-[10px] text-muted-foreground ml-auto">
                            v{sleapNnTool.version} (uv tool)
                          </span>
                        </div>
                        <div className="text-[10px] text-muted-foreground pl-5">
                          Not installed in this interpreter — training uses the
                          isolated uv-tool install, so this is expected.
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
          </section>
        )}

        {/* Section 3: UV Tools */}
        {detected && uv?.available && (
          <section>
            <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
              UV Tools
            </h4>

            {/* sleap-nn */}
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
            {sleapNnTool && sleapNnTool.commands.length > 0 && (
              <div className="flex flex-wrap gap-1 pl-5 mt-0.5">
                {sleapNnTool.commands.map((cmd) => (
                  <Badge
                    key={cmd}
                    variant="secondary"
                    className="text-[10px] px-1.5 py-0 h-4 rounded-sm font-mono"
                  >
                    {cmd}
                  </Badge>
                ))}
              </div>
            )}

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
            {sleapRtcTool && sleapRtcTool.commands.length > 0 && (
              <div className="flex flex-wrap gap-1 pl-5 mt-0.5">
                {sleapRtcTool.commands.map((cmd) => (
                  <Badge
                    key={cmd}
                    variant="secondary"
                    className="text-[10px] px-1.5 py-0 h-4 rounded-sm font-mono"
                  >
                    {cmd}
                  </Badge>
                ))}
              </div>
            )}
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
