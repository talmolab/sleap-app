/**
 * Everything in a project that can carry a `Track`: instances, frame
 * annotations (boxes, centroids, masks, ROIs), each object of a label image,
 * and the project's static ROIs (not tied to a frame, e.g. an arena outline).
 *
 * Used by the track commands (Delete Track, Delete Unused Tracks) and by their
 * lightweight undo snapshot, which records each holder's track by position.
 * The order is stable for an unchanged frame, which is what that relies on.
 */
import type { Labels, LabeledFrame, Track } from "@talmolab/sleap-io.js";

/** Something with a (possibly unset) track. */
export type TrackHolder = { track?: Track | null };

/**
 * Every track holder on one frame, in a fixed order. A plain loop, not a
 * generator: Delete Track walks every holder of a large project several times.
 */
export function frameTrackHolders(lf: LabeledFrame): TrackHolder[] {
  const out: TrackHolder[] = lf.instances.slice();
  const frame = lf as unknown as Record<string, unknown>;
  for (const key in frame) {
    const list = frame[key];
    if (key === "instances" || !Array.isArray(list)) continue;
    for (let i = 0; i < list.length; i++) {
      const ann = list[i] as unknown;
      if (typeof ann !== "object" || ann === null) continue;
      const objects = (ann as { objects?: unknown }).objects;
      if (objects instanceof Map) {
        for (const obj of objects.values()) out.push(obj as TrackHolder);
      } else if ("track" in ann) {
        out.push(ann as TrackHolder);
      }
    }
  }
  return out;
}

/** The project's static ROIs (the live objects, not a copy of the list's items). */
export function staticRoiHolders(labels: Labels): TrackHolder[] {
  return labels.staticRois;
}
