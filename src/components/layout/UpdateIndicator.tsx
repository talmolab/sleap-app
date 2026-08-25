/**
 * Shared "something needs attention" visual language for the Environment
 * update badge — used by both the sidebar icon rail (AppShell.tsx) and the
 * Welcome screen's corner button (WelcomeScreen.tsx), so the two stay
 * visually identical without needing to be edited in lockstep.
 */

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/appStore";
import { useEnvironmentStore } from "@/stores/environmentStore";

/**
 * Combines every "something needs attention" signal the Environment badge
 * cares about — a newer stable release, a newer latest (pre-)release, or a
 * newer sleap-nn — into one available/title pair. Shared so the sidebar icon
 * rail and the Welcome screen's corner button can't compute this
 * inconsistently with each other.
 */
export function useEnvironmentUpdateStatus() {
  const stableUpdateAvailable = useAppStore((s) => s.stableUpdateAvailable);
  const stableUpdateVersion = useAppStore((s) => s.stableUpdateVersion);
  const latestUpdateAvailable = useAppStore((s) => s.latestUpdateAvailable);
  const latestUpdateVersion = useAppStore((s) => s.latestUpdateVersion);
  const sleapNnUpdateAvailable = useEnvironmentStore(
    (s) => s.tools.find((t) => t.name === "sleap-nn")?.updateAvailable ?? false
  );

  const available =
    stableUpdateAvailable || latestUpdateAvailable || sleapNnUpdateAvailable;

  const title =
    stableUpdateAvailable && stableUpdateVersion
      ? `SLEAP v${stableUpdateVersion} is available`
      : latestUpdateAvailable && latestUpdateVersion
        ? `SLEAP v${latestUpdateVersion} is available (latest channel)`
        : sleapNnUpdateAvailable
          ? "sleap-nn update available"
          : undefined;

  return { available, title };
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

/** Small highlighted, pulsing text pill. */
export function UpdatePill({
  children,
  title,
}: {
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className="shrink-0 rounded-full bg-orange-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-orange-500 animate-pulse"
    >
      {children}
    </span>
  );
}
