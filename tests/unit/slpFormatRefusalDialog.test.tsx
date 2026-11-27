/**
 * Unit and component tests for the unified SLP format refusal flow in
 * `SlpFormatDialog`, `useSlpFormatStore`, and `slpAccess` / `slpFormat`
 * in Web mode.
 *
 * See `slpFormatRefusalDialogDesktop.test.tsx` for Desktop (`isTauri = true`)
 * `[Upgrade]` behavior and desktop caller integration.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "../bun-test";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SlpFormatError } from "@talmolab/sleap-io.js";

vi.mock("@/platform/index", () => ({
  isTauri: false,
  consumeLastBrowserFileHandle: () => null,
  getPlatform: async () => ({ isTauri: false }),
}));

const { isSlpFormatError } = await import("@/lib/slpFormat");
const {
  handleSlpFormatError,
  legacyCopyCommand,
  SLEAP_APP_RELEASES_PAGE_URL,
} = await import("@/lib/slpAccess");
const { useSlpFormatStore } = await import("@/stores/slpFormatStore");
const { useAppStore } = await import("@/stores/appStore");
const { SlpFormatDialog } = await import("@/components/dialogs/SlpFormatDialog");

const originalWindowOpen = window.open;
let windowOpenMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  useSlpFormatStore.setState({
    prompt: null,
    welcomeEnvironmentRequestSeq: 0,
  });
  windowOpenMock = vi.fn(() => null);
  window.open = windowOpenMock as unknown as typeof window.open;
});

afterEach(() => {
  cleanup();
  window.open = originalWindowOpen;
});

describe("SLP format error detection and refusal extraction", () => {
  it("recognizes real SlpFormatError instances and populates the refusal prompt", () => {
    const err = new SlpFormatError({
      message:
        "The SLEAP labels file 'trial.slp' is in SLP format 3.0, which this version of sleap-io.js cannot read.",
      labelsPath: "/data/nested/trial.slp",
      formatId: 3,
    });
    expect(isSlpFormatError(err)).toBe(true);
    expect(handleSlpFormatError(err)).toBe(true);
    const prompt = useSlpFormatStore.getState().prompt;
    expect(prompt).toMatchObject({
      kind: "refused",
      fileName: "trial.slp",
      formatId: 3,
      unsupportedFeatures: [],
    });
    if (prompt?.kind === "refused") {
      expect(prompt.detail).toContain("SLP format 3.0");
    }
  });

  it("recognizes worker-serialized SlpFormatError objects by name and parses formatId", () => {
    const serialized = {
      name: "SlpFormatError",
      message:
        "The SLEAP labels file 'worker_file.slp' is in SLP format 3.0, which cannot be read.",
    };
    expect(isSlpFormatError(serialized)).toBe(true);
    expect(handleSlpFormatError(serialized, "dir/worker_file.slp")).toBe(true);
    expect(useSlpFormatStore.getState().prompt).toMatchObject({
      kind: "refused",
      fileName: "worker_file.slp",
      formatId: 3,
    });
  });

  it("extracts unsupportedFeatures (and requiredFeatures fallback)", () => {
    const withUnsupported = new SlpFormatError({
      message: "Unsupported feature",
      labelsPath: "feat.slp",
      formatId: 3.1,
      unsupportedFeatures: ["dense_masks", "event_tracks"],
    });
    expect(handleSlpFormatError(withUnsupported)).toBe(true);
    expect(useSlpFormatStore.getState().prompt).toMatchObject({
      kind: "refused",
      fileName: "feat.slp",
      formatId: 3.1,
      unsupportedFeatures: ["dense_masks", "event_tracks"],
    });

    const withRequired = {
      name: "SlpFormatError",
      message: "Requires feature",
      requiredFeatures: ["custom_table"],
    };
    expect(handleSlpFormatError(withRequired, "req.slp")).toBe(true);
    expect(useSlpFormatStore.getState().prompt).toMatchObject({
      kind: "refused",
      fileName: "req.slp",
      formatId: null,
      unsupportedFeatures: ["custom_table"],
    });
  });

  it("returns false for non-SlpFormatError values and leaves dialog store untouched", () => {
    expect(handleSlpFormatError(new Error("disk full"))).toBe(false);
    expect(handleSlpFormatError("string error")).toBe(false);
    expect(handleSlpFormatError(null)).toBe(false);
    expect(useSlpFormatStore.getState().prompt).toBeNull();
  });

  it("builds a copyable sleap-io >= 0.10 v2 re-save snippet", () => {
    const cmd = legacyCopyCommand("session_01.slp");
    expect(cmd).toContain('sio.load_slp("session_01.slp")');
    expect(cmd).toContain('labels.save("session_01.v2.slp", slp_version="v2")');
  });
});

describe("SlpFormatDialog refusal UI and Web actions", () => {
  it("renders format 3.0 copy, v2 Python snippet, technical details, and closes cleanly on [Cancel]", () => {
    const fakeLabels = { videos: [], skeletons: [], labeledFrames: [] };
    useAppStore.setState({
      labels: fakeLabels as never,
      projectLoaded: true,
      projectPath: "/existing/project.slp",
    });

    const err = new SlpFormatError({
      message:
        "The SLEAP labels file 'new_recording.slp' is in SLP format 3.0; upgrade sleap-io.js.",
      labelsPath: "new_recording.slp",
      formatId: 3,
    });
    expect(handleSlpFormatError(err, "new_recording.slp")).toBe(true);

    render(<SlpFormatDialog />);

    const dialog = screen.getByTestId("slp-format-dialog");
    expect(dialog.textContent).toContain("This file can't be opened");
    expect(dialog.textContent).toContain("new_recording.slp");
    expect(dialog.textContent).toContain("SLP format 3.0");
    expect(dialog.textContent).toContain('slp_version="v2"');

    // Main copy should speak in SLEAP terms, not raw "sleap-io.js" wording
    // (raw library message lives inside the collapsed <details> element).
    const summaryParagraph = dialog.querySelector("p");
    expect(summaryParagraph?.textContent).not.toContain("sleap-io.js");
    expect(dialog.querySelector("details")?.textContent).toContain(
      "upgrade sleap-io.js",
    );

    fireEvent.click(screen.getByTestId("slp-format-refusal-cancel"));

    expect(useSlpFormatStore.getState().prompt).toBeNull();
    // Existing project state must remain completely untouched.
    expect(useAppStore.getState().labels).toBe(fakeLabels as never);
    expect(useAppStore.getState().projectPath).toBe("/existing/project.slp");
    expect(useAppStore.getState().projectLoaded).toBe(true);
    expect(windowOpenMock).not.toHaveBeenCalled();
  });

  it("omits the Python 0.10 v2 snippet for format >= 4.0 and shows unsupported features when present", () => {
    void useSlpFormatStore.getState().ask({
      kind: "refused",
      fileName: "future.slp",
      formatId: 4,
      unsupportedFeatures: ["quantum_tracks"],
      detail: "SLP format 4.0",
    });

    render(<SlpFormatDialog />);

    const dialog = screen.getByTestId("slp-format-dialog");
    expect(dialog.textContent).toContain("future.slp");
    expect(dialog.textContent).toContain("SLP format 4.0");
    expect(dialog.textContent).not.toContain('slp_version="v2"');
  });

  it("Web [Upgrade]: closes modal and opens GitHub Releases in a new tab", () => {
    void useSlpFormatStore.getState().ask({
      kind: "refused",
      fileName: "labels.slp",
      formatId: 3,
      unsupportedFeatures: [],
      detail: "SLP format 3.0",
    });

    render(<SlpFormatDialog />);
    fireEvent.click(screen.getByTestId("slp-format-refusal-upgrade"));

    expect(useSlpFormatStore.getState().prompt).toBeNull();
    expect(windowOpenMock).toHaveBeenCalledTimes(1);
    expect(windowOpenMock).toHaveBeenCalledWith(
      SLEAP_APP_RELEASES_PAGE_URL,
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("renders native 3.0 unread-tables choice dialog with View only vs Edit (drop unread tables)", () => {
    const answerPromise = useSlpFormatStore.getState().ask({
      kind: "open",
      fileName: "with_events.slp",
      summary: {
        formatId: 3,
        unlabeledPoints: 1,
        unlabeledUserPoints: 1,
        unlabeledPredictedPoints: 0,
        metadataKeys: { instances: ["annotator"], frames: [], bboxes: [] },
        unknownColumns: [],
        unreadTables: ["event_types", "events"],
        lossless: false,
      },
    });

    render(<SlpFormatDialog />);
    const dialog = screen.getByTestId("slp-format-dialog");
    expect(dialog.textContent).toContain("with_events.slp");
    expect(dialog.textContent).toContain("SLP format 3.0");
    expect(dialog.textContent).toContain("Saving writes SLP format 3.0");
    expect(screen.getByTestId("slp-format-drops").textContent).toContain("event_types, events");
    expect(screen.getByRole("button", { name: "View only" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit (drop unread tables)" }));
    return expect(answerPromise).resolves.toBe("keep");
  });
});
