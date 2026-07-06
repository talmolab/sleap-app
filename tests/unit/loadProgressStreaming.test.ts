/**
 * Streaming-path counterpart to loadProgress.test.ts.
 *
 * The >1GB range-reader route (`readSlpStreaming`) must forward `onProgress`
 * into the loading overlay just like the eager path. The real streaming reader
 * spawns a Worker + h5wasm (can't run under the bun test runner), so it's
 * stubbed here to emit staged progress and return a minimal Labels; `fileSize`
 * is forced above the 1 GB threshold to select the streaming branch.
 *
 * loadProject's ONLY runtime deps on sleap-io.js are the three mocked below
 * (loadSlp / readSlpStreaming / setImageBytesReader) — everything else it (and
 * appStore) import from the library is type-only and erased — so a minimal
 * mock is safe and needs no real-module passthrough.
 */

import { describe, it, expect, beforeEach, vi } from "../bun-test";

// Quiet toasts (precedent: loadProgress.test.tsx).
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

// resolveExternalVideos awaits a real video backend that never settles under
// bun; stub it — this file covers parse-progress wiring, not video resolution.
vi.mock("@/lib/resolveVideos", () => ({
  resolveExternalVideos: vi.fn(async () => {}),
}));

// Force selection of the >1GB streaming branch regardless of real file size.
vi.mock("@/lib/nativeRange", () => ({
  fileSize: vi.fn(async () => 2_000_000_000),
  readRange: vi.fn(async () => new Uint8Array()),
}));

// Stub the streaming reader: capture the options it receives, emit staged
// progress through the onProgress we pass it, and return a minimal Labels the
// store can accept (setLabels only reads videos/skeletons/labeledFrames).
let streamingOptions: {
  onProgress?: (current: number, total: number, message?: string) => void;
} | null = null;

const readSlpStreamingMock = vi.fn(async (_source: unknown, options: any) => {
  streamingOptions = options;
  options.onProgress?.(0, 4, "Reading metadata");
  options.onProgress?.(2, 4, "Reading frames");
  options.onProgress?.(4, 4, "Finalizing");
  return { videos: [], skeletons: [], labeledFrames: [] };
});

vi.mock("@talmolab/sleap-io.js", () => ({
  loadSlp: vi.fn(), // never reached on the streaming branch
  readSlpStreaming: readSlpStreamingMock,
  setImageBytesReader: vi.fn(),
}));

import { loadProjectFromPath } from "@/lib/loadProject";
import { useAppStore } from "@/stores/appStore";

function resetStore() {
  useAppStore.setState(useAppStore.getInitialState());
}

describe("loadProjectFromPath streaming (range-reader) progress", () => {
  beforeEach(() => {
    resetStore();
    streamingOptions = null;
    readSlpStreamingMock.mockClear();
  });

  it("routes >1GB files to readSlpStreaming and forwards onProgress to the overlay", async () => {
    const messages: string[] = [];
    const unsubscribe = useAppStore.subscribe((state, prev) => {
      if (
        state.loadingMessage &&
        state.loadingMessage !== prev.loadingMessage
      ) {
        messages.push(state.loadingMessage);
      }
    });

    try {
      const ok = await loadProjectFromPath(
        "/huge/project.slp",
        async () => new Uint8Array()
      );
      expect(ok).toBe(true);
    } finally {
      unsubscribe();
    }

    // The large-file branch went through the streaming reader, not eager parse.
    expect(readSlpStreamingMock).toHaveBeenCalledTimes(1);
    expect(messages.some((m) => m.startsWith("Streaming project.slp"))).toBe(
      true
    );

    // The streaming reader was actually handed an onProgress callback — the wire.
    expect(typeof streamingOptions?.onProgress).toBe("function");

    // Its staged emissions reached the overlay as "<stage>... (NN%)", ending 100%.
    const staged = messages.filter((m) => /\.\.\. \(\d+%\)$/.test(m));
    expect(staged).toContain("Reading frames... (50%)");
    expect(staged[staged.length - 1]).toMatch(/\(100%\)$/);

    // Overlay dismissed once the load settles.
    expect(useAppStore.getState().isLoading).toBe(false);
  });
});
