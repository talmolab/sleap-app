/**
 * Shown once the tutorial's last step completes (`tutorialCompleted` in
 * appStore) — not on Exit — so finishing the walkthrough ends on a clear
 * "you're done" with pointers for what to do next, instead of the coachmark
 * just disappearing. Same card styling as `TutorialOverlay`'s coachmark, but
 * centered, since there's no target to point at.
 */

import { BookOpen, PartyPopper, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/stores/appStore";
import { useDocsUrl } from "@/lib/docsUrl";
import { tutorialIncludesTraining } from "@/lib/tutorial/steps";
import { openExternal } from "@/lib/openExternal";

/** Next steps after the full (desktop) run, which trained and ran a model. */
function TrainedNextSteps() {
  return (
    <>
      <li>
        Label more frames: generate more suggestions, correct the predictions
        on them, and retrain. Each round makes the model better.
      </li>
      <li>
        When you&apos;re happy with it, run inference with Inference Target set
        to &quot;Entire current video&quot; (or &quot;All videos&quot;).
      </li>
    </>
  );
}

export function TutorialCompletionCard() {
  const docsUrl = useDocsUrl();
  // The browser run stops after labeling (it can't train), so it gets its
  // own wrap-up — the full-loop summary below would describe steps it skipped.
  const trained = useAppStore((s) => tutorialIncludesTraining(s.tutorialSteps));
  const dismiss = () => useAppStore.getState().dismissTutorialCompletion();

  return (
    <div
      data-tutorial-completion
      className="fixed left-1/2 top-1/2 z-[9998] w-[340px] -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-popover p-4 text-sm text-popover-foreground shadow-lg"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="flex items-center gap-1.5 font-semibold">
          {/* An icon, not the 🎉 emoji: VMs and minimal Linux installs often
              have no color-emoji font, so the emoji renders as a blank box. */}
          <PartyPopper className="h-4 w-4 text-green-500" />
          Tutorial complete
        </p>
        <button
          type="button"
          aria-label="Close"
          className="text-muted-foreground hover:text-foreground"
          onClick={dismiss}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {trained ? (
        <p className="mt-2 text-muted-foreground leading-relaxed">
          You&apos;ve been through the whole loop: label, train, correct
          predictions, retrain, and predict. Where to go from here:
        </p>
      ) : (
        <p className="mt-2 text-muted-foreground leading-relaxed">
          You&apos;ve created a project, built a skeleton, and labeled your
          first frame. Where to go from here:
        </p>
      )}
      <ul className="mt-2 list-disc space-y-1 pl-4 text-muted-foreground leading-relaxed">
        {trained ? (
          <TrainedNextSteps />
        ) : (
          <>
            <li>
              Keep labeling suggested frames. The more you label, the better
              the model you train later.
            </li>
            <li>
              To train a model and run it on your videos, open this project
              in the SLEAP desktop app.
            </li>
          </>
        )}
        <li>
          Restart this tutorial anytime from Start Tutorial in the menu bar.
        </li>
      </ul>
      <div className="mt-3 flex items-center justify-end gap-2">
        <Button variant="outline" size="xs" onClick={() => void openExternal(docsUrl)}>
          <BookOpen className="h-3 w-3" />
          Documentation
        </Button>
        <Button size="xs" onClick={dismiss}>
          Done
        </Button>
      </div>
    </div>
  );
}
