/**
 * The Export Labels Package dialog closes as soon as Export is clicked, before
 * the export runs: the export's progress overlay (with Cancel) sits below
 * dialogs, so a dialog left open for the whole export hid it and the window
 * looked frozen. (PyQt closes its options too, then shows the progress dialog.)
 */
import { describe, it, expect, vi } from "../bun-test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useAppStore } from "@/stores/appStore";

const events: string[] = [];
vi.mock("@/commands/CommandContext", () => ({
  commandContext: {
    execute: async (cmd: { name: string }) => {
      events.push(`execute:${cmd.name}`);
    },
  },
}));

const { ExportPackageDialog } = await import("@/components/dialogs/ExportPackageDialog");

describe("ExportPackageDialog", () => {
  it("closes before the export starts, so its progress overlay is visible", async () => {
    useAppStore.setState({
      labels: { videos: [], labeledFrames: [], suggestions: [] } as never,
    });
    render(
      <ExportPackageDialog open={true} onOpenChange={(open) => events.push(`open:${open}`)} />
    );
    fireEvent.click(screen.getByText("Export"));
    await waitFor(() => expect(events.length).toBe(2));
    expect(events).toEqual(["open:false", "execute:ExportTrainingPackage"]);
  });
});
