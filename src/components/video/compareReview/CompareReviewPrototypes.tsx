/**
 * Review prototypes (dev builds only, behind a switch — see
 * lib/modelOverlay/reviewPrototype.ts): a small bar at the bottom-left of the
 * video to open each candidate review window, and to load mock models so they
 * can be tried on any project. Renders nothing unless the switch is on.
 */
import { useState } from "react";
import { FlaskConical } from "lucide-react";
import { useAppStore } from "@/stores/appStore";
import { useModelOverlayStore } from "@/stores/modelOverlayStore";
import { useCompareReviewStore } from "@/stores/compareReviewStore";
import { toast } from "@/lib/notify";
import {
  makeMockModels,
  readReviewSwitch,
  REVIEW_LAYOUT_NAMES,
  REVIEW_LAYOUTS,
} from "@/lib/modelOverlay/reviewPrototype";
import { ReviewStepperPrototype } from "./ReviewStepperPrototype";
import { ReviewPanesPrototype } from "./ReviewPanesPrototype";
import { ReviewGridPrototype } from "./ReviewGridPrototype";

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export default function CompareReviewPrototypes() {
  const [{ on, layout: preferred }] = useState(() => readReviewSwitch(window.location.search, safeStorage()));
  const open = useCompareReviewStore((s) => s.open);
  const setOpen = useCompareReviewStore((s) => s.setOpen);
  const modelCount = useModelOverlayStore((s) => s.models.length);
  const video = useAppStore((s) => s.video);
  const [busy, setBusy] = useState(false);
  if (!on || !video) return null;

  const loadMocks = () => {
    const { labels, video: v, skeleton } = useAppStore.getState();
    if (!labels || !v || !skeleton) {
      toast.info("Open a project with a skeleton first");
      return;
    }
    setBusy(true);
    // Let the button repaint before the (short) work.
    setTimeout(() => {
      try {
        useModelOverlayStore.getState().addModels(labels, makeMockModels(labels, v, skeleton));
        toast.info("Loaded 5 mock models. Accepting a mock pose only records the choice; nothing is written to the project. × in the corner panel removes them.");
      } finally {
        setBusy(false);
      }
    }, 0);
  };
  const close = () => setOpen(null);

  return (
    <>
      <div
        className="absolute bottom-2 left-2 z-30 flex items-center gap-1 rounded-md border border-amber-500/50 bg-black/80 px-1.5 py-1 text-[11px] text-white shadow-lg pointer-events-auto"
        data-testid="review-proto-bar"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <FlaskConical className="h-3 w-3 text-amber-400" />
        <span className="text-amber-300">Review prototypes</span>
        {REVIEW_LAYOUTS.map((l) => (
          <button
            key={l}
            type="button"
            className={`rounded px-1.5 py-0.5 ${open === l ? "bg-amber-500 text-black" : l === preferred ? "bg-white/20" : "bg-white/10"} hover:bg-amber-400 hover:text-black disabled:opacity-40`}
            onClick={() => setOpen(open === l ? null : l)}
            disabled={modelCount === 0}
            title={modelCount === 0 ? "Load models first (Predict ▸ Compare Model Predictions…, or mock models)" : undefined}
          >
            {REVIEW_LAYOUT_NAMES[l]}
          </button>
        ))}
        <span className="mx-0.5 h-3 w-px bg-white/30" />
        <button type="button" className="rounded bg-white/10 px-1.5 py-0.5 hover:bg-white/25 disabled:opacity-40" onClick={loadMocks} disabled={busy}>
          {busy ? "Loading…" : "Load mock models"}
        </button>
      </div>
      {open === "stepper" && <ReviewStepperPrototype onClose={close} />}
      {open === "panes" && <ReviewPanesPrototype onClose={close} />}
      {open === "grid" && <ReviewGridPrototype onClose={close} />}
    </>
  );
}
