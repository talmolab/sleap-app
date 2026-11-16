/**
 * Panel gate for workflows that still need exactly one skeleton (training,
 * inference, Label QC). On a project that really uses several DIFFERENT
 * skeletons it shows a clear "not supported yet" message instead of the panel,
 * so none of the panel's single-skeleton code (`labels.skeletons[0]`, the active
 * skeleton's nodes) runs and silently picks the wrong skeleton.
 *
 * Identical duplicate skeletons (old files, merges) don't count: those projects
 * see the panel exactly as before. A job that's already running (or finished
 * and still showing its results) stays visible with a note on top — only
 * starting a NEW run is refused (the stores guard that too).
 */

import { useEffect, useMemo, type ReactNode } from "react";
import { useAppStore } from "../../stores/appStore";
import { distinctSkeletonCount, multiSkeletonMessage } from "@/lib/multiSkeleton";

export function SingleSkeletonGate({
  feature,
  configRequest,
  busy = false,
  children,
}: {
  /** Feature name for the message, e.g. "Training". */
  feature: string;
  /** Menu "open with full configuration" request this panel would consume. */
  configRequest?: "training" | "inference";
  /** A job is running or showing results: keep the panel mounted. */
  busy?: boolean;
  children: ReactNode;
}) {
  const labels = useAppStore((s) => s.labels);
  const active = useAppStore((s) => s.skeleton);
  // Instances' skeletons change on edits (editSeq) and undo (overlayVersion);
  // the skeleton list on Add/undo. Recount only then, not on every store tick.
  const editSeq = useAppStore((s) => s.editSeq);
  const overlayVersion = useAppStore((s) => s.overlayVersion);
  const skeletonObjects = useAppStore((s) => s.labels?.skeletons.length ?? 0);
  const distinct = useMemo(
    () => distinctSkeletonCount(labels, active),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [labels, active, editSeq, overlayVersion, skeletonObjects]
  );
  const multi = distinct > 1;
  const pendingRequest = useAppStore((s) => s.configDialogRequest);

  // The menu's "Training…/Inference…" asks this panel to open its config
  // window; while gated, drop that request so it doesn't fire later.
  useEffect(() => {
    if (multi && !busy && configRequest && pendingRequest === configRequest) {
      useAppStore.getState().set("configDialogRequest", null);
    }
  }, [multi, busy, configRequest, pendingRequest]);

  if (!multi) return <>{children}</>;
  if (busy) {
    return (
      <div className="flex flex-col h-full min-h-0">
        <p
          className="px-2 py-1.5 text-[11px] text-amber-500 border-b border-border"
          data-testid="multi-skeleton-busy-note"
        >
          {multiSkeletonMessage(feature)} This job keeps running; new runs are
          disabled.
        </p>
        <div className="flex-1 min-h-0">{children}</div>
      </div>
    );
  }
  return (
    <div className="p-3 text-xs space-y-1.5" data-testid="multi-skeleton-gate">
      <p className="font-medium text-foreground">{multiSkeletonMessage(feature)}</p>
      <p className="text-muted-foreground">
        This project has {distinct} different skeletons. {feature} currently
        works on projects with one skeleton; per-skeleton support is planned.
      </p>
    </div>
  );
}
