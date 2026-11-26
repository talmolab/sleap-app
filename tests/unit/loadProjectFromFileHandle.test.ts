/**
 * loadProjectFromFile and the browser file-picker handle: the handle from the
 * picker is taken before the read, so an open that fails (here a refused SLP
 * format) can't leave it waiting for the next open. Otherwise a later
 * drag-and-drop of a file with the same name (say a 2.x copy saved elsewhere)
 * would adopt it, and a plain Save would write over the refused file.
 */
import { describe, it, expect, beforeEach, vi } from "../bun-test";

vi.mock("@/lib/notify", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock("@/lib/resolveVideos", () => ({
  resolveExternalVideos: vi.fn(async () => {}),
}));

// The picker's handle slot, as src/platform/index.ts keeps it: one handle,
// cleared when taken.
let slot: FileSystemFileHandle | null = null;
const consume = vi.fn(() => {
  const h = slot;
  slot = null;
  return h;
});
vi.mock("@/platform/index", () => ({
  isTauri: false,
  consumeLastBrowserFileHandle: consume,
  getPlatform: vi.fn(async () => ({ isTauri: false })),
}));

// The first read is refused, the next one succeeds (under bun the real
// sleap-io.js reads no File objects, so the reader is stubbed here).
class SlpFormatError extends Error {}
let refuseNext = false;
vi.mock("@/lib/slpRead", () => ({
  loadSlp: vi.fn(async () => {
    if (refuseNext) {
      refuseNext = false;
      throw new SlpFormatError("The SLEAP labels file 'labels.slp' is in SLP format 3.0.");
    }
    return { videos: [], skeletons: [], labeledFrames: [] };
  }),
  readSlpStreaming: vi.fn(),
}));

import { loadProjectFromFile } from "@/lib/loadProject";
import { useAppStore } from "@/stores/appStore";

const handleOfRefusedFile = { kind: "file", name: "labels.slp" } as unknown as FileSystemFileHandle;

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  slot = null;
  consume.mockClear();
});

describe("loadProjectFromFile and the picker's file handle", () => {
  it("a refused pick doesn't hand its handle to the next open of a same-named file", async () => {
    // Picked with the file picker: the platform holds the file's handle.
    slot = handleOfRefusedFile;
    refuseNext = true;
    expect(await loadProjectFromFile(new File([new Uint8Array(1)], "labels.slp"))).toBe(false);
    expect(consume).toHaveBeenCalledTimes(1);
    expect(slot).toBeNull();
    expect(useAppStore.getState().projectFileHandle).toBeNull();

    // A 2.x copy with the same name, dropped in (a drop sets no handle).
    expect(await loadProjectFromFile(new File([new Uint8Array(1)], "labels.slp"))).toBe(true);
    const s = useAppStore.getState();
    expect(s.projectLoaded).toBe(true);
    expect(s.projectFileHandle).toBeNull();
  });

  it("a successful pick still keeps its handle as the Save target", async () => {
    const handle = { kind: "file", name: "labels.slp" } as unknown as FileSystemFileHandle;
    slot = handle;
    expect(await loadProjectFromFile(new File([new Uint8Array(1)], "labels.slp"))).toBe(true);
    expect(useAppStore.getState().projectFileHandle).toBe(handle);
  });
});
