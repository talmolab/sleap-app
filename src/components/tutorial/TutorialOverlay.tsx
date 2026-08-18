/**
 * Getting-started tutorial overlay: a spotlight over the current step's
 * target element plus a small coachmark card with instructions and an Exit
 * button. Purely visual/non-blocking (`pointer-events-none` on the scrim) —
 * completion is state-driven (see each step's `isComplete` in
 * `lib/tutorial/steps.ts`), not click-position-driven, so the user can
 * interact with the real app normally underneath it. The active step
 * sequence itself (`tutorialSteps`) is resolved once in the store's
 * `startTutorial` — see `buildTutorialSteps`.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useAppStore } from "@/stores/appStore";
import {
  snapshotTutorialState,
  type TutorialSnapshot,
  type TutorialWatchState,
} from "@/lib/tutorial/steps";
import { useTutorialTargetRect } from "./useTutorialTargetRect";

const SPOTLIGHT_PADDING = 6;
const CARD_GAP = 12;
const DEFAULT_CARD_SIZE = { width: 300, height: 150 };

function computeCardPosition(
  rect: { top: number; left: number; width: number; height: number },
  placement: "top" | "bottom" | "left" | "right",
  card: { width: number; height: number },
) {
  let top: number;
  let left: number;
  switch (placement) {
    case "top":
      top = rect.top - card.height - CARD_GAP;
      left = rect.left + rect.width / 2 - card.width / 2;
      break;
    case "bottom":
      top = rect.top + rect.height + CARD_GAP;
      left = rect.left + rect.width / 2 - card.width / 2;
      break;
    case "right":
      top = rect.top + rect.height / 2 - card.height / 2;
      left = rect.left + rect.width + CARD_GAP;
      break;
    case "left":
    default:
      top = rect.top + rect.height / 2 - card.height / 2;
      left = rect.left - card.width - CARD_GAP;
      break;
  }
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  left = Math.min(Math.max(left, 8), vw - card.width - 8);
  top = Math.min(Math.max(top, 8), vh - card.height - 8);
  return { top, left };
}

function currentWatchState(): TutorialWatchState {
  const s = useAppStore.getState();
  return {
    labels: s.labels,
    hasChanges: s.hasChanges,
    skeleton: s.skeleton,
    skeletonBuildMode: s.skeletonBuildMode,
    newProjectDialogOpen: s.newProjectDialogOpen,
    projectLoaded: s.projectLoaded,
  };
}

export function TutorialOverlay() {
  const tutorialActive = useAppStore((s) => s.tutorialActive);
  const tutorialStepIndex = useAppStore((s) => s.tutorialStepIndex);
  const tutorialSteps = useAppStore((s) => s.tutorialSteps);
  const editSeq = useAppStore((s) => s.editSeq);
  const hasChanges = useAppStore((s) => s.hasChanges);
  const skeletonBuildMode = useAppStore((s) => s.skeletonBuildMode);
  const newProjectDialogOpen = useAppStore((s) => s.newProjectDialogOpen);
  const projectLoaded = useAppStore((s) => s.projectLoaded);

  const step = tutorialActive ? tutorialSteps[tutorialStepIndex] : undefined;
  const entrySnapshotRef = useRef<TutorialSnapshot | null>(null);

  // New step (or tutorial just started): re-snapshot the baseline to diff against.
  useEffect(() => {
    if (!step) {
      entrySnapshotRef.current = null;
      return;
    }
    entrySnapshotRef.current = snapshotTutorialState(currentWatchState());
  }, [step, tutorialActive]);

  // Re-check completion whenever anything a step might care about changes.
  useEffect(() => {
    if (!step || !entrySnapshotRef.current) return;
    const watch = currentWatchState();
    // Sticky: once we've seen the skeleton builder open during this step,
    // remember it even after it closes again (see steps.ts doc comment).
    entrySnapshotRef.current.everEnteredSkeletonBuild =
      entrySnapshotRef.current.everEnteredSkeletonBuild || watch.skeletonBuildMode;
    if (step.isComplete(entrySnapshotRef.current, watch)) {
      useAppStore.getState().advanceTutorialStep();
    }
  }, [step, editSeq, hasChanges, skeletonBuildMode, newProjectDialogOpen, projectLoaded]);

  const targetRect = useTutorialTargetRect(step?.targetSelector ?? null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardSize, setCardSize] = useState(DEFAULT_CARD_SIZE);

  useLayoutEffect(() => {
    if (!cardRef.current) return;
    const r = cardRef.current.getBoundingClientRect();
    if (r.width && r.height) setCardSize({ width: r.width, height: r.height });
  }, [step, targetRect]);

  if (!step) return null;

  const stepNumber = tutorialStepIndex + 1;
  const cardPos = targetRect
    ? computeCardPosition(targetRect, step.placement, cardSize)
    : { top: window.innerHeight / 2 - cardSize.height / 2, left: window.innerWidth / 2 - cardSize.width / 2 };

  return (
    <>
      {targetRect && (
        <div
          className="fixed z-[9998] rounded-md transition-[top,left,width,height] duration-150"
          style={{
            top: targetRect.top - SPOTLIGHT_PADDING,
            left: targetRect.left - SPOTLIGHT_PADDING,
            width: targetRect.width + SPOTLIGHT_PADDING * 2,
            height: targetRect.height + SPOTLIGHT_PADDING * 2,
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)",
            pointerEvents: "none",
          }}
        />
      )}
      <div
        ref={cardRef}
        className="fixed z-[9998] w-[300px] rounded-md border border-border bg-popover p-3 text-sm text-popover-foreground shadow-lg"
        style={{ top: cardPos.top, left: cardPos.left }}
      >
        <div className="flex items-start justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            Step {stepNumber} of {tutorialSteps.length}
          </span>
          <button
            type="button"
            aria-label="Exit tutorial"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => useAppStore.getState().exitTutorial()}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <p className="mt-1 font-semibold">{step.title}</p>
        <p className="mt-1 text-muted-foreground leading-relaxed">{step.body}</p>
        {!targetRect && (
          <p className="mt-2 text-xs text-muted-foreground italic">
            Looking for the highlighted control…
          </p>
        )}
      </div>
    </>
  );
}
