/**
 * Panel gate for workflows that still need exactly one skeleton (training,
 * inference, Label QC). On a project with several skeletons it shows a clear
 * "not supported yet" message instead of the panel, so none of the panel's
 * single-skeleton code (`labels.skeletons[0]`, the active skeleton's nodes)
 * runs and silently picks the wrong skeleton.
 */

import { useEffect, type ReactNode } from "react";
import { useAppStore } from "../../stores/appStore";
import { hasMultipleSkeletons, multiSkeletonMessage } from "@/lib/multiSkeleton";

export function SingleSkeletonGate({
  feature,
  configRequest,
  children,
}: {
  /** Feature name for the message, e.g. "Training". */
  feature: string;
  /** Menu "open with full configuration" request this panel would consume. */
  configRequest?: "training" | "inference";
  children: ReactNode;
}) {
  const multi = useAppStore((s) => hasMultipleSkeletons(s.labels));
  const skeletonCount = useAppStore((s) => s.labels?.skeletons.length ?? 0);
  const pendingRequest = useAppStore((s) => s.configDialogRequest);

  // The menu's "Training…/Inference…" asks this panel to open its config
  // window; while gated, drop that request so it doesn't fire later.
  useEffect(() => {
    if (multi && configRequest && pendingRequest === configRequest) {
      useAppStore.getState().set("configDialogRequest", null);
    }
  }, [multi, configRequest, pendingRequest]);

  if (!multi) return <>{children}</>;
  return (
    <div className="p-3 text-xs space-y-1.5" data-testid="multi-skeleton-gate">
      <p className="font-medium text-foreground">{multiSkeletonMessage(feature)}</p>
      <p className="text-muted-foreground">
        This project has {skeletonCount} skeletons. {feature} currently works on
        projects with one skeleton; per-skeleton support is planned.
      </p>
    </div>
  );
}
