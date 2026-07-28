/**
 * "Enough labels — train the locator?" prompt (issue #212).
 *
 * Appears as a bar directly under the seed top bar once the seeded-centroid
 * count crosses `localize.trainAfter`, re-arming at each multiple. Three
 * choices: dismiss, start training with the AL defaults, or open the Training
 * panel to tweak the config first.
 */

import { useMemo, useState } from "react";
import { useAppStore } from "../../stores/appStore";
import { useActiveLearningStore } from "../../stores/activeLearningStore";
import { useTrainingStore } from "../../stores/trainingStore";
import {
  startCentroidLocatorTraining,
  setupCentroidTraining,
} from "@/lib/activeLearning/trainLocator";
import { Button } from "@/components/ui/button";

export function TrainPromptBanner() {
  const config = useActiveLearningStore((s) => s.config);
  const overlayVersion = useAppStore((s) => s.overlayVersion);
  const trainingStatus = useTrainingStore((s) => s.status);
  const [dismissedUpTo, setDismissedUpTo] = useState(0);

  // Total seeded centroids (user instances) across the project.
  const seeded = useMemo(() => {
    const labels = useAppStore.getState().labels;
    let n = 0;
    if (labels) for (const lf of labels.labeledFrames) n += lf.userInstances.length;
    return n;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlayVersion]);

  if (!config || !config.localize.enabled) return null;
  const trainAfter = config.localize.trainAfter;
  if (seeded < trainAfter || trainingStatus === "running") return null;

  // Highest threshold multiple crossed; re-arm once the next one is reached.
  const milestone = Math.floor(seeded / trainAfter) * trainAfter;
  if (milestone <= dismissedUpTo) return null;

  // A big, fixed bottom-right pop-out (NOT a top strip) so it's noticeable even
  // when the user is heads-down labeling. Persists until dismissed or training
  // starts; re-arms at the next multiple.
  return (
    <div className="fixed bottom-4 right-4 z-50 w-80 rounded-lg border border-border bg-card p-4 shadow-xl">
      <div className="text-sm font-semibold">🎯 {seeded} labels reached</div>
      <p className="mt-1 text-xs text-muted-foreground leading-snug">
        Enough to train a first centroid locator. It runs in the background while you keep seeding.
      </p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Button
          size="sm"
          onClick={() => {
            startCentroidLocatorTraining(config);
            setDismissedUpTo(milestone);
          }}
        >
          Start training
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            if (setupCentroidTraining(config)) {
              // #233 replaced the single `sidebarActivePanel` with an open-panel
              // stack; `togglePanelOpen` reveals a collapsed column and opens the
              // panel in both single- and multi-panel modes.
              useAppStore.getState().togglePanelOpen("training");
            }
            setDismissedUpTo(milestone);
          }}
        >
          Tweak configs
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setDismissedUpTo(milestone)}>
          Not now
        </Button>
      </div>
    </div>
  );
}
