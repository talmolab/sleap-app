/**
 * Tests for SLEAP Analysis HDF5 import (File > Import Analysis HDF5...).
 *
 * Thin integration coverage: the sleap-io.js reader (`loadAnalysisH5`) is
 * exercised in depth upstream, so here we verify the app-specific contract —
 * that the reader ingests browser file BYTES (the whole reason import is
 * browser-safe), that `.analysis.h5` is distinguishable from `.slp`, and that
 * the app loaders populate the store from both a path (desktop) and a File
 * (browser).
 *
 * Mirrors loadProgress.test.ts: quiet toasts and stub video resolution (the
 * external video never settles under the bun runner; that path runs in a real
 * WebView).
 */

import { describe, it, expect, beforeEach, vi } from "../bun-test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("@/lib/resolveVideos", () => ({
  resolveExternalVideos: vi.fn(async () => {}),
}));

import { loadAnalysisH5, isAnalysisH5File } from "@talmolab/sleap-io.js";
import {
  loadAnalysisProjectFromFile,
  loadAnalysisProjectFromPath,
} from "@/lib/loadProject";
import { useAppStore } from "@/stores/appStore";

const ANALYSIS_FIXTURE = join(import.meta.dir, "../fixtures/simple.analysis.h5");
const SLP_FIXTURE = join(import.meta.dir, "../fixtures/minimal_instance.slp");

function resetStore() {
  useAppStore.setState(useAppStore.getInitialState());
}

describe("isAnalysisH5File", () => {
  it("recognizes an analysis .h5 by its bytes", async () => {
    const bytes = new Uint8Array(readFileSync(ANALYSIS_FIXTURE));
    expect(await isAnalysisH5File(bytes)).toBe(true);
  });

  it("rejects a plain .slp file (no track_occupancy)", async () => {
    const bytes = new Uint8Array(readFileSync(SLP_FIXTURE));
    expect(await isAnalysisH5File(bytes)).toBe(false);
  });
});

describe("loadAnalysisH5 from bytes", () => {
  it("parses browser bytes into Labels (video, skeleton, frames)", async () => {
    const bytes = new Uint8Array(readFileSync(ANALYSIS_FIXTURE));
    // The public signature is narrowed to `string`, but openH5File accepts bytes
    // at runtime — exactly what the browser import relies on.
    const labels = await loadAnalysisH5(bytes as unknown as string);
    expect(labels.videos.length).toBe(1);
    expect(labels.skeletons[0].nodes.length).toBeGreaterThan(0);
    expect(labels.labeledFrames.length).toBeGreaterThan(0);
  });
});

describe("loadAnalysisProjectFromPath (desktop)", () => {
  beforeEach(resetStore);

  it("imports the file and populates the store", async () => {
    const bytes = new Uint8Array(readFileSync(ANALYSIS_FIXTURE));
    const ok = await loadAnalysisProjectFromPath(ANALYSIS_FIXTURE, async () => bytes);
    expect(ok).toBe(true);

    const state = useAppStore.getState();
    expect(state.labels).not.toBeNull();
    expect(state.labels!.labeledFrames.length).toBeGreaterThan(0);
    expect(state.labels!.videos.length).toBe(1);
    expect(state.skeleton!.nodes.length).toBeGreaterThan(0);
    expect(state.isLoading).toBe(false);
  });
});

describe("loadAnalysisProjectFromFile (browser)", () => {
  beforeEach(resetStore);

  it("imports a File object and populates the store", async () => {
    const bytes = new Uint8Array(readFileSync(ANALYSIS_FIXTURE));
    const file = new File([bytes], "simple.analysis.h5");
    const ok = await loadAnalysisProjectFromFile(file);
    expect(ok).toBe(true);

    const state = useAppStore.getState();
    expect(state.labels).not.toBeNull();
    expect(state.labels!.labeledFrames.length).toBeGreaterThan(0);
    expect(state.filename).toBe("simple.analysis.h5");
    expect(state.isLoading).toBe(false);
  });
});
