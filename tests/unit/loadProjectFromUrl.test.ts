/**
 * Thin-integration test for loadProjectFromUrl: trust io's streaming reader
 * (mocked) and assert the wiring — URL passed as source, project installed on
 * success, redacted RemoteIOError surfaced + NOT installed on failure.
 * Mock template: loadProgressStreaming.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from "../bun-test";

// loadProject imports `toast` from @/lib/notify; mock it directly so the
// success/error assertions get a clean handle on the exact vi.fns the code
// calls. (Mocking only `sonner` doesn't work: notify captures sonner's methods
// BY VALUE at module-load via wrapMethod/Object.assign, so a later sonner mock
// never reaches the already-captured `.error`. Precedent: saveInPlaceRouting.test.ts.)
vi.mock("@/lib/notify", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
// Belt-and-suspenders: keep sonner mocked too so any OTHER transitive importer
// never reaches the real toaster (precedent: loadProgress.test.ts).
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock("@/lib/resolveVideos", () => ({
  resolveExternalVideos: vi.fn(async () => {}),
}));

class RemoteIOError extends Error {}
const readSlpStreamingMock = vi.fn(async (_source: unknown, _options: unknown) => ({
  videos: [],
  skeletons: [],
  labeledFrames: [],
}));
vi.mock("@talmolab/sleap-io.js", () => ({
  loadSlp: vi.fn(),
  readSlpStreaming: readSlpStreamingMock,
  setImageBytesReader: vi.fn(),
  RemoteIOError,
  redactUrl: (u: string) => u,
  redactedCauseSummary: (e: unknown) => String(e),
}));

import { loadProjectFromUrl } from "@/lib/loadProject";
import { useAppStore } from "@/stores/appStore";
import { toast } from "@/lib/notify";

function resetStore() {
  useAppStore.setState(useAppStore.getInitialState());
}

describe("loadProjectFromUrl", () => {
  beforeEach(() => {
    resetStore();
    readSlpStreamingMock.mockClear();
    readSlpStreamingMock.mockImplementation(async () => ({
      videos: [],
      skeletons: [],
      labeledFrames: [],
    }));
    (toast.success as unknown as { mockClear: () => void }).mockClear();
    (toast.error as unknown as { mockClear: () => void }).mockClear();
  });

  it("streams the URL and installs the project under a name derived from the URL", async () => {
    const url = "https://share.sleap.ai/d/abc/set.pkg.slp?token=xyz";
    const ok = await loadProjectFromUrl(url);
    expect(ok).toBe(true);

    expect(readSlpStreamingMock).toHaveBeenCalledTimes(1);
    const [source, options] = readSlpStreamingMock.mock.calls[0] as unknown as [
      string,
      { filenameHint?: string; onProgress?: unknown },
    ];
    expect(source).toBe(url); // URL string handed straight to the streaming reader
    // filenameHint is the basename, not the URL: io's streaming worker uses it
    // as the in-FS (Emscripten) filename, which must not contain "://" or "/".
    expect(options.filenameHint).toBe("set.pkg.slp");
    expect(typeof options.onProgress).toBe("function");

    expect(useAppStore.getState().labels).toBeTruthy();
    expect(useAppStore.getState().filename).toBe("set.pkg.slp"); // query stripped
    expect(useAppStore.getState().isLoading).toBe(false);
  });

  it("surfaces a redacted RemoteIOError and does NOT install the project", async () => {
    readSlpStreamingMock.mockImplementation(async () => {
      throw new RemoteIOError("This link has expired or is invalid.");
    });
    const ok = await loadProjectFromUrl("https://share.sleap.ai/set.slp?token=bad");
    expect(ok).toBe(false);
    expect(useAppStore.getState().labels).toBeFalsy();
    expect(useAppStore.getState().isLoading).toBe(false);
    expect(toast.error).toHaveBeenCalled();
  });

  it("surfaces a non-RemoteIOError via redactedCauseSummary (not a hardcoded network message)", async () => {
    readSlpStreamingMock.mockImplementation(async () => {
      throw new Error("corrupt or non-SLP file");
    });
    const ok = await loadProjectFromUrl("https://share.sleap.ai/set.slp?token=bad");
    expect(ok).toBe(false);
    expect(useAppStore.getState().labels).toBeFalsy();
    expect(useAppStore.getState().isLoading).toBe(false);
    // The mocked redactedCauseSummary is String(e); the description should carry the
    // real cause, not the RemoteIOError-only "network/CORS" fallback.
    const call = (toast.error as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0];
    expect(String((call?.[1] as { description?: string })?.description)).toContain(
      "corrupt or non-SLP file"
    );
  });
});
