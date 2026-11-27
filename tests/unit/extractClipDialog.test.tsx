/**
 * Labels → Extract Clip options dialog (PyQt's Export Clip Options): shows the
 * seekbar range and what it holds, asks for the clip's fps (default: the
 * video's), closes before running so the progress overlay shows, and passes
 * the options to the command. Without a range, Extract is disabled. The
 * package variant offers the frame format, as Export Labels Package does.
 */
import { describe, it, expect, beforeEach, vi } from "../bun-test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useAppStore } from "@/stores/appStore";

const events: Array<{ name: string; params?: unknown; dialogOpen: unknown }> = [];
vi.mock("@/commands/CommandContext", () => ({
  commandContext: {
    execute: async (cmd: { name: string }, params?: unknown) => {
      events.push({ name: cmd.name, params, dialogOpen: useAppStore.getState().extractClipDialog });
    },
  },
}));

const { ExtractClipDialog } = await import("@/components/dialogs/ExtractClipDialog");

const video = { filename: "/data/mice.mp4", shape: [100, 32, 48, 1], fps: 25 };
const labels = {
  videos: [video],
  labeledFrames: [5, 20, 40, 90].map((frameIdx) => ({ video, frameIdx })),
  suggestions: [10, 40, 60].map((frameIdx) => ({ video, frameIdx })),
};

beforeEach(() => {
  events.length = 0;
  useAppStore.setState({
    labels: labels as never,
    video: video as never,
    frameRange: [10, 40],
    packageImageFormat: "png",
    packageJpegQuality: 95,
  });
});

describe("ExtractClipDialog", () => {
  it("shows the range, then runs the clip command with the fps, closed first", async () => {
    useAppStore.getState().setExtractClipDialog("clip");
    render(<ExtractClipDialog />);
    expect(screen.getByText(/Frames 10–40 \(31 frames\)/)).toBeTruthy();
    expect(screen.getByText("2 labeled, 2 suggested")).toBeTruthy();
    const fps = screen.getByLabelText("Frames per second") as HTMLInputElement;
    expect(fps.value).toBe("25");
    fireEvent.change(fps, { target: { value: "12" } });
    fireEvent.click(screen.getByText("Extract"));
    await waitFor(() => expect(events.length).toBe(1));
    expect(events[0]).toEqual({
      name: "ExtractClipAndLabels",
      params: { fps: 12, openWhenDone: true },
      dialogOpen: null,
    });
  });

  it("runs the package command without an fps, with PNG frames by default", async () => {
    useAppStore.getState().setExtractClipDialog("package");
    render(<ExtractClipDialog />);
    expect(screen.queryByLabelText("Frames per second")).toBeNull();
    fireEvent.click(screen.getByText("Extract"));
    await waitFor(() => expect(events.length).toBe(1));
    expect(events[0].name).toBe("ExtractClipLabelsPackage");
    expect(events[0].params).toEqual({ openWhenDone: true, image: { format: "png", quality: 95 } });
  });

  it("runs the package command with JPEG frames when chosen, and remembers it", async () => {
    useAppStore.getState().setExtractClipDialog("package");
    render(<ExtractClipDialog />);
    fireEvent.click(screen.getByRole("radio", { name: "JPEG" }));
    fireEvent.change(screen.getByLabelText("Quality"), { target: { value: "70" } });
    fireEvent.click(screen.getByText("Extract"));
    await waitFor(() => expect(events.length).toBe(1));
    expect(events[0].params).toEqual({ openWhenDone: true, image: { format: "jpg", quality: 70 } });
    expect(useAppStore.getState().packageImageFormat).toBe("jpg");
    expect(useAppStore.getState().packageJpegQuality).toBe(70);
  });

  it("offers no frame format for a clip (its video is not a package)", () => {
    useAppStore.getState().setExtractClipDialog("clip");
    render(<ExtractClipDialog />);
    expect(screen.queryByText("Frame images")).toBeNull();
  });

  it("can't extract without a selected range", () => {
    useAppStore.setState({ frameRange: null });
    useAppStore.getState().setExtractClipDialog("clip");
    render(<ExtractClipDialog />);
    expect(screen.getByText(/shift-drag on the seekbar/)).toBeTruthy();
    expect((screen.getByText("Extract") as HTMLButtonElement).disabled).toBe(true);
  });
});
