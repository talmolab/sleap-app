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
import { Checkbox } from "@/components/ui/checkbox";
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
  type DetectionStatus,
  type InstallStatus,
} from "../../stores/environmentStore";
import type {
  AcceleratorInfo,
  SleapNnExtras,
  UvTool,
} from "../../platform/backend";
import {
  summarizeAccelerator,
  type AcceleratorLevel,
} from "@/lib/accelerator";
import {
  tensorrtAvailability,
  toggleExtra,
  type ExtrasSelection,
} from "@/lib/extras";
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

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------
//
// Every row in this panel is a label/value pair on a SHARED label column, so
// values line up down the whole panel instead of starting wherever the
// preceding label happened to end. Before this, rows nested themselves with
// ad-hoc pl-5/pl-10 indents and packed version + status + badges + buttons
// into one line, which overflowed at this panel's ~320px and left a ragged
// left edge. Vertical space is the cheap resource here (the panel rarely
// fills its column), so rows are allowed to be many and narrow rather than
// few and crowded.

/** Width of the shared label column. Fits "Accelerator", the longest label. */
const LABEL_COL = "w-[74px]";

/** One label/value row. Omit `label` to align content under the value column. */
function Field({
  label,
  children,
  align = "center",
  className,
}: {
  label?: string;
  children: React.ReactNode;
  /** "start" for values that wrap to several lines (e.g. the extras boxes). */
  align?: "center" | "start";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex gap-2 py-[3px]",
        align === "center" ? "items-center" : "items-start",
        className
      )}
    >
      <span
        className={cn(
          LABEL_COL,
          "shrink-0 text-[10px] text-muted-foreground",
          align === "start" && "pt-[3px]"
        )}
      >
        {label}
      </span>
      <div className="min-w-0 flex-1 text-xs">{children}</div>
    </div>
  );
}

/** Secondary text under a value — paths, device names, status sentences. */
function Detail({
  children,
  title,
}: {
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <div className="truncate text-[10px] text-muted-foreground" title={title}>
      {children}
    </div>
  );
}

/**
 * A titled block. `aside` sits opposite the title — used for the thing the
 * whole section is about (a tool's version), which would otherwise compete
 * with status text inside the rows.
 */
function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-1 flex items-center gap-2">
        <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h4>
        {aside && <div className="ml-auto flex items-center gap-2">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

/** Right-aligned action buttons, on their own line below a section's rows. */
function Actions({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-end gap-1 pt-1">{children}</div>
  );
}

/** Small info tooltip; used wherever a row needs a "why" it can't fit inline. */
function Hint({ children }: { children: React.ReactNode }) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Info className="h-3 w-3 shrink-0 cursor-help text-muted-foreground" />
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-64 text-left">
          {children}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** Version + "up to date"/"→ vX" status, the shape repeated for every tool. */
function VersionStatus({
  version,
  latestVersion,
  updateAvailable,
}: {
  version?: string | null;
  latestVersion?: string | null;
  updateAvailable?: boolean | null;
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {version && <span className="truncate">v{version}</span>}
      {updateAvailable != null && (
        <span
          className={cn(
            "shrink-0 text-[10px]",
            updateAvailable ? "text-orange-500" : "text-green-500"
          )}
        >
          {updateAvailable
            ? latestVersion
              ? `→ v${latestVersion}`
              : "update available"
            : "up to date"}
        </span>
      )}
    </span>
  );
}

function StatusIcon({ ok }: { ok: boolean }) {
  return ok ? (
    <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
  ) : (
    <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />
  );
}

const ACCELERATOR_DOT: Record<AcceleratorLevel, string> = {
  ok: "bg-green-500 shadow-[0_0_5px_0] shadow-green-500/70",
  warn: "bg-orange-500",
  none: "bg-muted-foreground/60",
  unknown: "bg-muted-foreground/60",
};

const ACCELERATOR_TEXT: Record<AcceleratorLevel, string> = {
  ok: "text-green-500",
  warn: "text-orange-500",
  none: "text-muted-foreground",
  unknown: "text-muted-foreground",
};

/**
 * The "did my GPU actually get picked up?" light, plus the versions behind it.
 * Lives under sleap-nn because it's sleap-nn's own torch being asked (see
 * detectAccelerator) — which is the point: it answers whether THIS install can
 * train on the GPU, not merely whether the machine has one.
 */
function AcceleratorFields({
  info,
  status,
}: {
  info: AcceleratorInfo | null;
  status: DetectionStatus;
}) {
  if (status === "checking") {
    return (
      <Field label="Accelerator">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
          Checking...
        </span>
      </Field>
    );
  }
  if (!info) return null;

  const { level, label, rows, devices, platform, hint } =
    summarizeAccelerator(info);

  return (
    <>
      <Field label="Accelerator">
        <span className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "h-2 w-2 shrink-0 rounded-full",
              ACCELERATOR_DOT[level]
            )}
          />
          <span
            className={cn("truncate", ACCELERATOR_TEXT[level])}
            title={platform ? `${label} — ${platform}` : label}
          >
            {label}
          </span>
          {hint && <Hint>{hint}</Hint>}
        </span>
        {devices.map((device, i) => (
          <Detail key={i} title={device}>
            {device}
          </Detail>
        ))}
      </Field>
      {rows.map((row) => (
        <Field key={row.label} label={row.label}>
          <span className="truncate" title={row.value}>
            {row.value}
          </span>
        </Field>
      ))}
    </>
  );
}

/**
 * Optional-extras checkboxes for the installed sleap-nn (ONNX / TensorRT
 * export support).
 *
 * These are a DESIRED-state selection, not toggles that act immediately:
 * `uv tool install` replaces the whole tool env, so changing extras means a
 * full sleap-nn reinstall. Hence a single Apply that appears only once the
 * selection differs from what's installed, and hence unchecking removes an
 * extra (it simply isn't in the replacement env).
 */
function ExtrasField({
  extras,
  status,
  accelerator,
  installing,
  onApply,
}: {
  extras: SleapNnExtras | null;
  status: DetectionStatus;
  accelerator: AcceleratorInfo | null;
  installing: boolean;
  onApply: (want: { onnx: boolean; tensorrt: boolean }) => void;
}) {
  const [sel, setSel] = useState<ExtrasSelection | null>(null);

  // Re-seed from every probe result, so after an Apply (which refreshes) the
  // boxes show what actually landed rather than what was asked for.
  useEffect(() => {
    if (extras) setSel({ onnx: extras.onnx, tensorrt: extras.tensorrt });
  }, [extras]);

  if (status === "checking" && !extras) {
    return (
      <Field label="Extras">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
          Checking...
        </span>
      </Field>
    );
  }
  if (!extras || !sel) return null;

  const trt = tensorrtAvailability(extras, accelerator);
  const dirty = sel.onnx !== extras.onnx || sel.tensorrt !== extras.tensorrt;

  const box = (
    checked: boolean,
    enabled: boolean,
    name: string,
    note: string | null,
    onChange: (v: boolean) => void
  ) => (
    <label
      className={cn(
        "flex items-center gap-1.5",
        enabled && !installing
          ? "cursor-pointer"
          : "cursor-not-allowed opacity-50"
      )}
    >
      <Checkbox
        className="h-3.5 w-3.5"
        checked={checked}
        disabled={installing || !enabled}
        onCheckedChange={(c) => onChange(c === true)}
      />
      {name}
      {note && <span className="text-[10px] text-muted-foreground">{note}</span>}
    </label>
  );

  return (
    <Field label="Extras" align="start">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          {box(sel.onnx, true, "ONNX", null, (v) =>
            setSel(toggleExtra(sel, "onnx", v))
          )}
          <Hint>
            Optional sleap-nn dependencies for exporting a trained model to a
            faster runtime. Applying reinstalls sleap-nn, because a uv tool
            install replaces the whole environment.
          </Hint>
        </div>
        {box(sel.tensorrt, trt.enabled, "TensorRT", trt.note, (v) =>
          setSel(toggleExtra(sel, "tensorrt", v))
        )}
        {extras.error ? (
          <Detail title={extras.error}>
            Couldn't check extras: {extras.error}
          </Detail>
        ) : dirty ? (
          <Button
            variant="outline"
            size="sm"
            className="h-5 self-start text-[10px]"
            onClick={() => onApply(sel)}
            disabled={installing}
            title="Reinstall sleap-nn with exactly these extras"
          >
            <Download className="mr-1 h-3 w-3" />
            Apply
          </Button>
        ) : (
          !extras.onnx && (
            <Detail>Needed to export a trained model.</Detail>
          )
        )}
      </div>
    </Field>
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
      <div className="max-h-32 overflow-auto p-1 text-[10px] font-mono leading-4 text-muted-foreground select-text">
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
}[] = [
  { value: "stable", label: "Stable" },
  { value: "latest", label: "Latest" },
  { value: "dev", label: "Dev (main)" },
];

// classifyVersion / VERSION_KIND_LABEL now live in @/lib/version, because the
// About dialog and the web menu-bar wordmark need the same wording -- see the
// import at the top of this file. What they describe is the kind of build
// ACTUALLY running, which is why the badge next to the version is derived from
// the version string and NOT from the channel selected above: the dropdown is
// a preference that can point at a different version than what's installed
// (e.g. right after switching channels but before clicking Update/Switch), so
// echoing it beside the version made the label appear to change the build the
// moment the selection changed. The selected channel is shown once, on the
// Channel row, where it reads as the preference it is.

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

// Exported for tests only (environmentPanelChannelLabel.test.tsx); the panel
// itself renders it below.
export function AppUpdateSection() {
  const [version, setVersion] = useState<string | null>(null);
  const [pendingUpdate, setPendingUpdate] = useState<PendingUpdate | null>(null);
  const [updating, setUpdating] = useState(false);
  const [checking, setChecking] = useState(false);
  // Why the last check failed, or null if it didn't. Rendered on row 1 with
  // a Retry -- a check that fails has to SAY so. It used to only
  // console.warn, which meant the panel showed a version, no "up to date",
  // and a greyed-out Channel dropdown, with nothing anywhere explaining
  // that anything had gone wrong.
  const [checkError, setCheckError] = useState<string | null>(null);
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
    setCheckError(null);
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
      setCheckError(err instanceof Error ? err.message : String(err));
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
  // Dev-channel builds live under a single rolling `dev` release tag,
  // not their own `v{version}` tag, so there's no per-version release page to
  // link to (unlike stable/latest, which are always a real GitHub Release).
  // Also hidden on a local build, same reasoning as the arrow above: it
  // links to notes for a version there's no installer here to apply.
  const hasReleaseNotesPage =
    updateAvailable && channel !== "dev" && !isLocalBuild;

  return (
    <Section
      title="SLEAP App"
      aside={
        version ? (
          <span className="text-xs text-muted-foreground">v{version}</span>
        ) : null
      }
    >
      <Field label="Build">
        <span className="flex min-w-0 items-center gap-1.5">
          <StatusIcon ok={!!version} />
          <span
            className="truncate"
            title="Inferred from the version string: a `-pre.release` suffix means a pre-release, a `+build.meta` suffix means a continuous Dev-channel build, otherwise it's a full Stable release."
          >
            {version ? VERSION_KIND_LABEL[classifyVersion(version)] : "Unknown"}
          </span>
          {isLocalBuild && (
            <Badge
              variant="secondary"
              className="h-4 shrink-0 rounded-sm px-1.5 py-0 text-[10px]"
              title="Running via `tauri:dev` (unpackaged) — channel checks still work, but there's no installer to apply an update to. Run `bun run tauri:build` to actually install one."
            >
              local build
            </Badge>
          )}
        </span>
      </Field>

      <Field label="Channel">
        <div className="flex min-w-0 items-center gap-1.5">
          <Select
            value={channel}
            onValueChange={(v) => setChannel(v as UpdateChannel)}
            // NOT disabled while `checking`: a check that never settles (a hung
            // request, or a panic in check_update leaving the invoke promise
            // unresolved) would grey this out forever with no way back. See
            // tests/unit/environmentPanelCheckFailure.test.tsx.
            disabled={updating || isLocalBuild}
          >
            <SelectTrigger
              className={cn(
                "h-5 w-auto gap-1 px-1.5 text-[10px]",
                isLocalBuild && "opacity-60"
              )}
            >
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
          <Hint>
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
          </Hint>
        </div>
      </Field>

      {/* Surfacing the failure beats silently showing nothing: the full
          message can be actionable (e.g. "no full release has a latest.json
          manifest yet"), so it goes in the tooltip, with a retry alongside.

          A local build is the exception, and gets the same treatment as the
          arrow and the Update button below: there is no installer for
          download_and_install() to swap, so nothing the check could report is
          actionable here. Amber "Check failed" next to the "local build" badge
          above read as a broken app rather than as "this shell cannot
          self-update" -- so state that plainly, muted, and keep the underlying
          reason in the tooltip for whoever is actually debugging the checker.
          No Retry either: retrying cannot produce anything usable. */}
      {!checking && checkError && (
        <Field label="Update">
          {isLocalBuild ? (
            <span
              className="truncate text-muted-foreground"
              title={`Running via \`tauri:dev\` (unpackaged) — there is no installer to apply an update to, so this check is informational only. It did not complete: ${checkError}`}
            >
              not applicable
            </span>
          ) : (
            <span className="flex min-w-0 items-center gap-1.5 text-amber-500">
              <span className="truncate" title={checkError}>
                Check failed
              </span>
              <button
                onClick={() => void runCheck(channel, true)}
                className="shrink-0 text-[10px] underline underline-offset-2 transition-colors hover:text-foreground"
              >
                Retry
              </button>
            </span>
          )}
        </Field>
      )}

      {checking && (
        <Field label="Update">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
            Checking...
          </span>
        </Field>
      )}

      {/* A local build can't install anything, so "→ vX" would read as
          actionable when it isn't; "up to date" is informational either way. */}
      {!checking && !checkError && latestVersion && !(isLocalBuild && updateAvailable) && (
        <Field label="Update">
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className={cn(
                "truncate",
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
                  ? `v${latestVersion} (switch)`
                  : `v${latestVersion}`}
            </span>
            {hasReleaseNotesPage && (
              <button
                onClick={() =>
                  openExternal(`${SLEAP_APP_RELEASES_URL}/v${latestVersion}`)
                }
                title="View release notes"
                className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
              >
                <ExternalLink className="h-3 w-3" />
              </button>
            )}
          </span>
        </Field>
      )}

      {!checking && !checkError && updateAvailable && (
        <Actions>
          <Button
            variant="outline"
            size="sm"
            className={cn("h-5 text-[10px]", isLocalBuild && "opacity-60")}
            onClick={doUpdate}
            disabled={updating || isLocalBuild}
            title={
              isLocalBuild
                ? "Running via tauri:dev — there's no installer to apply this update to. Run `bun run tauri:build` to actually install one."
                : isSwitchDowngrade
                  ? `Download and install v${latestVersion} (this channel's current version, older than what's running), then relaunch`
                  : "Download and install the new version, then relaunch"
            }
          >
            {updating ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : isSwitchDowngrade ? (
              <ArrowDownCircle className="mr-1 h-3 w-3" />
            ) : (
              <ArrowUpCircle className="mr-1 h-3 w-3" />
            )}
            {updating ? "Updating..." : isSwitchDowngrade ? "Switch" : "Update"}
          </Button>
        </Actions>
      )}
    </Section>
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
    accelerator,
    acceleratorStatus,
    extras,
    extrasStatus,
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
    installExtras,
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

        {/* Toolchain: uv + the Python it provisions. The interpreter manager
            and the install paths both live behind one disclosure — uv picks a
            suitable Python on its own (downloading one if none exists), so
            neither is something most users ever need to see. */}
        {detected && (
          <Section
            title="Toolchain"
            aside={
              <Badge
                variant="secondary"
                className={cn(
                  "h-4 rounded-sm px-1.5 py-0 text-[10px]",
                  uv?.available
                    ? "bg-green-500/10 text-green-500"
                    : "bg-red-500/10 text-red-500"
                )}
              >
                {uv?.available ? "Detected" : "Not detected"}
              </Badge>
            }
          >
            <Field label="uv">
              {uv?.available ? (
                <VersionStatus
                  version={uv.version}
                  latestVersion={uv.latestVersion}
                  updateAvailable={uv.updateAvailable}
                />
              ) : (
                <Detail>
                  Not found — install it to enable training &amp; inference.
                </Detail>
              )}
            </Field>

            {uv?.available && (
              <Field label="Python">
                {selectedPythonPath ? (
                  <span className="truncate" title={selectedPythonPath}>
                    {pythonCheck?.version
                      ? `${pythonCheck.version} (selected)`
                      : "Checking..."}
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    Provisioned by uv
                  </span>
                )}
              </Field>
            )}

            <Actions>
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
                  <ArrowUpCircle className="mr-1 h-3 w-3" />
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
                  <Download className="mr-1 h-3 w-3" />
                  Install
                </Button>
              )}
            </Actions>

            {uv?.available && (
              <>
                <button
                  onClick={() => setShowAdvancedPython((v) => !v)}
                  className="mt-0.5 flex w-full items-center gap-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
                >
                  <ChevronRight
                    className={cn(
                      "h-3 w-3 transition-transform",
                      showAdvancedPython && "rotate-90"
                    )}
                  />
                  Interpreters and paths
                </button>

                {showAdvancedPython && (
                  <div className="mt-1 flex flex-col gap-1">
                    <Field label="Interpreter" align="start">
                      {interpreters.length > 0 ? (
                        <Select
                          value={selectedPythonPath ?? ""}
                          onValueChange={(path) => selectPython(path)}
                        >
                          <SelectTrigger className="h-6 text-[10px]">
                            <SelectValue placeholder="uv picks one automatically" />
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
                        <Detail>No Python interpreters found.</Detail>
                      )}
                      {selectedPythonPath && (
                        <Detail title={selectedPythonPath}>
                          {selectedPythonPath}
                        </Detail>
                      )}
                    </Field>

                    {/* sleap-nn in the SELECTED interpreter. Training runs the
                        isolated uv-tool install, not this one, so its absence
                        here is normal — hence info, not an error. */}
                    {selectedPythonPath && pythonCheck && (
                      <Field label="sleap-nn">
                        {pythonCheck.sleapNnVersion ? (
                          <span>v{pythonCheck.sleapNnVersion}</span>
                        ) : sleapNnTool ? (
                          <Detail>
                            Not in this interpreter — training uses the uv-tool
                            install, so this is expected.
                          </Detail>
                        ) : (
                          <Detail>Not installed.</Detail>
                        )}
                      </Field>
                    )}

                    {downloadable.length > 0 && (
                      <Field label="Install">
                        <Select
                          onValueChange={(version) => doInstallPython(version)}
                          disabled={isInstalling}
                        >
                          <SelectTrigger className="h-6 text-[10px]">
                            <SelectValue placeholder="Add a Python version..." />
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
                      </Field>
                    )}

                    {uv.path && (
                      <Field label="uv path">
                        <Detail title={uv.path}>{uv.path}</Detail>
                      </Field>
                    )}
                    {uv.pythonDir && (
                      <Field label="Pythons">
                        <Detail title={uv.pythonDir}>{uv.pythonDir}</Detail>
                      </Field>
                    )}
                  </div>
                )}
              </>
            )}
          </Section>
        )}

        {/* sleap-nn: the training/inference engine. Its accelerator and
            extras are properties OF this install, so they're rows here
            rather than sections of their own. */}
        {detected && uv?.available && (
          <Section
            title="sleap-nn"
            aside={
              sleapNnTool?.version ? (
                <span className="text-xs text-muted-foreground">
                  v{sleapNnTool.version}
                </span>
              ) : null
            }
          >
            <Field label="Status">
              <span className="flex min-w-0 items-center gap-1.5">
                <StatusIcon ok={!!sleapNnTool} />
                {sleapNnTool ? (
                  <>
                    <VersionStatus
                      latestVersion={sleapNnTool.latestVersion}
                      updateAvailable={
                        sleapNnTool.latestVersion
                          ? sleapNnTool.updateAvailable
                          : null
                      }
                    />
                    {sleapNnTool.latestVersion && (
                      <button
                        onClick={() =>
                          openExternal(
                            `${SLEAP_NN_RELEASES_URL}/v${sleapNnTool.latestVersion}`
                          )
                        }
                        title="View release notes"
                        className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                      >
                        <ExternalLink className="h-3 w-3" />
                      </button>
                    )}
                  </>
                ) : (
                  <span className="text-muted-foreground">Not installed</span>
                )}
              </span>
            </Field>

            {sleapNnTool && (
              <>
                <AcceleratorFields
                  info={accelerator}
                  status={acceleratorStatus}
                />
                <ExtrasField
                  extras={extras}
                  status={extrasStatus}
                  accelerator={accelerator}
                  installing={isInstalling}
                  onApply={installExtras}
                />
              </>
            )}

            <Actions>
              <ToolActions
                tool={sleapNnTool}
                installing={
                  isInstalling && (installTarget?.includes("sleap-nn") ?? false)
                }
                onInstall={() => doInstallTool("sleap-nn")}
                onUpgrade={() => doUpgradeTool("sleap-nn")}
                onReinstall={() => doReinstallTool("sleap-nn")}
              />
            </Actions>
          </Section>
        )}

        {/* sleap-rtc: remote-worker transport. One row — it has no
            accelerator or extras of its own. */}
        {detected && uv?.available && (
          <Section
            title="sleap-rtc"
            aside={
              sleapRtcTool?.version ? (
                <span className="text-xs text-muted-foreground">
                  v{sleapRtcTool.version}
                </span>
              ) : null
            }
          >
            <Field label="Status">
              <span className="flex min-w-0 items-center gap-1.5">
                <StatusIcon ok={!!sleapRtcTool} />
                <span
                  className={cn(
                    "truncate",
                    !sleapRtcTool && "text-muted-foreground"
                  )}
                >
                  {sleapRtcTool ? "Installed" : "Not installed"}
                </span>
              </span>
            </Field>
            <Actions>
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
            </Actions>
          </Section>
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
