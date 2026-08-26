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
    <div className="fixed bottom-4 right-4 z-[9999] flex justify-end pointer-events-none">
      <button
        type="button"
        onClick={() => dismiss()}
        className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-border bg-card/95 px-3 py-1 text-xs font-medium text-muted-foreground shadow-md backdrop-blur transition-colors hover:bg-card hover:text-foreground"
      >
        <X className="h-3 w-3" />
        Clear all ({count})
      </button>
    </div>
  );
}
