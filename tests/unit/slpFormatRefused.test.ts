/**
 * A `.slp` in a format the pinned sleap-io.js cannot read (format >= 4.0, or a
 * required feature it doesn't know) is refused by the library with
 * `SlpFormatError`, instead of loading as an empty project. These tests run the
 * real library on a format 4.0 fixture and check what the app does with the
 * refusal on each way a `.slp` comes in:
 *
 * - opening a project by path (desktop: Open, Open With, drag-and-drop, which
 *   all end in loadProjectFromPath): opens the SLP format refusal modal (no
 *   raw error toast), and installs nothing in the store, so no project path or
 *   file handle points at the refused file and a later Save cannot write over
 *   it;
 * - a project already open stays open, unchanged, with its own path;
 * - non-format load failures still surface through the error toast;
 * - Merge into Project and prediction overlays (loadLabelsFromSlpPath):
 *   the read rejects with the library's message, which both callers handle;
 * - importing a skeleton from a `.slp`: the same, naming the user's file.
 *
 * Also verifies that a supported format 3.0 file (`format3_minimal.slp`) opens
 * cleanly without refusal on sleap-io.js 0.6.0+.
 */

import { describe, it, expect, beforeEach, vi } from "../bun-test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/notify", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
// The 2.x fixture references an external MP4 whose backend never settles under
// bun (precedent: loadProgress.test.ts). Video resolution is not under test.
vi.mock("@/lib/resolveVideos", () => ({
  resolveExternalVideos: vi.fn(async () => {}),
}));

import { SlpFormatError } from "@talmolab/sleap-io.js";
import { loadLabelsFromSlpPath, loadProjectFromPath } from "@/lib/loadProject";
import { loadAndAnalyze } from "@/lib/modelOverlay/load";
import { parseSkeletonFile } from "@/lib/skeletonIO";
import { useAppStore } from "@/stores/appStore";
import { useSlpFormatStore } from "@/stores/slpFormatStore";
import { toast } from "@/lib/notify";

const FORMAT4 = join(import.meta.dir, "../fixtures/format4_stub.slp");
const FORMAT3 = join(import.meta.dir, "../fixtures/format3_minimal.slp");
const V2 = join(import.meta.dir, "../fixtures/minimal_instance.slp");

type Mock = { mock: { calls: unknown[][] }; mockClear: () => void };
const toastError = toast.error as unknown as Mock;

function format4Bytes(): Uint8Array {
  return new Uint8Array(readFileSync(FORMAT4));
}

function format3Bytes(): Uint8Array {
  return new Uint8Array(readFileSync(FORMAT3));
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  useSlpFormatStore.setState({ prompt: null, welcomeEnvironmentRequestSeq: 0 });
  toastError.mockClear();
  (toast.success as unknown as Mock).mockClear();
});

describe("an unsupported format >= 4.0 .slp is refused cleanly", () => {
  it("open by path (desktop): opens the refusal modal, no error toast, nothing loaded", async () => {
    const ok = await loadProjectFromPath(FORMAT4, async () => format4Bytes());
    expect(ok).toBe(false);

    expect(toastError.mock.calls.length).toBe(0);
    const prompt = useSlpFormatStore.getState().prompt;
    expect(prompt).not.toBeNull();
    expect(prompt?.kind).toBe("refused");
    if (prompt?.kind === "refused") {
      expect(prompt.fileName).toBe("format4_stub.slp");
      expect(prompt.formatId).toBe(4);
      expect(prompt.detail).toContain("SLP format 4.0");
    }

    const s = useAppStore.getState();
    expect(s.labels).toBeNull();
    expect(s.projectLoaded).toBe(false);
    expect(s.projectPath).toBeNull();
    expect(s.isLoading).toBe(false);
    expect(toast.success).not.toHaveBeenCalled();
  });

  // Desktop routing opens a file into a new window when one is loaded; the
  // browser opens it over the current project, which this case stands for.
  it("leaves an open project as it was, so Save still targets that project's file", async () => {
    const v2 = new Uint8Array(readFileSync(V2));
    expect(await loadProjectFromPath(V2, async () => v2)).toBe(true);
    const before = useAppStore.getState();
    const labelsBefore = before.labels;
    expect(labelsBefore).not.toBeNull();
    expect(before.projectPath).toBe(V2);

    expect(await loadProjectFromPath(FORMAT4, async () => format4Bytes())).toBe(false);

    const after = useAppStore.getState();
    expect(after.labels).toBe(labelsBefore);
    expect(after.projectPath).toBe(V2);
    expect(after.projectLoaded).toBe(true);
    expect(after.isLoading).toBe(false);
    expect(toastError.mock.calls.length).toBe(0);
    const prompt = useSlpFormatStore.getState().prompt;
    expect(prompt?.kind).toBe("refused");
    if (prompt?.kind === "refused") {
      expect(prompt.fileName).toBe("format4_stub.slp");
      expect(prompt.formatId).toBe(4);
    }
  });

  it("still shows toast.error for non-format load failures", async () => {
    const ok = await loadProjectFromPath("/tmp/missing.slp", async () => {
      throw new Error("ENOENT: no such file");
    });
    expect(ok).toBe(false);
    expect(useSlpFormatStore.getState().prompt).toBeNull();
    expect(toastError.mock.calls.length).toBe(1);
    const [title, opts] = toastError.mock.calls[0] as [string, { description: string }];
    expect(title).toBe("Failed to load project");
    expect(opts.description).toContain("ENOENT");
  });

  it("Merge into Project / overlay reads reject with SlpFormatError", async () => {
    const err = await loadLabelsFromSlpPath(FORMAT4, async () => format4Bytes()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SlpFormatError);
    expect((err as Error).message).toContain("format4_stub.slp");
    expect((err as Error).message).toContain("SLP format 4.0");
  });

  it("a prediction overlay file comes back not usable, with the message as the reason", async () => {
    const result = await loadAndAnalyze(
      FORMAT4,
      { path: "video.mp4", frameCount: null, height: null, width: null },
      [],
      {
        loadPath: (p) => loadLabelsFromSlpPath(p, async () => format4Bytes()),
        loadFile: () => Promise.reject(new Error("not used")),
      },
    );
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain("SLP format 4.0");
  });

  it("skeleton import from a .slp rejects with the library's message", async () => {
    const err = await parseSkeletonFile("format4_stub.slp", format4Bytes()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SlpFormatError);
    // Names the user's file, not the reader's default "slp-data.slp".
    expect((err as Error).message).toContain("'format4_stub.slp'");
    expect((err as Error).message).toContain("SLP format 4.0");
  });

  it("a supported format 3.0 .slp opens directly without refusal", async () => {
    const ok = await loadProjectFromPath(FORMAT3, async () => format3Bytes());
    expect(ok).toBe(true);
    expect(useSlpFormatStore.getState().prompt).toBeNull();
    expect(toastError.mock.calls.length).toBe(0);
    expect(useAppStore.getState().labels?.sourceFormat?.formatId).toBe(3);
    expect(useAppStore.getState().labels?.sourceFormat?.access).toBe("keep");
  });
});
