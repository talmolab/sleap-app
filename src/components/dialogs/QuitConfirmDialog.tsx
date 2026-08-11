import { useAppStore } from "../../stores/appStore";
import { resolveQuitConfirm } from "../../lib/quit";

export function QuitConfirmDialog() {
  const open = useAppStore((s) => s.quitConfirmOpen);

  if (!open) return null;

  const handleResponse = (confirmed: boolean) => {
    useAppStore.getState().set("quitConfirmOpen", false);
    resolveQuitConfirm(confirmed);
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50">
      <div className="bg-card border border-border rounded-lg p-6 shadow-lg max-w-sm mx-4">
        <h3 className="text-sm font-semibold mb-2">Unsaved Changes</h3>
        <p className="text-sm text-muted-foreground mb-4">
          You have unsaved changes that will be lost. Discard them and continue?
        </p>
        <div className="flex justify-end gap-2">
          <button
            className="px-3 py-1.5 text-xs rounded bg-secondary text-secondary-foreground hover:bg-secondary/80"
            onClick={() => handleResponse(false)}
          >
            Cancel
          </button>
          <button
            className="px-3 py-1.5 text-xs rounded bg-destructive text-destructive-foreground hover:bg-destructive/80"
            onClick={() => handleResponse(true)}
          >
            Discard Changes
          </button>
        </div>
      </div>
    </div>
  );
}
