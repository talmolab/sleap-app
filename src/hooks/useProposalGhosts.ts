/**
 * Claude's pending (or undone) fixes and corrections on the frame on screen, as ghost poses
 * for the canvas (QC Review window only). Outdated proposals aren't drawn:
 * they no longer describe a change to the pose that is there.
 */
import { useMemo } from "react";
import { useAppStore } from "@/stores/appStore";
import { useQcStore } from "@/stores/qcStore";
import { canAccept, findPredictionByPose, useProposalStore, type Proposal } from "@/stores/proposalStore";
import { toImageCoords } from "@/lib/cropTransform";
import type { GhostNode, ProposalGhost } from "@/canvas/proposalGhost";
import type { LabeledFrame, Video } from "@/types";

/** Ghosts for one frame's pending, current fix proposals. */
export function proposalGhosts(
  proposals: readonly Proposal[],
  lf: LabeledFrame | null,
  video: Video | null,
  videoIdx: number,
): ProposalGhost[] {
  if (!lf) return [];
  const out: ProposalGhost[] = [];
  for (const p of proposals) {
    if (p.kind === "ignore" || p.videoIdx !== videoIdx || p.frameIdx !== lf.frameIdx) continue;
    if (!canAccept(p)) continue; // decided, or outdated
    // A fix changes a user instance; a correction, the prediction it is about.
    const inst = p.kind === "correct" ? findPredictionByPose(lf, p.fingerprint, p.instIdx) : lf.userInstances[p.instIdx];
    if (!inst) continue;
    const instanceIdx = lf.instances.indexOf(inst);
    if (instanceIdx < 0) continue;
    const nodes: GhostNode[] = inst.points.map((_, i) => {
      if (!(i in p.after)) return { kind: "same" };
      const v = p.after[i];
      if (v === null) return { kind: "hide" };
      const [x, y] = toImageCoords(video, v[0], v[1]);
      return { kind: "move", x, y };
    });
    out.push({ instanceIdx, nodes });
  }
  return out;
}

export function useProposalGhosts(): ProposalGhost[] {
  const reviewOpen = useQcStore((s) => s.reviewOpen);
  const proposals = useProposalStore((s) => s.proposals);
  const labels = useAppStore((s) => s.labels);
  const video = useAppStore((s) => s.video);
  const lf = useAppStore((s) => s.labeledFrame);
  // An edit can make a proposal outdated.
  const editSeq = useAppStore((s) => s.editSeq);
  return useMemo(() => {
    if (!reviewOpen || proposals.length === 0 || !labels || !video) return [];
    return proposalGhosts(proposals, lf, video, labels.videos.indexOf(video));
    // editSeq isn't read, but an edit changes what isOutdated sees.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewOpen, proposals, labels, video, lf, editSeq]);
}
