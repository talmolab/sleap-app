/**
 * Unmocked `@talmolab/sleap-io.js` 0.6.0-alpha.0 integration test covering the
 * remote re-point path for View-only format 3.0 labels (such as worker labels
 * loaded by `loadWorkerLabels` with `format3: "view"` + `userInstancesOnly`):
 *  - Default `buildRemoteLabelsPayload` still refuses View-only labels with
 *    `SlpViewOnlyError` (protecting the open project).
 *  - Opting in with `allowViewOnlyCopy: true` (used only by `NewJobWizard` on
 *    its read-only worker inspection labels) succeeds on a throwaway copy and
 *    leaves the source `Labels` untouched as View only.
 *  - Passing `slpVersion: "v3"` preserves format 3.0 (`unlabeled` + metadata);
 *    defaulting to `"v2"` produces a legacy 2.x copy for remote workers.
 */
import { describe, it, expect } from "../bun-test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSlp, SlpViewOnlyError } from "@talmolab/sleap-io.js";
import { buildRemoteLabelsPayload } from "@/lib/remoteLabelsPayload";
import { isUnlabeledPoint, metadataOf } from "@/lib/slpFormat";

const FIXTURE = join(import.meta.dir, "../fixtures/format3_unlabeled.slp");

describe("format 3.0 View-only worker labels -> buildRemoteLabelsPayload (unmocked sleap-io.js)", () => {
  it("refuses by default, succeeds with allowViewOnlyCopy without mutating source, and respects slpVersion", async () => {
    const bytes = new Uint8Array(readFileSync(FIXTURE));
    const labels = await loadSlp(bytes, { openVideos: false, format3: "view" });
    expect(labels.sourceFormat?.formatId).toBe(3);
    expect(labels.sourceFormat?.access).toBe("view");

    const visibility = labels.videos.map((v, index) => ({
      index,
      local: Array.isArray(v.filename) ? v.filename[0] : v.filename,
      worker: `/mnt/worker/video_${index}.mp4`,
      visible: true,
    }));

    // Default (no allowViewOnlyCopy): refuses to serialize View-only labels.
    await expect(
      buildRemoteLabelsPayload(labels, visibility, { embedFramesToPredict: false }),
    ).rejects.toBeInstanceOf(SlpViewOnlyError);

    // Explicit opt-in for worker re-point (default legacy v2 output):
    const v2Payload = await buildRemoteLabelsPayload(labels, visibility, {
      embedFramesToPredict: false,
      allowViewOnlyCopy: true,
    });
    expect(v2Payload.bytes).toBeGreaterThan(0);
    expect(labels.sourceFormat?.access).toBe("view"); // original untouched

    const v2Bytes = Uint8Array.from(atob(v2Payload.labelsContent), (c) => c.charCodeAt(0));
    const v2Back = await loadSlp(v2Bytes, { openVideos: false });
    expect(v2Back.sourceFormat).toBeNull();
    expect(v2Back.videos[0].filename).toBe("/mnt/worker/video_0.mp4");

    // Explicit opt-in with slpVersion: "v3" preserves format 3.0 natively:
    const v3Payload = await buildRemoteLabelsPayload(labels, visibility, {
      embedFramesToPredict: false,
      allowViewOnlyCopy: true,
      slpVersion: "v3",
    });
    const v3Bytes = Uint8Array.from(atob(v3Payload.labelsContent), (c) => c.charCodeAt(0));
    const v3Back = await loadSlp(v3Bytes, { openVideos: false });
    expect(v3Back.sourceFormat?.formatId).toBe(3);
    expect(v3Back.videos[0].filename).toBe("/mnt/worker/video_0.mp4");
    const lf0 = v3Back.labeledFrames.find((f) => f.frameIdx === 0)!;
    expect(metadataOf(lf0)).toEqual({ note: "frame note" });
    expect(isUnlabeledPoint(lf0.instances[0].points[2])).toBe(true);
    expect(labels.sourceFormat?.access).toBe("view"); // still untouched
  });
});
