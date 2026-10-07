/**
 * Tests for the "Use sample video" button (New Project dialog). Mocks
 * `@/lib/sampleVideo`'s `loadSampleVideo` (keeping `SAMPLE_VIDEO` real) and
 * `@/lib/notify`'s `toast`, so these drive the component's idle/loading/error
 * states without a real network or Tauri runtime.
 *
 * Per the house caveat (tests/bun-test.ts), bun's `mock.module` only affects
 * modules imported AFTER it runs, so `SampleVideoButton` is imported
 * dynamically inside each test/`beforeEach`, after the mocks are registered.
 *
 * `onLoaded` calls are tracked via a plain captured array rather than
 * `vi.fn()` -- the bun-test `vi.fn` shim widens the impl to
 * `(...args: never[]) => unknown`, which can't be passed where the real
 * (strictly-typed) `SampleVideoButton` component expects
 * `(picked: PickedVideoFile) => void` (see saveInPlaceRouting.test.ts's doc
 * on the same quirk). Mock *return* values are likewise driven through
 * captured `let`s + `.mockImplementation`, not `.mockResolvedValue` /
 * `.mockRejectedValue`, for the same reason.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "../bun-test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import type { PickedVideoFile } from "@/lib/resolveVideos";

afterEach(cleanup);

const loadSampleVideoMock = vi.fn();
vi.mock("@/lib/sampleVideo", () => ({
  SAMPLE_VIDEO: { name: "mice.mp4", url: "https://example.com/mice.mp4", bytes: 31_258_120 },
  loadSampleVideo: loadSampleVideoMock,
}));

const toastErrorMock = vi.fn();
vi.mock("@/lib/notify", () => ({
  toast: {
    success: vi.fn(),
    error: toastErrorMock,
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

/** Collects `onLoaded` calls as a plain array + handler, instead of a
 * `vi.fn()` mock (see the file-header note on why). */
function trackOnLoaded() {
  const calls: PickedVideoFile[] = [];
  const onLoaded = (picked: PickedVideoFile) => {
    calls.push(picked);
  };
  return { calls, onLoaded };
}

/** Resolves/rejects only once `release()` is called, so a test can observe
 * the loading state and drive `onProgress` before the promise settles. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SampleVideoButton", () => {
  beforeEach(() => {
    loadSampleVideoMock.mockReset();
    toastErrorMock.mockReset();
  });

  it("click resolves and calls onLoaded with the picked file", async () => {
    const picked: PickedVideoFile = {
      file: new File([], "mice.mp4", { type: "video/mp4" }),
      absPath: null,
    };
    loadSampleVideoMock.mockImplementation(async () => picked);

    const { SampleVideoButton } = await import("@/components/common/SampleVideoButton");
    const { calls, onLoaded } = trackOnLoaded();
    render(<SampleVideoButton onLoaded={onLoaded} />);

    fireEvent.click(screen.getByRole("button", { name: /use sample video/i }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toBe(picked);
    expect(toastErrorMock).not.toHaveBeenCalled();
    // Back to idle afterwards.
    expect(screen.getByRole("button", { name: /use sample video/i })).toBeInTheDocument();
  });

  it("shows a rounded percentage label while downloading", async () => {
    const d = deferred<PickedVideoFile>();
    loadSampleVideoMock.mockImplementation(
      async (opts: { onProgress?: (f: number) => void }) => {
        opts.onProgress?.(0.4231);
        return d.promise;
      },
    );

    const { SampleVideoButton } = await import("@/components/common/SampleVideoButton");
    const { onLoaded } = trackOnLoaded();
    render(<SampleVideoButton onLoaded={onLoaded} />);

    fireEvent.click(screen.getByRole("button", { name: /use sample video/i }));

    await waitFor(() => expect(screen.getByText("Downloading… 42%")).toBeInTheDocument());

    // Let the pending promise resolve so nothing leaks into the next test.
    d.resolve({ file: new File([], "mice.mp4"), absPath: null });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /use sample video/i })).toBeInTheDocument(),
    );
  });

  it("shows an error toast and returns to idle on rejection, without calling onLoaded", async () => {
    loadSampleVideoMock.mockImplementation(async () => {
      throw new Error("network down");
    });

    const { SampleVideoButton } = await import("@/components/common/SampleVideoButton");
    const { calls, onLoaded } = trackOnLoaded();
    render(<SampleVideoButton onLoaded={onLoaded} />);

    fireEvent.click(screen.getByRole("button", { name: /use sample video/i }));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledTimes(1));
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Couldn't download the sample video",
      expect.objectContaining({
        description: "Check your connection, or download it manually.",
        action: expect.objectContaining({ label: "Download" }),
      }),
    );
    expect(calls).toHaveLength(0);
    expect(screen.getByRole("button", { name: /use sample video/i })).toBeInTheDocument();
  });

  it("canceling an in-flight download aborts it silently (no toast, no onLoaded)", async () => {
    let capturedSignal: AbortSignal | undefined;
    const d = deferred<PickedVideoFile>();
    loadSampleVideoMock.mockImplementation(
      async (opts: { signal?: AbortSignal; onProgress?: (f: number) => void }) => {
        capturedSignal = opts.signal;
        opts.onProgress?.(0.1);
        return d.promise;
      },
    );

    const { SampleVideoButton } = await import("@/components/common/SampleVideoButton");
    const { calls, onLoaded } = trackOnLoaded();
    render(<SampleVideoButton onLoaded={onLoaded} />);

    fireEvent.click(screen.getByRole("button", { name: /use sample video/i }));
    await waitFor(() => expect(screen.getByText(/Downloading…/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /cancel sample video download/i }));

    // The component's handler relies on the real fetch/loadSampleVideo
    // rejecting once aborted; simulate that by rejecting the deferred
    // promise with an AbortError once the signal has been aborted.
    expect(capturedSignal?.aborted).toBe(true);
    d.reject(new DOMException("aborted", "AbortError"));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /use sample video/i })).toBeInTheDocument(),
    );
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("is disabled when the disabled prop is set", async () => {
    const { SampleVideoButton } = await import("@/components/common/SampleVideoButton");
    const { onLoaded } = trackOnLoaded();
    render(<SampleVideoButton onLoaded={onLoaded} disabled />);

    expect(screen.getByRole("button", { name: /use sample video/i })).toBeDisabled();
  });
});
