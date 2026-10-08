/**
 * Status of the continuous active-learning loop, shown at the top of the AL
 * panel's Correct tab once a round has trained (or the loop is busy).
 *
 * Shows the current round and stage, which videos are new versus already
 * predicted, and what the last round produced. Buttons cover the manual
 * versions of the engine's transitions: predict newly added videos with the
 * latest model, or retrain now.
 */

import { useMemo } from "react";
import { useAppStore } from "../../stores/appStore";
import {
  useActiveLearningStore,
  roundStatus,
  lastTrainedRound,
} from "../../stores/activeLearningStore";
import { advanceRound, runRoundInference, videoKey } from "@/lib/activeLearning/roundEngine";
import { toast } from "@/lib/notify";
import { Button } from "@/components/ui/button";

const STAGE_LABEL = {
  idle: "paused",
  training: "training",
  predicting: "predicting",
  reviewing: "reviewing",
} as const;

export function LoopStatusCard() {
  const labels = useAppStore((s) => s.labels);
  const videosVersion = useAppStore((s) => s.labels?.videos.length ?? 0);
  const config = useActiveLearningStore((s) => s.config);
  const round = useActiveLearningStore((s) => s.round);
  const history = useActiveLearningStore((s) => s.history);
  const predictedVideos = useActiveLearningStore((s) => s.predictedVideos);
  const stage = useActiveLearningStore((s) => s.stage);
  const progress = useActiveLearningStore((s) => s.stageProgress);

  const { newCount, predictedCount } = useMemo(() => {
    const done = new Set(predictedVideos);
    let fresh = 0;
    let seen = 0;
    for (const v of labels?.videos ?? []) {
      if (done.has(videoKey(v))) seen += 1;
      else fresh += 1;
    }
    return { newCount: fresh, predictedCount: seen };
    // videosVersion: labels is mutated in place when videos are added.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labels, predictedVideos, videosVersion]);

  if (!config || (history.length === 0 && stage === "idle")) return null;

  const status = roundStatus({ config, round });
  const last = lastTrainedRound({ history });
  const busy = stage === "training" || stage === "predicting";

  const stageText =
    stage === "predicting" && progress
      ? `predicting ${Math.min(progress.done + 1, progress.total)} of ${progress.total}`
      : STAGE_LABEL[stage];

  const retrain = () => {
    void advanceRound().then((o) => {
      if (!o.ok) toast.error(o.reason);
    });
  };
  const predictNew = () => {
    if (last) void runRoundInference(last.round);
  };

  return (
    <div className="m-2 space-y-1.5 rounded border px-2 py-1.5 text-[11px]">
      <div className="flex items-center justify-between">
        <span className="font-medium">
          Loop · round {round} / {status.maxRounds}
        </span>
        <span
          className={
            busy
              ? "text-violet-500"
              : stage === "reviewing"
                ? "text-emerald-600 dark:text-emerald-500"
                : "text-muted-foreground"
          }
        >
          {stageText}
        </span>
      </div>

      <div className="text-muted-foreground">
        Videos: <span className="text-foreground">{newCount}</span> new ·{" "}
        <span className="text-foreground">{predictedCount}</span> predicted
      </div>

      {last && (
        <div className="leading-snug text-muted-foreground">
          Round {last.round}
          {last.fineTuned ? " (fine-tuned)" : ""}: {last.modelType.replace(/_/g, "-")}
          {last.predicted
            ? ` · ${last.predicted.frames} frame(s) across ${last.predicted.videos} run(s)`
            : ""}
          {typeof last.queued === "number" ? ` · ${last.queued} queued for review` : ""}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5 pt-0.5">
        {last && newCount > 0 && (
          <Button size="sm" variant="outline" className="h-6 text-[10px]" disabled={busy} onClick={predictNew}>
            Predict {newCount} new video{newCount === 1 ? "" : "s"} now
          </Button>
        )}
        {last && status.canAdvance && (
          <Button size="sm" variant="outline" className="h-6 text-[10px]" disabled={busy} onClick={retrain}>
            Retrain now → round {round + 1}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-6 text-[10px]"
          onClick={() => useAppStore.getState().openPanel("videos")}
        >
          Add videos…
        </Button>
      </div>
      {!status.canAdvance && status.maxRounds !== null && (
        <p className="text-muted-foreground">
          Round {round} of {status.maxRounds}: the configured loop is complete. Raise{" "}
          <span className="font-mono">loop.maxRounds</span> to keep going.
        </p>
      )}
    </div>
  );
}
