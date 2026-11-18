/**
 * What keypoint review draws on the frame on screen: the node under review on
 * the selected instance, and where that node usually sits (the project's
 * typical pose fitted on the instance's other nodes).
 */
import { useMemo } from "react";
import { useAppStore } from "@/stores/appStore";
import { useKeypointReviewStore } from "@/stores/keypointReviewStore";
import { projectTypicalPose } from "@/hooks/useTypicalPoseGhost";
import { visiblePose } from "@/lib/keypointReview";
import { applySimilarity, fitSimilarity } from "@/lib/analyze/qc/typicalPose";
import { toImageCoords } from "@/lib/cropTransform";
import type { KeypointReviewMark } from "@/canvas/keypointReviewOverlay";

export function useKeypointReviewMark(): KeypointReviewMark | null {
  const active = useKeypointReviewStore((s) => s.active);
  const node = useKeypointReviewStore((s) => s.node);
  const skeleton = useKeypointReviewStore((s) => s.skeleton);
  const labels = useAppStore((s) => s.labels);
  const video = useAppStore((s) => s.video);
  const lf = useAppStore((s) => s.labeledFrame);
  const selected = useAppStore((s) => s.instance);
  const editSeq = useAppStore((s) => s.editSeq);

  const template = useMemo(
    () => (active && labels && skeleton ? projectTypicalPose(labels, skeleton) : null),
    [active, labels, skeleton],
  );

  return useMemo(() => {
    if (!active || !lf || !selected) return null;
    const instanceIdx = lf.instances.indexOf(selected);
    if (instanceIdx < 0) return null;
    let typical: [number, number] | null = null;
    if (template) {
      const others = visiblePose(selected).map((p, i) => (i === node ? [NaN, NaN] : p));
      const t = fitSimilarity(template, others);
      const at = t ? applySimilarity(t, template)[node] : null;
      if (at && Number.isFinite(at[0])) typical = toImageCoords(video, at[0], at[1]);
    }
    return { instanceIdx, node, typical };
    // editSeq isn't read, but an edit moves the instance's nodes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, template, lf, selected, node, video, editSeq]);
}
