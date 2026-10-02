/**
 * Serialize labels with their labeled frames' pixel data embedded — for a
 * remote-training submission when the worker can't see the original video
 * directly (see `trainingStore.ts`'s `startTraining`).
 *
 * Thin wrapper around `saveSlpToBytes`'s existing embed mode (the same
 * mechanism "Save As > Package" already uses) so test files that need real
 * `Labels`/`Video`/etc. classes from `@talmolab/sleap-io.js` can mock just
 * this one function instead of the whole module — mirrors `labelsDraft.ts`'s
 * `serializeLabelsDraft`, which does the same for the structure-only case.
 *
 * `embed: true` (mode "all") scopes to `labels.labeledFrames` only — never
 * the full video — confirmed directly against sleap-io.js's
 * `collectEncodedFrames` (`src/codecs/slp/write.ts`).
 */
import { saveSlpToBytes, type Labels } from "@talmolab/sleap-io.js";

export async function serializeLabelsEmbedded(labels: Labels): Promise<Uint8Array> {
  return saveSlpToBytes(labels, { embed: true });
}
