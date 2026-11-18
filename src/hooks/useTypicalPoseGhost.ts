/**
 * The typical pose fitted onto the selected user instance, for the Label QC
 * Review window ("Typical pose" toggle in its footer). The typical shape is
 * built once per project and skeleton; the fit follows each edit.
 */
import { useMemo } from "react";
import { Instance, PredictedInstance } from "@talmolab/sleap-io.js";
import { useAppStore } from "@/stores/appStore";
import { useQcStore } from "@/stores/qcStore";
import { toImageCoords } from "@/lib/cropTransform";
import { visiblePose } from "@/lib/keypointReview";
import { alignTypicalPose, typicalPose, type Pose } from "@/lib/analyze/qc/typicalPose";
import type { TypicalPoseGhost } from "@/canvas/typicalPoseGhost";
import type { Labels } from "@/types";

const isUser = (i: unknown): i is Instance =>
  i instanceof Instance && !(i instanceof PredictedInstance);

/** The typical shape of every user instance of `skeleton` in the project. */
export function projectTypicalPose(labels: Labels, skeleton: object): Pose | null {
  const poses: Pose[] = [];
  for (const lf of labels.labeledFrames) {
    for (const inst of lf.instances) {
      if (isUser(inst) && inst.skeleton === skeleton) poses.push(visiblePose(inst));
    }
  }
  return typicalPose(poses);
}

export function useTypicalPoseGhost(): TypicalPoseGhost | null {
  const enabled = useQcStore((s) => s.reviewOpen && s.showTypicalPose);
  const labels = useAppStore((s) => s.labels);
  const video = useAppStore((s) => s.video);
  const lf = useAppStore((s) => s.labeledFrame);
  const selected = useAppStore((s) => s.instance);
  const editSeq = useAppStore((s) => s.editSeq);
  const skeleton = isUser(selected) ? selected.skeleton : null;

  const template = useMemo(
    () => (enabled && labels && skeleton ? projectTypicalPose(labels, skeleton) : null),
    [enabled, labels, skeleton],
  );

  return useMemo(() => {
    if (!template || !lf || !isUser(selected)) return null;
    const instanceIdx = lf.instances.indexOf(selected);
    if (instanceIdx < 0) return null;
    const fitted = alignTypicalPose(template, visiblePose(selected));
    if (!fitted) return null;
    return {
      instanceIdx,
      points: fitted.map(([x, y]) => (Number.isFinite(x) ? toImageCoords(video, x, y) : [NaN, NaN])),
    };
    // editSeq isn't read, but an edit moves the selected instance's nodes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template, lf, selected, video, editSeq]);
}
