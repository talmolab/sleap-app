/**
 * Unit tests for the no-SAB in-place confinement gate (browser OPFS fast-save).
 * Pure logic over real io `Labels` — no file, no SharedArrayBuffer.
 */
import { describe, it, expect } from "../bun-test";
import { Labels, Skeleton, Track, Video } from "@talmolab/sleap-io.js";
import {
  captureInPlaceBaseline,
  checkInPlaceWritableNoSab,
} from "@/lib/opfsInPlaceGate";

/** A minimal but non-trivial Labels: one skeleton, one video, one track. */
function makeLabels(): Labels {
  const skel = new Skeleton({
    nodes: [{ name: "a" }, { name: "b" }],
    name: "skel",
  });
  const labels = new Labels({ skeletons: [skel] });
  labels.addVideo(new Video({ filename: "vid.mp4", openBackend: false }));
  labels.tracks.push(new Track("track-0"));
  return labels;
}

describe("opfsInPlaceGate (no-SAB in-place confinement)", () => {
  it("allows a save with no structural change (in-place OK) and returns an update", () => {
    const labels = makeLabels();
    const baseline = captureInPlaceBaseline(labels);
    const res = checkInPlaceWritableNoSab(labels, baseline);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.update).toBeDefined();
      expect(res.metadataChanged).toBe(false);
    }
  });

  it("refuses when a track is added (tracks_json would desync)", () => {
    const labels = makeLabels();
    const baseline = captureInPlaceBaseline(labels);
    labels.tracks.push(new Track("track-1"));
    const res = checkInPlaceWritableNoSab(labels, baseline);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/track/i);
  });

  it("refuses when a video is added (frames would point into a stale video list)", () => {
    const labels = makeLabels();
    const baseline = captureInPlaceBaseline(labels);
    labels.addVideo(new Video({ filename: "vid2.mp4", openBackend: false }));
    const res = checkInPlaceWritableNoSab(labels, baseline);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/video/i);
  });

  it("allows a /metadata change by carrying it in the update", () => {
    const labels = makeLabels();
    const baseline = captureInPlaceBaseline(labels);
    // A skeleton rename changes the /metadata json; the gate should still allow
    // in-place because the update carries the new metadataJson.
    labels.skeletons[0].name = "renamed";
    const res = checkInPlaceWritableNoSab(labels, baseline);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.metadataChanged).toBe(true);
  });
});
