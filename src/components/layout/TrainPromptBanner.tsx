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

  return (
    <div className="flex items-center gap-2 border-b border-border bg-primary/10 px-3 py-1.5 text-xs">
      <span className="font-medium">{seeded} labels reached</span>
      <span className="text-muted-foreground">— enough to train a first locator.</span>
      <div className="ml-auto flex items-center gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          className="h-7"
          onClick={() => setDismissedUpTo(milestone)}
        >
          Not now
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          onClick={() => {
            if (setupCentroidTraining(config)) {
              useAppStore.getState().set("sidebarActivePanel", "training");
            }
            setDismissedUpTo(milestone);
          }}
        >
          Tweak configs
        </Button>
        <Button
          size="sm"
          className="h-7"
          onClick={() => {
            void startCentroidLocatorTraining(config);
            setDismissedUpTo(milestone);
          }}
        >
          Start training
        </Button>
      </div>
    </div>
  );
}
