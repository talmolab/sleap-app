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
// Only the class matters here (an instanceof check); the real constructor takes
// an options object.
class SlpFormatError extends Error {}
class StreamingIncompleteError extends Error {
  unread: string[];
  constructor(msg: string, unread: string[] = ["rois"]) {
    super(msg);
    this.name = "StreamingIncompleteError";
    this.unread = unread;
  }
}
const loadSlpMock = vi.fn(async (_source: unknown, _options: unknown) => ({
  videos: [],
  skeletons: [],
  labeledFrames: [],
}));
const readSlpStreamingMock = vi.fn(async (_source: unknown, _options: unknown) => ({
  videos: [],
  skeletons: [],
  labeledFrames: [],
}));
vi.mock("@talmolab/sleap-io.js", () => ({
  loadSlp: loadSlpMock,
  readSlpStreaming: readSlpStreamingMock,
  setImageBytesReader: vi.fn(),
  RemoteIOError,
  SlpFormatError,
  StreamingIncompleteError,
  redactUrl: (u: string) => u,
  redactedCauseSummary: (e: unknown) => String(e),
}));

import { loadProjectFromUrl } from "@/lib/loadProject";
import { useAppStore } from "@/stores/appStore";
import { useSlpFormatStore } from "@/stores/slpFormatStore";
import { toast } from "@/lib/notify";

function resetStore() {
  useAppStore.setState(useAppStore.getInitialState());
  useSlpFormatStore.setState({ prompt: null, welcomeEnvironmentRequestSeq: 0 });
}

describe("loadProjectFromUrl", () => {
  beforeEach(() => {
    resetStore();
    loadSlpMock.mockClear();
    readSlpStreamingMock.mockClear();
    readSlpStreamingMock.mockImplementation(async () => ({
      videos: [],
      skeletons: [],
      labeledFrames: [],
    }));
    (toast.success as unknown as { mockClear: () => void }).mockClear();
    (toast.error as unknown as { mockClear: () => void }).mockClear();
  });

  it("streams the URL with failIfIncomplete and installs the project under a name derived from the URL", async () => {
    const url = "https://share.sleap.ai/d/abc/set.pkg.slp?token=xyz";
    const ok = await loadProjectFromUrl(url);
    expect(ok).toBe(true);

    expect(readSlpStreamingMock).toHaveBeenCalledTimes(1);
    const [source, options] = readSlpStreamingMock.mock.calls[0] as unknown as [
      string,
      { filenameHint?: string; failIfIncomplete?: boolean; onProgress?: unknown },
    ];
    expect(source).toBe(url); // URL string handed straight to the streaming reader
    // filenameHint is the basename, not the URL: io's streaming worker uses it
    // as the in-FS (Emscripten) filename, which must not contain "://" or "/".
    expect(options.filenameHint).toBe("set.pkg.slp");
    expect(options.failIfIncomplete).toBe(true);
    expect(typeof options.onProgress).toBe("function");

    expect(useAppStore.getState().labels).toBeTruthy();
    expect(useAppStore.getState().filename).toBe("set.pkg.slp"); // query stripped
    expect(useAppStore.getState().isLoading).toBe(false);
  });

  it("falls back to full download via loadSlp when StreamingIncompleteError is thrown", async () => {
    readSlpStreamingMock.mockImplementationOnce(async () => {
      throw new StreamingIncompleteError("non-pose 3.0 tables", ["rois", "masks"]);
    });
    const url = "https://share.sleap.ai/d/abc/format3_rois.slp?token=xyz";
    const ok = await loadProjectFromUrl(url);
    expect(ok).toBe(true);
    expect(loadSlpMock).toHaveBeenCalledTimes(1);
    const [dlSource, dlOpts] = loadSlpMock.mock.calls[0] as unknown as [
      string,
      { openVideos?: boolean; h5?: { stream?: string; filenameHint?: string } },
    ];
    expect(dlSource).toBe(url);
    expect(dlOpts.openVideos).toBe(true);
    expect(dlOpts.h5?.stream).toBe("download");
    expect(dlOpts.h5?.filenameHint).toBe("format3_rois.slp");
    expect(toast.error).not.toHaveBeenCalled();
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

  it("opens the SLP format refusal modal for SlpFormatError instead of a raw error toast", async () => {
    const message =
      "The SLEAP labels file 'set.slp' is in SLP format 3.0, which this version of " +
      "sleap-io.js cannot read (it reads formats below 3.0).";
    readSlpStreamingMock.mockImplementation(async () => {
      throw new SlpFormatError(message);
    });
    const ok = await loadProjectFromUrl("https://share.sleap.ai/set.slp?token=abc");
    expect(ok).toBe(false);
    expect(useAppStore.getState().labels).toBeFalsy();
    expect(useAppStore.getState().isLoading).toBe(false);
    expect(toast.error).not.toHaveBeenCalled();

    const prompt = useSlpFormatStore.getState().prompt;
    expect(prompt).not.toBeNull();
    expect(prompt?.kind).toBe("refused");
    if (prompt?.kind === "refused") {
      expect(prompt.fileName).toBe("set.slp");
      expect(prompt.formatId).toBe(3);
      expect(prompt.detail).toBe(message);
    }
  });

  it("opens the refusal modal for a worker-serialized SlpFormatError (name only)", async () => {
    const serialized = Object.assign(
      new Error("The SLEAP labels file 'remote.slp' is in SLP format 3.0."),
      { name: "SlpFormatError" },
    );
    readSlpStreamingMock.mockImplementation(async () => {
      throw serialized;
    });
    const ok = await loadProjectFromUrl("https://share.sleap.ai/remote.slp?token=secret");
    expect(ok).toBe(false);
    expect(toast.error).not.toHaveBeenCalled();
    const prompt = useSlpFormatStore.getState().prompt;
    expect(prompt?.kind).toBe("refused");
    if (prompt?.kind === "refused") {
      expect(prompt.fileName).toBe("remote.slp");
      expect(prompt.formatId).toBe(3);
    }
  });
});
