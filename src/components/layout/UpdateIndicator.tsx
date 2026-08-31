/**
 * Shared "something needs attention" visual language for the Environment
 * update badge — used by both the sidebar icon rail (AppShell.tsx) and the
 * Welcome screen's corner button (WelcomeScreen.tsx), so the two stay
 * visually identical without needing to be edited in lockstep.
 */

import type { ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/appStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { isTauri } from "@/platform/index";

export interface EnvironmentUpdateStatusInput {
  isTauri: boolean;
  uvAvailable: boolean | null; // null = not checked yet (see computeEnvironmentUpdateStatus)
  sleapNnInstalled: boolean;
  sleapNnUpdateAvailable: boolean;
  packagesSetupNudgeDismissed: boolean;
  stableUpdateAvailable: boolean;
  stableUpdateVersion: string | null;
  latestUpdateAvailable: boolean;
  latestUpdateVersion: string | null;
  hasOptedIntoLatestChannel: boolean;
}

export interface EnvironmentUpdateStatus {
  available: boolean;
  title: string | undefined;
  label: string;
  showSetupNudge: boolean;
}

/**
 * Combines every "something needs attention" signal the Environment badge
 * cares about — uv/sleap-nn not being set up at all, a newer stable release,
 * a newer latest (pre-)release, or a newer sleap-nn — into one
 * available/title/label triple. Pure function (no store reads) so it can be
 * unit tested directly; useEnvironmentUpdateStatus below just wires the two
 * stores' values into it.
 *
 * "latest" only contributes once the user has EVER selected it at least
 * once (appStore's hasOptedIntoLatestChannel, sticky — stays true even after
 * switching back to "stable"): by default the badge reflects "stable" only,
 * so someone who's never asked for anything but stable releases doesn't get
 * nagged about a pre-release they never opted into.
 *
 * The "install packages" setup nudge takes priority over all update signals
 * when it applies — training/inference not working at all is more
 * fundamental than a newer version being available — and is gated three
 * ways: desktop only (`uv`/`sleap-nn` are meaningless in the browser build),
 * only once `uv` has actually been checked (`uvAvailable === null` means
 * "not checked yet," not "missing," and must not flash the nudge before
 * that resolves — see App.tsx's startup call to
 * checkSleapNnUpdateAndNotify), and never once dismissed
 * (packagesSetupNudgeDismissed is a permanent opt-out, not a snooze — see
 * its own comment in appStore.ts).
 */
export function computeEnvironmentUpdateStatus(
  input: EnvironmentUpdateStatusInput
): EnvironmentUpdateStatus {
  const {
    isTauri,
    uvAvailable,
    sleapNnInstalled,
    sleapNnUpdateAvailable,
    packagesSetupNudgeDismissed,
    stableUpdateAvailable,
    stableUpdateVersion,
    latestUpdateAvailable,
    latestUpdateVersion,
    hasOptedIntoLatestChannel,
  } = input;

  const latestCounts = hasOptedIntoLatestChannel && latestUpdateAvailable;

  const packagesSetupNeeded =
    isTauri && uvAvailable !== null && (!uvAvailable || !sleapNnInstalled);
  const showSetupNudge = packagesSetupNeeded && !packagesSetupNudgeDismissed;

  const available =
    showSetupNudge ||
    stableUpdateAvailable ||
    latestCounts ||
    sleapNnUpdateAvailable;

  const title = showSetupNudge
    ? !uvAvailable
      ? "uv isn't installed — click to set up your Python environment for training/inference"
      : "sleap-nn isn't installed — click to set it up for training/inference"
    : stableUpdateAvailable && stableUpdateVersion
      ? `SLEAP v${stableUpdateVersion} is available`
      : latestCounts && latestUpdateVersion
        ? `SLEAP v${latestUpdateVersion} is available (latest channel)`
        : sleapNnUpdateAvailable
          ? "sleap-nn update available"
          : undefined;

  const label = showSetupNudge ? "Install packages" : "Update available";

  return { available, title, label, showSetupNudge };
}

/** React-wired version of computeEnvironmentUpdateStatus — reads both
 * stores and adds onDismiss. Shared so the sidebar icon rail and the
 * Welcome screen's corner button can't compute this inconsistently with
 * each other. */
export function useEnvironmentUpdateStatus() {
  const stableUpdateAvailable = useAppStore((s) => s.stableUpdateAvailable);
  const stableUpdateVersion = useAppStore((s) => s.stableUpdateVersion);
  const latestUpdateAvailable = useAppStore((s) => s.latestUpdateAvailable);
  const latestUpdateVersion = useAppStore((s) => s.latestUpdateVersion);
  const hasOptedIntoLatestChannel = useAppStore(
    (s) => s.hasOptedIntoLatestChannel
  );
  const packagesSetupNudgeDismissed = useAppStore(
    (s) => s.packagesSetupNudgeDismissed
  );
  const dismissPackagesSetupNudge = useAppStore(
    (s) => s.dismissPackagesSetupNudge
  );
  const uv = useEnvironmentStore((s) => s.uv);
  const sleapNnTool = useEnvironmentStore((s) =>
    s.tools.find((t) => t.name === "sleap-nn")
  );

  const { available, title, label, showSetupNudge } =
    computeEnvironmentUpdateStatus({
      isTauri,
      uvAvailable: uv === null ? null : uv.available,
      sleapNnInstalled: !!sleapNnTool,
      sleapNnUpdateAvailable: sleapNnTool?.updateAvailable ?? false,
      packagesSetupNudgeDismissed,
      stableUpdateAvailable,
      stableUpdateVersion,
      latestUpdateAvailable,
      latestUpdateVersion,
      hasOptedIntoLatestChannel,
    });

  return {
    available,
    title,
    label,
    onDismiss: showSetupNudge ? dismissPackagesSetupNudge : undefined,
  };
}

/** Small pulsing "live" dot, absolutely positioned over an icon. Pass a
 * `className` to place it (e.g. "top-1 right-1.5") for the given icon size. */
export function UpdatePingDot({ className }: { className?: string }) {
  return (
    <span className={cn("absolute flex h-2 w-2", className)}>
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-orange-400 opacity-75" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-orange-500" />
    </span>
  );
}

/** Small highlighted, pulsing text pill. `onDismiss` (only ever passed for
 * the "install packages" setup nudge, never a plain update) adds an inline
 * "×" that stops propagation before firing — both call sites render this
 * pill inside a button that opens the Environment panel, and dismissing
 * must not also trigger that. */
export function UpdatePill({
  children,
  title,
  onDismiss,
}: {
  children: ReactNode;
  title?: string;
  onDismiss?: () => void;
}) {
  return (
    <span
      title={title}
      className="shrink-0 inline-flex items-center gap-1 rounded-full bg-orange-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-orange-500 animate-pulse"
    >
      {children}
      {onDismiss && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
          title="Don't show this again"
          className="leading-none hover:text-orange-300"
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
    </span>
  );
}
