/**
 * Tests for the sleap-io.js onProgress → loading-overlay wiring (Tier 2 of the
 * verbose-file-open work, #176). Covers the message formatter and, end-to-end
 * against a real fixture, that loadSlp@0.5+ actually emits staged progress and
 * that loadProjectFromPath surfaces it through the store — so a future
 * sleap-io.js bump that renames/drops the callback fails here, not in the app.
 */

import { describe, it, expect, beforeEach, vi } from "../bun-test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Quiet toasts (precedent: videosPanelLocate.test.tsx).
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

// The fixture references an external MP4; the real resolveExternalVideos
// awaits that backend's `ready` promise, which never settles under the bun
// test runner (no decoder) — the app paths run in a real WebView. Stub it;
// this file covers the parse-progress wiring, not video resolution.
vi.mock("@/lib/resolveVideos", () => ({
  resolveExternalVideos: vi.fn(async () => {}),
}));

import { formatLoadProgress, loadProjectFromPath } from "@/lib/loadProject";
import { useAppStore } from "@/stores/appStore";

const FIXTURE = join(import.meta.dir, "../fixtures/minimal_instance.slp");

function resetStore() {
  useAppStore.setState(useAppStore.getInitialState());
}

describe("formatLoadProgress", () => {
  it("formats stage + percent from (current, total, message)", () => {
    expect(formatLoadProgress(0, 10, "Reading metadata")).toBe(
      "Reading metadata... (0%)"
    );
    expect(formatLoadProgress(4, 10, "Reading frames")).toBe(
      "Reading frames... (40%)"
    );
    expect(formatLoadProgress(10, 10, "Finalizing")).toBe("Finalizing... (100%)");
  });

  it("falls back to 'Parsing' when the stage message is omitted", () => {
    expect(formatLoadProgress(1, 4)).toBe("Parsing... (25%)");
  });

  it("guards against total=0 instead of dividing by zero", () => {
    expect(formatLoadProgress(0, 0, "Reading metadata")).toBe(
      "Reading metadata... (0%)"
    );
  });
});

describe("loadProjectFromPath progress reporting", () => {
  beforeEach(() => {
    resetStore();
  });

  it("streams staged parse progress into the loading overlay", async () => {
    const bytes = new Uint8Array(readFileSync(FIXTURE));

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
      const ok = await loadProjectFromPath(FIXTURE, async () => bytes);
      expect(ok).toBe(true);
    } finally {
      unsubscribe();
    }

    // Coarse app-side stages present, in order.
    const reading = messages.findIndex((m) => m.startsWith("Reading minimal_instance.slp"));
    const parsing = messages.findIndex((m) => m.startsWith("Parsing minimal_instance.slp"));
    const locating = messages.findIndex((m) => m.startsWith("Locating videos"));
    expect(reading).toBeGreaterThanOrEqual(0);
    expect(parsing).toBeGreaterThan(reading);
    expect(locating).toBeGreaterThan(parsing);

    // Library-emitted stages land between "Parsing..." and "Locating videos...",
    // formatted as "<stage>... (NN%)", finishing at 100%.
    const staged = messages.filter((m) => /\.\.\. \(\d+%\)$/.test(m));
    expect(staged.length).toBeGreaterThanOrEqual(2);
    expect(staged[staged.length - 1]).toMatch(/\(100%\)$/);
    const firstStaged = messages.findIndex((m) => /\(\d+%\)$/.test(m));
    expect(firstStaged).toBeGreaterThan(parsing);
    expect(firstStaged).toBeLessThan(locating);

    // Overlay is dismissed when the load settles.
    expect(useAppStore.getState().isLoading).toBe(false);
  });
});
