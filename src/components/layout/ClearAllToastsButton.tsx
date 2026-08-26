import { useSonner } from "sonner";
import { X } from "lucide-react";
import { dismiss } from "@/lib/notify";

/**
 * Compact "Clear all" pill anchored just beneath the live toast stack. Shown
 * only when 2+ toasts are stacked; clicking dismisses the whole on-screen stack
 * (sonner's dismiss-all). Intentionally does NOT touch the persistent
 * Notifications panel history — that panel has its own Clear control.
 */
export function ClearAllToastsButton() {
  const { toasts } = useSonner();
  const count = toasts.length;
  if (count < 2) return null;
  return (
    <div className="fixed bottom-4 right-6 z-[9999] flex w-[356px] justify-center pointer-events-none">
      <button
        type="button"
        onClick={() => dismiss()}
        className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-border bg-card px-4 py-1.5 text-sm font-medium text-muted-foreground shadow-md transition-colors hover:bg-accent hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
        Clear all ({count})
      </button>
    </div>
  );
}
