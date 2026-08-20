/**
 * Getting-started tutorial overlay: a glowing highlight ring around the
 * current step's target element plus a small coachmark card with
 * instructions and an Exit button. No dimming scrim over the rest of the
 * app — same idiom as `SkeletonBuildBar`'s on-canvas bar — since the whole
 * point of a hands-on tutorial is that the user keeps labeling/looking at
 * real frames underneath it, not a greyed-out backdrop. Purely visual/
 * non-blocking (`pointer-events-none` on the highlight ring) — completion is
 * state-driven (see each step's `isComplete` in `lib/tutorial/steps.ts`), not
 * click-position-driven, so the user can interact with the real app normally
 * underneath it. The active step sequence itself (`tutorialSteps`) is
 * resolved once in the store's `startTutorial` — see `buildTutorialSteps`.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, GripVertical, X } from "lucide-react";
import { toast } from "@/lib/notify";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/stores/appStore";
import { useTrainingStore } from "@/stores/trainingStore";
import { useInferenceStore } from "@/stores/inferenceStore";
import {
  snapshotTutorialState,
  TUTORIAL_FIRST_TRAINING_STEP_IDS,
  type TutorialSnapshot,
  type TutorialWatchState,
} from "@/lib/tutorial/steps";
import { useTutorialTargetRect } from "./useTutorialTargetRect";

/** How often to re-check the active step's `isComplete` against stores this
 * overlay doesn't otherwise subscribe to (training/inference status live in
 * their own stores, not appStore) — a small poll instead of hand-listing every
 * cross-store field as a React dependency. */
const RECHECK_INTERVAL_MS = 500;

/**
 * The tutorial forces every loaded training config's epoch count down to a
 * small number during `TUTORIAL_FIRST_TRAINING_STEP_IDS` (steps.ts), so a
 * first-time user's training run finishes in the tutorial rather than taking
 * the real (much longer) default. Applied every recheck tick (not just once)
 * because baseline configs for the selected model type load asynchronously in
 * `TrainingPanel` after the panel mounts, so they may not exist yet the
 * instant this step becomes active.
 */
const TUTORIAL_MAX_EPOCHS = 5;

/**
 * Frame the "Create a skeleton" step jumps to on entry. This tutorial is
 * built around a fixed sample video (mice.mp4) generated with a deterministic
 * Stride/20 suggestion — 1410 is one of the resulting suggestion frames, so
 * drawing the skeleton here always lands on a real suggested frame (letting
 * it double-count toward `LABEL_ONE_FRAME_STEP` if the user creates an
 * instance from it). `setFrameIdx` clamps to the loaded video's last frame,
 * so this is a harmless no-op/best-effort jump on a different or shorter video.
 */
const CREATE_SKELETON_FRAME_IDX = 1410;

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
  return clampToViewport(top, left, card);
}

/** Keep the card fully on-screen, whether auto-placed or user-dragged. */
function clampToViewport(
  top: number,
  left: number,
  card: { width: number; height: number },
) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return {
    top: Math.min(Math.max(top, 8), vh - card.height - 8),
    left: Math.min(Math.max(left, 8), vw - card.width - 8),
  };
}

/** Splits `body` around one occurrence of `link.text`, rendering that slice as an `<a>`. */
function renderBody(body: string, link?: { text: string; href: string }) {
  if (!link) return body;
  const idx = body.indexOf(link.text);
  if (idx === -1) return body;
  return (
    <>
      {body.slice(0, idx)}
      <a
        href={link.href}
        target="_blank"
        rel="noopener noreferrer"
        className="underline hover:text-foreground"
      >
        {link.text}
      </a>
      {body.slice(idx + link.text.length)}
    </>
  );
}

function currentWatchState(): TutorialWatchState {
  const s = useAppStore.getState();
  const training = useTrainingStore.getState();
  const inference = useInferenceStore.getState();
  const anchorConfig = training.config.configs.find(
    (c) => c.slot === "centered_instance",
  );
  return {
    labels: s.labels,
    hasChanges: s.hasChanges,
    skeleton: s.skeleton,
    skeletonBuildMode: s.skeletonBuildMode,
    newProjectDialogOpen: s.newProjectDialogOpen,
    projectLoaded: s.projectLoaded,
    trainingStatus: training.status,
    trainingAnchorPart: anchorConfig?.hyperparams.anchorPart ?? null,
    trainingMaxEpochs: anchorConfig?.hyperparams.maxEpochs ?? null,
    inferenceStatus: inference.status,
  };
}

export function TutorialOverlay() {
  const tutorialActive = useAppStore((s) => s.tutorialActive);
  const tutorialStepIndex = useAppStore((s) => s.tutorialStepIndex);
  const tutorialSteps = useAppStore((s) => s.tutorialSteps);
  const tutorialHighestStepIndex = useAppStore((s) => s.tutorialHighestStepIndex);
  const editSeq = useAppStore((s) => s.editSeq);
  const hasChanges = useAppStore((s) => s.hasChanges);
  const skeletonBuildMode = useAppStore((s) => s.skeletonBuildMode);
  const newProjectDialogOpen = useAppStore((s) => s.newProjectDialogOpen);
  const projectLoaded = useAppStore((s) => s.projectLoaded);

  const step = tutorialActive ? tutorialSteps[tutorialStepIndex] : undefined;
  // A step below the high-water mark was already cleared in this run — Prev
  // is for re-reading it, not for redoing the real action (adding another
  // video, retraining, etc.) just to move forward again. See `advanceTutorialStep`/
  // `tutorialHighestStepIndex` in appStore.ts.
  const isRevisited = tutorialActive && tutorialStepIndex < tutorialHighestStepIndex;
  const entrySnapshotRef = useRef<TutorialSnapshot | null>(null);
  // Mirrors `step.isComplete` so the Next button can reflect it (a ref alone
  // wouldn't trigger a re-render). Reset on every step change — a step you
  // haven't acted on yet always starts incomplete (unless revisited, below).
  const [stepComplete, setStepComplete] = useState(false);

  // New step (or tutorial just started): re-snapshot the baseline to diff against.
  useEffect(() => {
    if (!step) {
      entrySnapshotRef.current = null;
      setStepComplete(false);
      return;
    }
    if (step.id === "create-skeleton") {
      useAppStore.getState().setFrameIdx(CREATE_SKELETON_FRAME_IDX);
    }
    if (isRevisited) {
      entrySnapshotRef.current = null;
      setStepComplete(true);
      return;
    }
    setStepComplete(false);
    entrySnapshotRef.current = snapshotTutorialState(currentWatchState());
  }, [step, tutorialActive, isRevisited]);

  // Re-check completion whenever anything a step might care about changes.
  // Skipped entirely for a revisited step — it's already cleared, and letting
  // this run would either instantly auto-advance it (defeating "go back to
  // re-read") or, for growth/sticky-based steps, never re-satisfy without the
  // user redoing real work.
  useEffect(() => {
    if (!step || isRevisited) return;
    const recheck = () => {
      if (!entrySnapshotRef.current) return;
      const watch = currentWatchState();
      // Sticky flags: once we've seen the skeleton builder open (or training /
      // inference start running) during this step, remember it even after it
      // flips back (see steps.ts doc comments) — otherwise a step that reads
      // "completed" from an earlier run before the user acts again would
      // instantly satisfy isComplete.
      entrySnapshotRef.current.everEnteredSkeletonBuild =
        entrySnapshotRef.current.everEnteredSkeletonBuild || watch.skeletonBuildMode;
      entrySnapshotRef.current.everTraining =
        entrySnapshotRef.current.everTraining || watch.trainingStatus === "running";
      entrySnapshotRef.current.everInferenceRunning =
        entrySnapshotRef.current.everInferenceRunning ||
        watch.inferenceStatus === "running";
      if (TUTORIAL_FIRST_TRAINING_STEP_IDS.has(step.id)) {
        const training = useTrainingStore.getState();
        for (const cf of training.config.configs) {
          if (cf.hyperparams.maxEpochs !== TUTORIAL_MAX_EPOCHS) {
            training.updateConfigHyperparams(cf.slot, {
              maxEpochs: TUTORIAL_MAX_EPOCHS,
            });
          }
        }
      }
      const complete = step.isComplete(entrySnapshotRef.current, watch);
      setStepComplete(complete);
      if (complete) {
        useAppStore.getState().advanceTutorialStep();
      }
    };
    recheck();
    // Training/inference status live in their own stores (trainingStore /
    // inferenceStore), not appStore, so this effect's dependency list can't
    // reactively cover them — poll as a fallback instead of hand-listing every
    // cross-store field here.
    const intervalId = setInterval(recheck, RECHECK_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [step, isRevisited, editSeq, hasChanges, skeletonBuildMode, newProjectDialogOpen, projectLoaded]);

  const targetRect = useTutorialTargetRect(step?.targetSelector ?? null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardSize, setCardSize] = useState(DEFAULT_CARD_SIZE);
  // Collapsed-by-default supplementary reference (e.g. "Label tips"). Reset on
  // every step change so a step you already expanded doesn't carry that state
  // into the next, unrelated step's tips.
  const [tipsOpen, setTipsOpen] = useState(false);

  // Manual drag offset from the auto-computed position, so the card can be
  // pulled off a target it happens to be covering (e.g. a canvas control).
  // Reset on every step change — a drag on one step shouldn't carry over to
  // the next step's (differently placed) target.
  const [dragOffset, setDragOffset] = useState({ dx: 0, dy: 0 });
  const dragStateRef = useRef<{
    startX: number;
    startY: number;
    startOffset: { dx: number; dy: number };
  } | null>(null);

  useEffect(() => {
    setDragOffset({ dx: 0, dy: 0 });
    setTipsOpen(false);
  }, [step]);

  useLayoutEffect(() => {
    if (!cardRef.current) return;
    const r = cardRef.current.getBoundingClientRect();
    if (r.width && r.height) setCardSize({ width: r.width, height: r.height });
  }, [step, targetRect, tipsOpen]);

  const handleDragPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStateRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startOffset: dragOffset,
    };
  };
  const handleDragPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const ds = dragStateRef.current;
    if (!ds) return;
    setDragOffset({
      dx: ds.startOffset.dx + (e.clientX - ds.startX),
      dy: ds.startOffset.dy + (e.clientY - ds.startY),
    });
  };
  const handleDragPointerUp = () => {
    dragStateRef.current = null;
  };

  if (!step) return null;

  const stepNumber = tutorialStepIndex + 1;
  const autoCardPos = targetRect
    ? computeCardPosition(targetRect, step.placement, cardSize)
    : { top: window.innerHeight / 2 - cardSize.height / 2, left: window.innerWidth / 2 - cardSize.width / 2 };
  const cardPos = clampToViewport(
    autoCardPos.top + dragOffset.dy,
    autoCardPos.left + dragOffset.dx,
    cardSize,
  );

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
            boxShadow: "0 0 0 2px var(--primary), 0 0 16px 3px var(--primary)",
            pointerEvents: "none",
          }}
        />
      )}
      <div
        ref={cardRef}
        data-tutorial-overlay
        className="fixed z-[9998] w-[300px] rounded-md border border-border bg-popover p-3 text-sm text-popover-foreground shadow-lg pointer-events-auto"
        style={{ top: cardPos.top, left: cardPos.left }}
      >
        <div className="flex items-start justify-between gap-2">
          <div
            className="flex touch-none select-none items-center gap-1 cursor-grab active:cursor-grabbing"
            onPointerDown={handleDragPointerDown}
            onPointerMove={handleDragPointerMove}
            onPointerUp={handleDragPointerUp}
            onPointerCancel={handleDragPointerUp}
          >
            <GripVertical className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-medium text-muted-foreground">
              Step {stepNumber} of {tutorialSteps.length}
            </span>
          </div>
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
        <p className="mt-1 text-muted-foreground leading-relaxed whitespace-pre-line">
          {renderBody(step.body, step.bodyLink)}
        </p>
        {step.tips && (
          <div className="mt-2">
            <button
              type="button"
              className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              aria-expanded={tipsOpen}
              onClick={() => setTipsOpen((open) => !open)}
            >
              {tipsOpen ? (
                <ChevronUp className="h-3 w-3" />
              ) : (
                <ChevronDown className="h-3 w-3" />
              )}
              {step.tips.label}
            </button>
            {tipsOpen && (
              <p className="mt-1 text-xs text-muted-foreground leading-relaxed whitespace-pre-line">
                {step.tips.text}
              </p>
            )}
          </div>
        )}
        {!targetRect && (
          <p className="mt-2 text-xs text-muted-foreground italic">
            Looking for the highlighted control…
          </p>
        )}
        <div className="mt-3 flex items-center justify-between gap-2">
          <Button
            variant="outline"
            size="xs"
            disabled={tutorialStepIndex === 0}
            onClick={() => useAppStore.getState().previousTutorialStep()}
          >
            <ChevronLeft className="h-3 w-3" />
            Prev
          </Button>
          <Button
            size="xs"
            className={!stepComplete ? "opacity-50" : undefined}
            onClick={() => {
              if (!stepComplete) {
                toast.warning("Not done yet", {
                  description: `Finish "${step.title}" before moving on.`,
                });
                return;
              }
              useAppStore.getState().advanceTutorialStep();
            }}
          >
            {tutorialStepIndex === tutorialSteps.length - 1 ? "Finish" : "Next"}
            <ChevronRight className="h-3 w-3" />
          </Button>
        </div>
      </div>
    </>
  );
}
