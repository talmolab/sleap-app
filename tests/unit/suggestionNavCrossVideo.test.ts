/**
 * Cross-video suggestion navigation (issue #212).
 *
 * SLEAP training packages store one single-frame video per suggestion, so
 * GoNext/PrevSuggestion must step ACROSS videos — otherwise Space strands the
 * user on a one-frame video (the "Space not working" report). A single-video
 * project must still walk suggestions by frame index.
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import { CommandContext } from "@/commands/CommandContext";
import { useAppStore } from "@/stores/appStore";
import { GoNextSuggestion, GoPrevSuggestion } from "@/commands";
import { Labels, Video, Skeleton, type SuggestionFrame } from "@talmolab/sleap-io.js";

function makeVideo(name: string, nFrames = 1): Video {
  return new Video({
    filename: name,
    backendMetadata: { shape: [nFrames, 480, 640, 1] },
    openBackend: false,
  });
}

function sug(video: Video, frameIdx: number): SuggestionFrame {
  return { video, frameIdx } as unknown as SuggestionFrame;
}

describe("cross-video suggestion navigation", () => {
  let ctx: CommandContext;

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    ctx = new CommandContext();
  });

  it("steps across single-frame videos (training-package layout)", () => {
    const skeleton = new Skeleton({ nodes: ["a"], name: "s" });
    const videos = [makeVideo("v0"), makeVideo("v1"), makeVideo("v2")];
    const labels = new Labels({
      videos,
      skeletons: [skeleton],
      suggestions: videos.map((v) => sug(v, 0)),
    });
    useAppStore.getState().setLabels(labels, "pkg.slp");
    expect(useAppStore.getState().video).toBe(videos[0]);

    ctx.execute(GoNextSuggestion);
    expect(useAppStore.getState().video).toBe(videos[1]);
    expect(useAppStore.getState().frameIdx).toBe(0);

    ctx.execute(GoNextSuggestion);
    expect(useAppStore.getState().video).toBe(videos[2]);

    // Wrap forward back to the first video.
    ctx.execute(GoNextSuggestion);
    expect(useAppStore.getState().video).toBe(videos[0]);

    // Wrap backward to the last video.
    ctx.execute(GoPrevSuggestion);
    expect(useAppStore.getState().video).toBe(videos[2]);
  });

  it("still walks suggestions by frame index within one video", () => {
    const skeleton = new Skeleton({ nodes: ["a"], name: "s" });
    const video = makeVideo("only", 100);
    const labels = new Labels({
      videos: [video],
      skeletons: [skeleton],
      suggestions: [sug(video, 5), sug(video, 20), sug(video, 35)],
    });
    useAppStore.getState().setLabels(labels, "one.slp");

    ctx.execute(GoNextSuggestion); // frame 0 → 5
    expect(useAppStore.getState().frameIdx).toBe(5);
    ctx.execute(GoNextSuggestion); // 5 → 20
    expect(useAppStore.getState().frameIdx).toBe(20);
    ctx.execute(GoNextSuggestion); // 20 → 35
    expect(useAppStore.getState().frameIdx).toBe(35);
    ctx.execute(GoNextSuggestion); // 35 → wrap to 5
    expect(useAppStore.getState().frameIdx).toBe(5);
    ctx.execute(GoPrevSuggestion); // 5 → wrap to 35
    expect(useAppStore.getState().frameIdx).toBe(35);
  });
});
