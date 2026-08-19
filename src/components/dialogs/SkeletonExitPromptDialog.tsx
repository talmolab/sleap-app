import { useAppStore } from "../../stores/appStore";

/**
 * "Keep or discard?" prompt for an unplanned exit from the visual skeleton
 * builder (e.g. switching away from the Skeleton panel mid-draw) that left
 * unfinished work — nodes/edges added since the builder was entered.
 *
 * Rendered globally (mounted once in App.tsx) rather than inside
 * SkeletonPanel, since the panel that triggered this may already be
 * unmounted by the time it needs to show.
 */
export function SkeletonExitPromptDialog() {
  const prompt = useAppStore((s) => s.skeletonExitPrompt);

  if (!prompt) return null;

  const resolve = (keep: boolean) => {
    useAppStore.getState().resolveSkeletonExitPrompt(keep);
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50">
      <div className="bg-card border border-border rounded-lg p-6 shadow-lg max-w-sm mx-4">
        <h3 className="text-sm font-semibold mb-2">Unfinished Skeleton Draft</h3>
        <p className="text-sm text-muted-foreground mb-4">
          You switched away from the Skeleton tab while still drawing. Keep
          the nodes/edges you'd added, or discard them back to how the
          skeleton was before you started?
        </p>
        <div className="flex justify-end gap-2">
          <button
            className="px-3 py-1.5 text-xs rounded bg-destructive text-destructive-foreground hover:bg-destructive/80"
            onClick={() => resolve(false)}
          >
            Discard
          </button>
          <button
            className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/80"
            onClick={() => resolve(true)}
          >
            Keep
          </button>
        </div>
      </div>
    </div>
  );
}
