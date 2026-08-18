/**
 * On-canvas prompt shown while picking a top-down anchor node for the
 * Training panel. Self-guards to `pickingAnchor` (mirrors SkeletonBuildBar's
 * pattern) — always rendered, shows nothing outside the mode.
 *
 * VideoPlayer's own pointer handlers own the actual node hit-testing and
 * resolve the pick (`resolveAnchorPick`); this component is just the
 * cancel affordance (button + Escape).
 */

import { useEffect } from "react";
import { useAppStore } from "@/stores/appStore";
import { Button } from "@/components/ui/button";

export function AnchorPickBar() {
  const pickingAnchor = useAppStore((s) => s.pickingAnchor);

  useEffect(() => {
    if (!pickingAnchor) return;
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      useAppStore.getState().cancelAnchorPick();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pickingAnchor]);

  if (!pickingAnchor) return null;

  return (
    <div className="absolute top-2 left-1/2 -translate-x-1/2 z-30 flex items-center gap-1.5 rounded-md bg-black/70 px-2 py-1.5 shadow-lg backdrop-blur-sm pointer-events-auto">
      <span className="px-1 text-xs font-medium text-white/90">
        Click a keypoint to set as anchor
      </span>
      <Button
        variant="secondary"
        size="xs"
        className="pointer-events-auto bg-white/10 text-white/85 border-none hover:bg-white/20 hover:text-white"
        onClick={() => useAppStore.getState().cancelAnchorPick()}
      >
        Cancel
      </Button>
    </div>
  );
}
