/**
 * Shared close-button styling for a panel header — used by both the real
 * sidebar's panel header (AppShell.tsx) and standalone panel-style overlays
 * like WelcomeEnvironmentsPanel.tsx, so the two can't drift apart.
 */

import { X } from "lucide-react";

export function PanelCloseButton({
  onClick,
  label,
}: {
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors shrink-0"
    >
      <X className="h-3.5 w-3.5" />
    </button>
  );
}
