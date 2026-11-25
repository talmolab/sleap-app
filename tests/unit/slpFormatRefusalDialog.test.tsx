/**
 * Unit and component tests for the SLP format refusal modal
 * (`SlpFormatRefusalDialog`), its store (`useSlpFormatDialogStore`), and the
 * `slpFormatRefusal` error detection/extraction helpers in Web mode.
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

const {
  isSlpFormatError,
  extractSlpFormatRefusal,
  handleSlpFormatError,
  legacyV2CopyCommand,
  SLEAP_APP_RELEASES_PAGE_URL,
} = await import("@/lib/slpFormatRefusal");
const { useSlpFormatDialogStore } = await import(
  "@/stores/slpFormatDialogStore"
);
const { useAppStore } = await import("@/stores/appStore");
const { SlpFormatRefusalDialog } = await import(
  "@/components/dialogs/SlpFormatRefusalDialog"
);

const originalWindowOpen = window.open;
let windowOpenMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  useSlpFormatDialogStore.setState({
    refusal: null,
    welcomeEnvironmentRequestSeq: 0,
  });
  windowOpenMock = vi.fn(() => null);
  window.open = windowOpenMock as unknown as typeof window.open;
});

afterEach(() => {
  cleanup();
  window.open = originalWindowOpen;
});

describe("slpFormatRefusal error detection and extraction", () => {
  it("recognizes real SlpFormatError instances and extracts fields", () => {
    const err = new SlpFormatError({
      message:
        "The SLEAP labels file 'trial.slp' is in SLP format 3.0, which this version of sleap-io.js cannot read.",
      labelsPath: "/data/nested/trial.slp",
      formatId: 3,
    });
    expect(isSlpFormatError(err)).toBe(true);
    const info = extractSlpFormatRefusal(err);
    expect(info.fileName).toBe("trial.slp");
    expect(info.formatId).toBe(3);
    expect(info.unsupportedFeatures).toEqual([]);
    expect(info.detail).toContain("SLP format 3.0");
  });

  it("recognizes worker-serialized SlpFormatError objects by name and parses formatId", () => {
    const serialized = {
      name: "SlpFormatError",
      message:
        "The SLEAP labels file 'worker_file.slp' is in SLP format 3.0, which cannot be read.",
    };
    expect(isSlpFormatError(serialized)).toBe(true);
    const info = extractSlpFormatRefusal(serialized, "dir/worker_file.slp");
    expect(info.fileName).toBe("worker_file.slp");
    expect(info.formatId).toBe(3);
  });

  it("extracts unsupportedFeatures (and requiredFeatures fallback)", () => {
    const withUnsupported = new SlpFormatError({
      message: "Unsupported feature",
      labelsPath: "feat.slp",
      formatId: 3.1,
      unsupportedFeatures: ["dense_masks", "event_tracks"],
    });
    expect(extractSlpFormatRefusal(withUnsupported).unsupportedFeatures).toEqual(
      ["dense_masks", "event_tracks"],
    );

    const withRequired = {
      name: "SlpFormatError",
      message: "Requires feature",
      requiredFeatures: ["custom_table"],
    };
    expect(extractSlpFormatRefusal(withRequired, "req.slp")).toMatchObject({
      fileName: "req.slp",
      formatId: null,
      unsupportedFeatures: ["custom_table"],
    });
  });

  it("returns false for non-SlpFormatError values and leaves dialog store untouched", () => {
    expect(handleSlpFormatError(new Error("disk full"))).toBe(false);
    expect(handleSlpFormatError("string error")).toBe(false);
    expect(handleSlpFormatError(null)).toBe(false);
    expect(useSlpFormatDialogStore.getState().refusal).toBeNull();
  });

  it("builds a copyable sleap-io >= 0.10 v2 re-save snippet", () => {
    const cmd = legacyV2CopyCommand("session_01.slp");
    expect(cmd).toContain('sio.load_slp("session_01.slp")');
    expect(cmd).toContain('labels.save("session_01.v2.slp", slp_version="v2")');
  });
});

describe("SlpFormatRefusalDialog UI and Web actions", () => {
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

    render(<SlpFormatRefusalDialog />);

    const dialog = screen.getByTestId("slp-format-refusal-dialog");
    expect(dialog.textContent).toContain("Unsupported SLP format");
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

    expect(useSlpFormatDialogStore.getState().refusal).toBeNull();
    // Existing project state must remain completely untouched.
    expect(useAppStore.getState().labels).toBe(fakeLabels as never);
    expect(useAppStore.getState().projectPath).toBe("/existing/project.slp");
    expect(useAppStore.getState().projectLoaded).toBe(true);
    expect(windowOpenMock).not.toHaveBeenCalled();
  });

  it("omits the Python 0.10 v2 snippet for format >= 4.0 and shows unsupported features when present", () => {
    useSlpFormatDialogStore.getState().open({
      fileName: "future.slp",
      formatId: 4,
      unsupportedFeatures: ["quantum_tracks"],
      detail: "SLP format 4.0",
    });

    render(<SlpFormatRefusalDialog />);

    const dialog = screen.getByTestId("slp-format-refusal-dialog");
    expect(dialog.textContent).toContain("future.slp");
    expect(dialog.textContent).toContain("SLP format 4.0");
    expect(dialog.textContent).toContain("quantum_tracks");
    expect(dialog.textContent).not.toContain('slp_version="v2"');
  });

  it("Web [Upgrade]: closes modal and opens GitHub Releases in a new tab", () => {
    useSlpFormatDialogStore.getState().open({
      fileName: "labels.slp",
      formatId: 3,
      unsupportedFeatures: [],
      detail: "SLP format 3.0",
    });

    render(<SlpFormatRefusalDialog />);
    fireEvent.click(screen.getByTestId("slp-format-refusal-upgrade"));

    expect(useSlpFormatDialogStore.getState().refusal).toBeNull();
    expect(windowOpenMock).toHaveBeenCalledTimes(1);
    expect(windowOpenMock).toHaveBeenCalledWith(
      SLEAP_APP_RELEASES_PAGE_URL,
      "_blank",
      "noopener,noreferrer",
    );
  });
});
