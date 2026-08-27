/**
 * Right-docked Environments panel for the Welcome screen (no project loaded
 * yet). Deliberately mirrors the "Environment" section's markup in the real
 * sidebar (see the Sidebar component in AppShell.tsx) — same header height,
 * label style, and close-button styling — so it doesn't read as a different
 * surface once a project is open and the same panel lives in the sidebar.
 */

import { EnvironmentPanel } from "../panels/EnvironmentPanel";
import { PanelCloseButton } from "./PanelCloseButton";

interface WelcomeEnvironmentsPanelProps {
  onClose: () => void;
}

export function WelcomeEnvironmentsPanel({
  onClose,
}: WelcomeEnvironmentsPanelProps) {
  return (
    <div
      className="absolute top-0 right-0 z-20 h-full flex flex-col bg-card border-l border-border shadow-xl"
      style={{ width: 320 }}
    >
      {/* Section header — same markup as Sidebar's panel header. */}
      <div className="flex items-center h-9 pl-2 pr-1.5 border-b border-border shrink-0">
        <span className="flex-1 min-w-0 text-sm font-medium text-foreground tracking-wide truncate">
          Environment
        </span>
        <PanelCloseButton onClick={onClose} label="Close Environment panel" />
      </div>
      {/* Section body */}
      <div className="flex-1 overflow-auto p-2 min-h-0">
        <EnvironmentPanel />
      </div>
    </div>
  );
}
