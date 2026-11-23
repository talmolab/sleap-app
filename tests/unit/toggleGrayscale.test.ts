/**
 * Videos ▸ Toggle Grayscale — PyQt SLEAP's `ToggleGrayscale` (commands.py):
 * read the current video's grayscale state, switch EVERY video to the
 * opposite, silently. Undoable here.
 */
import { describe, it, expect, beforeEach } from "../bun-test";
import {
  GrayscaleVideoBackend,
  Labels,
  Video,
  loadSlp,
  saveSlpToBytes,
  type VideoBackend,
} from "@talmolab/sleap-io.js";
import { CommandContext } from "@/commands/CommandContext";
import { ToggleGrayscale } from "@/commands/videoCommands";
import { useAppStore } from "@/stores/appStore";
import { dirtyFrameTracker } from "@/lib/autosaveDirty";
import {
  grayscaleToToggleFrom,
  toggleGrayscaleAll,
} from "@/lib/videoGrayscale";

function fakeBackend(channels: number): VideoBackend {
  return {
    filename: "/v/x.mp4",
    shape: [10, 4, 4, channels],
    fps: 30,
    getFrame: async () => null,
    close: () => {},
  } as VideoBackend;
}

/** An open RGB video whose shape is frozen, as the import path leaves it. */
function openVideo(name: string, channels = 3): Video {
  const backend = fakeBackend(channels);
  const v = new Video({ filename: `/v/${name}.mp4`, backend, openBackend: false });
  v.shape = backend.shape!; // the import probe freezes the shape like this
  return v;
}

/** A video whose file is missing: no backend. */
function missingVideo(): Video {
  return new Video({ filename: "/v/gone.mp4", openBackend: false });
}

describe("toggleGrayscaleAll", () => {
  // PyQt flips every video to the opposite of the CURRENT video's state.
  it("switches every video to the opposite of the current video", () => {
    const a = openVideo("a");
    const b = openVideo("b");
    const result = toggleGrayscaleAll([a, b], a);
    expect(result.value).toBe(true);
    expect(a.grayscale).toBe(true);
    expect(b.grayscale).toBe(true);
    expect(a.backend).toBeInstanceOf(GrayscaleVideoBackend);
    expect(a.backendMetadata.grayscale).toBe(true);
    expect(a.shape?.[3]).toBe(1);
  });

  // The frozen shape must follow, or a second toggle would read the old state.
  it("toggles back on a second press", () => {
    const a = openVideo("a");
    toggleGrayscaleAll([a], a);
    toggleGrayscaleAll([a], a);
    expect(a.grayscale).toBe(false);
    expect(a.backendMetadata.grayscale).toBe(false);
    expect(a.shape?.[3]).toBe(3);
  });

  // A grayscale current video turns every video (even an RGB one) to RGB.
  it("bases the new state on the current video only", () => {
    const gray = openVideo("g", 1);
    const rgb = openVideo("c", 3);
    toggleGrayscaleAll([gray, rgb], gray);
    expect(gray.grayscale).toBe(false);
    expect(rgb.grayscale).toBe(false);
  });

  // PyQt falls back to the first video that can report a state.
  it("falls back to the first video that knows its state", () => {
    const v = openVideo("a");
    expect(grayscaleToToggleFrom([missingVideo(), v], null)).toBe(false);
  });

  // Desktop opens unviewed videos lazily (no backend yet). PyQt still flips
  // them (Python's setter just writes backend_metadata), so they must not be
  // skipped — skipping left mixed channel counts in the saved .slp.
  it("switches a not-yet-opened (lazy) video through its metadata", () => {
    const ok = openVideo("a");
    const lazy = missingVideo();
    lazy.backendMetadata = { shape: [10, 4, 4, 3], lazyPath: "/v/gone.mp4" };
    const result = toggleGrayscaleAll([ok, lazy], ok);
    expect(ok.grayscale).toBe(true);
    expect(lazy.grayscale).toBe(true);
    expect(lazy.backendMetadata.grayscale).toBe(true);
    expect(lazy.backendMetadata.shape).toEqual([10, 4, 4, 1]);
    expect(result.after.map((s) => s.video)).toEqual([ok, lazy]);
  });

  // PyQt's own error messages when there is nothing to toggle.
  it("throws PyQt's messages when nothing can be toggled", () => {
    expect(() => toggleGrayscaleAll([], null)).toThrow("No videos detected");
    expect(() => toggleGrayscaleAll([missingVideo()], null)).toThrow(
      "No videos support grayscale."
    );
  });
});

describe("ToggleGrayscale command", () => {
  let ctx: CommandContext;
  let a: Video;
  let b: Video;

  beforeEach(() => {
    a = openVideo("a");
    b = openVideo("b");
    const labels = new Labels({ videos: [a, b] });
    const store = useAppStore.getState();
    store.setLabels(labels, "test.slp");
    store.setVideo(a);
    ctx = new CommandContext();
    dirtyFrameTracker.clear();
  });

  // The user decided the toggle is undoable: ⌘Z restores every video.
  it("undo puts every video back; redo re-applies", async () => {
    const innerA = a.backend;
    await ctx.execute(ToggleGrayscale);
    expect(a.grayscale).toBe(true);
    expect(b.grayscale).toBe(true);
    expect(ctx.undoLabel).toBe("Toggle Grayscale");

    expect(ctx.undo()).toBe(true);
    expect(a.grayscale).toBe(false);
    expect(b.grayscale).toBe(false);
    expect(a.backend).toBe(innerA); // unwrapped again, same decoder
    expect("grayscale" in a.backendMetadata).toBe(false);

    expect(ctx.redo()).toBe(true);
    expect(a.grayscale).toBe(true);
    expect(b.grayscale).toBe(true);
    expect(a.backendMetadata.grayscale).toBe(true);
  });

  // With an unviewed lazy 2nd video: both are saved grayscale, and ⌘Z puts
  // the lazy one back too (read back from the saved file, as Python would).
  it("saves and undoes a lazy second video too", async () => {
    const lazy = missingVideo();
    lazy.backendMetadata = { shape: [10, 4, 4, 3], lazyPath: "/v/gone.mp4" };
    const labels = new Labels({ videos: [a, lazy] });
    useAppStore.getState().setLabels(labels, "test.slp");
    useAppStore.getState().setVideo(a);
    ctx = new CommandContext();

    await ctx.execute(ToggleGrayscale);
    const saved = await loadSlp(await saveSlpToBytes(labels), { openVideos: false });
    expect(saved.videos.map((v) => v.backendMetadata.grayscale)).toEqual([true, true]);
    expect(saved.videos[1]!.backendMetadata.shape).toEqual([10, 4, 4, 1]);

    expect(ctx.undo()).toBe(true);
    expect(lazy.grayscale).toBe(false);
    expect("grayscale" in lazy.backendMetadata).toBe(false);
  });

  // videos_json changes, so the next autosave must rewrite the whole file.
  it("marks the project for a full autosave", async () => {
    await ctx.execute(ToggleGrayscale);
    expect(dirtyFrameTracker.needsFullSnapshot).toBe(true);
  });
});
