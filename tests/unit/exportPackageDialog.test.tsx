/**
 * The Export Labels Package dialog closes as soon as Export is clicked, before
 * the export runs: the export's progress overlay (with Cancel) sits below
 * dialogs, so a dialog left open for the whole export hid it and the window
 * looked frozen. (PyQt closes its options too, then shows the progress dialog.)
 *
 * It also offers the frame format (#512): PNG by default, or JPEG with a
 * quality, remembered per user; with a sleap-io.js that can't write JPEG, the
 * JPEG choice is disabled with the reason. Which answer the installed
 * sleap-io.js gives is set with the compatibility module's test switch, so
 * both are tested against either pin.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "../bun-test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { useAppStore } from "@/stores/appStore";
import { __setJpegFramesSupported, JPEG_FRAMES_UNAVAILABLE } from "@/lib/slpFormatCompat";

const events: string[] = [];
const params: unknown[] = [];
vi.mock("@/commands/CommandContext", () => ({
  commandContext: {
    execute: async (cmd: { name: string }, p?: unknown) => {
      events.push(`execute:${cmd.name}`);
      params.push(p);
    },
  },
}));

const { ExportPackageDialog } = await import("@/components/dialogs/ExportPackageDialog");

beforeEach(() => {
  events.length = 0;
  params.length = 0;
  useAppStore.setState({
    labels: { videos: [], labeledFrames: [], suggestions: [] } as never,
    packageImageFormat: "png",
    packageJpegQuality: 95,
  });
});
afterEach(() => {
  cleanup();
  __setJpegFramesSupported(null);
});

function renderDialog() {
  return render(
    <ExportPackageDialog open={true} onOpenChange={(open) => events.push(`open:${open}`)} />
  );
}

const radio = (name: string) => screen.getByRole("radio", { name }) as HTMLButtonElement;
const exportButton = () => screen.getByText("Export") as HTMLButtonElement;

describe("ExportPackageDialog", () => {
  it("closes before the export starts, so its progress overlay is visible", async () => {
    renderDialog();
    fireEvent.click(exportButton());
    await waitFor(() => expect(events.length).toBe(2));
    expect(events).toEqual(["open:false", "execute:ExportTrainingPackage"]);
  });

  it("exports PNG frames by default, and says JPEG is lossy", async () => {
    __setJpegFramesSupported(true);
    renderDialog();
    expect(radio("PNG (lossless)").getAttribute("aria-checked")).toBe("true");
    expect(radio("JPEG").getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByLabelText("Quality")).toBeNull();
    expect(screen.getByText(/JPEG is lossy/)).toBeTruthy();
    fireEvent.click(exportButton());
    await waitFor(() => expect(params.length).toBe(1));
    expect(params[0]).toEqual({ image: { format: "png", quality: 95 } });
  });

  it("exports JPEG at the chosen quality, and remembers the choice", async () => {
    __setJpegFramesSupported(true);
    renderDialog();
    fireEvent.click(radio("JPEG"));
    const quality = screen.getByLabelText("Quality") as HTMLInputElement;
    expect(quality.value).toBe("95");
    fireEvent.change(quality, { target: { value: "80" } });
    fireEvent.click(exportButton());
    await waitFor(() => expect(params.length).toBe(1));
    expect(params[0]).toEqual({ image: { format: "jpg", quality: 80 } });
    expect(useAppStore.getState().packageImageFormat).toBe("jpg");
    expect(useAppStore.getState().packageJpegQuality).toBe(80);

    // Opened again: the last choice.
    cleanup();
    renderDialog();
    expect(radio("JPEG").getAttribute("aria-checked")).toBe("true");
    expect((screen.getByLabelText("Quality") as HTMLInputElement).value).toBe("80");
  });

  it("can't export a JPEG quality outside 1-100", () => {
    __setJpegFramesSupported(true);
    useAppStore.setState({ packageImageFormat: "jpg", packageJpegQuality: 90 });
    renderDialog();
    const quality = screen.getByLabelText("Quality") as HTMLInputElement;
    for (const bad of ["0", "101", "", "80.5"]) {
      fireEvent.change(quality, { target: { value: bad } });
      expect(exportButton().disabled).toBe(true);
      expect(screen.getByText("Enter a quality from 1 to 100.")).toBeTruthy();
    }
    fireEvent.change(quality, { target: { value: "100" } });
    expect(exportButton().disabled).toBe(false);
    // Read as the number typed, not its leading digits.
    fireEvent.change(quality, { target: { value: "1e2" } });
    expect(exportButton().disabled).toBe(false);
    // Switching back to PNG needs no quality.
    fireEvent.change(quality, { target: { value: "" } });
    fireEvent.click(radio("PNG (lossless)"));
    expect(exportButton().disabled).toBe(false);
  });

  it("disables JPEG, with the reason, when sleap-io.js can't write it, and exports PNG", async () => {
    __setJpegFramesSupported(false);
    useAppStore.setState({ packageImageFormat: "jpg", packageJpegQuality: 80 });
    renderDialog();
    expect(radio("JPEG").disabled).toBe(true);
    expect(radio("PNG (lossless)").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(`JPEG: ${JPEG_FRAMES_UNAVAILABLE}`)).toBeTruthy();
    expect(screen.queryByText(/JPEG is lossy/)).toBeNull();
    fireEvent.click(exportButton());
    await waitFor(() => expect(params.length).toBe(1));
    expect(params[0]).toEqual({ image: { format: "png", quality: 80 } });
    // The remembered JPEG choice is kept for a build that can write it.
    expect(useAppStore.getState().packageImageFormat).toBe("jpg");
    expect(useAppStore.getState().packageJpegQuality).toBe(80);
  });

  it("says that frames already stored as JPEG stay JPEG", () => {
    __setJpegFramesSupported(true);
    renderDialog();
    expect(screen.getByText(/already stores as JPEG stay JPEG with PNG chosen/)).toBeTruthy();
    expect(screen.getByText(/usually several times smaller/)).toBeTruthy();
  });
});
