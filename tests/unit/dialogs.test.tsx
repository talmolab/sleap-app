/**
 * Tests for dialog components.
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from "../bun-test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useAppStore } from "@/stores/appStore";

// Mock platform module
vi.mock("@/lib/platform", () => ({
  isTauri: false,
  isMac: false,
  modKey: "Ctrl",
}));

// Mock sonner toast for commands
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

// Mock ResizeObserver for Radix Select/Slider components
beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

/** Reset the store between tests. */
function resetStore() {
  useAppStore.setState(useAppStore.getInitialState());
}

describe("Dialog components", () => {
  beforeEach(() => {
    resetStore();
  });

  describe("GoToFrameDialog", () => {
    it("renders when open", async () => {
      useAppStore.getState().setGoToFrameDialogOpen(true);

      const { GoToFrameDialog } = await import(
        "@/components/dialogs/GoToFrameDialog"
      );
      render(<GoToFrameDialog />);

      expect(screen.getByText("Go to Frame")).toBeInTheDocument();
    });

    it("does not render content when closed", async () => {
      useAppStore.getState().setGoToFrameDialogOpen(false);

      const { GoToFrameDialog } = await import(
        "@/components/dialogs/GoToFrameDialog"
      );
      render(<GoToFrameDialog />);

      expect(screen.queryByText("Go to Frame")).not.toBeInTheDocument();
    });

    it("has an input for frame number", async () => {
      useAppStore.getState().setGoToFrameDialogOpen(true);

      const { GoToFrameDialog } = await import(
        "@/components/dialogs/GoToFrameDialog"
      );
      render(<GoToFrameDialog />);

      const input = screen.getByRole("spinbutton");
      expect(input).toBeInTheDocument();
    });

    it("has Go and Cancel buttons", async () => {
      useAppStore.getState().setGoToFrameDialogOpen(true);

      const { GoToFrameDialog } = await import(
        "@/components/dialogs/GoToFrameDialog"
      );
      render(<GoToFrameDialog />);

      expect(screen.getByText("Go")).toBeInTheDocument();
      expect(screen.getByText("Cancel")).toBeInTheDocument();
    });

    it("shows valid range when video has shape", async () => {
      const video = {
        filename: "test.mp4",
        shape: [100, 480, 640, 3],
        backend: null,
        source_video: null,
      };
      useAppStore.setState({
        video: video as unknown as import("@/types").Video,
        goToFrameDialogOpen: true,
      });

      const { GoToFrameDialog } = await import(
        "@/components/dialogs/GoToFrameDialog"
      );
      render(<GoToFrameDialog />);

      expect(screen.getByText("Valid range: 0 to 99")).toBeInTheDocument();
    });
  });

  describe("InferencePanel", () => {
    it("renders without crashing", async () => {
      const { InferencePanel } = await import(
        "@/components/panels/InferencePanel"
      );
      render(<InferencePanel />);
      // Should render something (desktop-only message in browser mode)
      expect(document.body.textContent).toBeTruthy();
    });

    it("shows connect message in browser mode when not connected", async () => {
      const { InferencePanel } = await import(
        "@/components/panels/InferencePanel"
      );
      render(<InferencePanel />);

      expect(
        screen.getByText("Connect to a worker in the Connect tab to start remote inference.")
      ).toBeInTheDocument();
    });
  });

  describe("ShortcutsDialog", () => {
    it("renders when open", async () => {
      const { ShortcutsDialog } = await import(
        "@/components/dialogs/ShortcutsDialog"
      );
      render(<ShortcutsDialog open={true} onOpenChange={() => {}} />);

      expect(screen.getByText("Keyboard Shortcuts")).toBeInTheDocument();
    });

    it("does not render when closed", async () => {
      const { ShortcutsDialog } = await import(
        "@/components/dialogs/ShortcutsDialog"
      );
      render(<ShortcutsDialog open={false} onOpenChange={() => {}} />);

      expect(screen.queryByText("Keyboard Shortcuts")).not.toBeInTheDocument();
    });

    it("renders shortcut categories", async () => {
      const { ShortcutsDialog } = await import(
        "@/components/dialogs/ShortcutsDialog"
      );
      render(<ShortcutsDialog open={true} onOpenChange={() => {}} />);

      expect(screen.getByText("File")).toBeInTheDocument();
      expect(screen.getByText("Navigation")).toBeInTheDocument();
      expect(screen.getByText("Editing")).toBeInTheDocument();
      expect(screen.getByText("View")).toBeInTheDocument();
      expect(screen.getByText("Tracks")).toBeInTheDocument();
    });
  });

  describe("HelpDialog", () => {
    it("renders when open", async () => {
      const { HelpDialog } = await import(
        "@/components/dialogs/HelpDialog"
      );
      render(<HelpDialog open={true} onOpenChange={() => {}} />);

      expect(screen.getByText("About SLEAP Label")).toBeInTheDocument();
    });

    it("does not render when closed", async () => {
      const { HelpDialog } = await import(
        "@/components/dialogs/HelpDialog"
      );
      render(<HelpDialog open={false} onOpenChange={() => {}} />);

      expect(screen.queryByText("About SLEAP Label")).not.toBeInTheDocument();
    });

    it("shows version", async () => {
      const { HelpDialog } = await import(
        "@/components/dialogs/HelpDialog"
      );
      render(<HelpDialog open={true} onOpenChange={() => {}} />);

      expect(screen.getByText(/Version/)).toBeInTheDocument();
    });

    it("shows SLEAP Label Web title", async () => {
      const { HelpDialog } = await import(
        "@/components/dialogs/HelpDialog"
      );
      render(<HelpDialog open={true} onOpenChange={() => {}} />);

      expect(screen.getByText("SLEAP Label Web")).toBeInTheDocument();
    });

    it("has links to sleap.ai and GitHub", async () => {
      const { HelpDialog } = await import(
        "@/components/dialogs/HelpDialog"
      );
      render(<HelpDialog open={true} onOpenChange={() => {}} />);

      expect(screen.getByText("sleap.ai")).toBeInTheDocument();
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });

    it("has link to Talmo Lab", async () => {
      const { HelpDialog } = await import(
        "@/components/dialogs/HelpDialog"
      );
      render(<HelpDialog open={true} onOpenChange={() => {}} />);

      expect(screen.getByText("Talmo Lab")).toBeInTheDocument();
    });
  });

  describe("DeletePredictionsDialog", () => {
    it("renders when open", async () => {
      const { DeletePredictionsDialog } = await import(
        "@/components/dialogs/DeletePredictionsDialog"
      );
      render(<DeletePredictionsDialog open={true} onOpenChange={() => {}} />);

      expect(screen.getByText("Delete Predictions")).toBeInTheDocument();
    });

    it("does not render when closed", async () => {
      const { DeletePredictionsDialog } = await import(
        "@/components/dialogs/DeletePredictionsDialog"
      );
      render(<DeletePredictionsDialog open={false} onOpenChange={() => {}} />);

      expect(screen.queryByText("Delete Predictions")).not.toBeInTheDocument();
    });

    it("has Delete and Cancel buttons", async () => {
      const { DeletePredictionsDialog } = await import(
        "@/components/dialogs/DeletePredictionsDialog"
      );
      render(<DeletePredictionsDialog open={true} onOpenChange={() => {}} />);

      expect(screen.getByText("Delete")).toBeInTheDocument();
      expect(screen.getByText("Cancel")).toBeInTheDocument();
    });

    it("shows deletion method selector", async () => {
      const { DeletePredictionsDialog } = await import(
        "@/components/dialogs/DeletePredictionsDialog"
      );
      render(<DeletePredictionsDialog open={true} onOpenChange={() => {}} />);

      expect(screen.getByText("Deletion method")).toBeInTheDocument();
    });
  });

  describe("ExportDialog", () => {
    it("renders when labels exist", async () => {
      useAppStore.setState({
        labels: {
          videos: [],
          skeletons: [],
          labeledFrames: [],
          tracks: [],
          suggestions: [],
          provenance: {},
          find: () => [],
          append: () => {},
        } as unknown as import("@/types").Labels,
        projectLoaded: true,
      });

      const { ExportDialog } = await import(
        "@/components/dialogs/ExportDialog"
      );
      render(<ExportDialog open={true} onOpenChange={() => {}} />);

      expect(screen.getByText("Export")).toBeInTheDocument();
    });

    it("shows export options", async () => {
      useAppStore.setState({
        labels: {
          videos: [],
          skeletons: [],
          labeledFrames: [],
          tracks: [],
          suggestions: [],
          provenance: {},
          find: () => [],
          append: () => {},
        } as unknown as import("@/types").Labels,
        projectLoaded: true,
      });

      const { ExportDialog } = await import(
        "@/components/dialogs/ExportDialog"
      );
      render(<ExportDialog open={true} onOpenChange={() => {}} />);

      expect(screen.getByText("Analysis CSV")).toBeInTheDocument();
      expect(screen.getByText("Save As JSON")).toBeInTheDocument();
      expect(screen.getByText("JSON Package")).toBeInTheDocument();
    });

    it("returns null when no labels", async () => {
      // No labels loaded
      const { ExportDialog } = await import(
        "@/components/dialogs/ExportDialog"
      );
      render(<ExportDialog open={true} onOpenChange={() => {}} />);

      // Should not render anything meaningful
      expect(screen.queryByText("Export")).not.toBeInTheDocument();
    });
  });

  describe("NewProjectDialog (#138)", () => {
    it("renders when open", async () => {
      useAppStore.getState().setNewProjectDialogOpen(true);
      const { NewProjectDialog } = await import(
        "@/components/dialogs/NewProjectDialog"
      );
      render(<NewProjectDialog />);
      expect(screen.getByText("New Project")).toBeInTheDocument();
      expect(screen.getByText("Create Project")).toBeInTheDocument();
    });

    it("creates a usable empty project on Create (seeded skeleton, no videos)", async () => {
      useAppStore.getState().setNewProjectDialogOpen(true);
      const { NewProjectDialog } = await import(
        "@/components/dialogs/NewProjectDialog"
      );
      render(<NewProjectDialog />);
      // Default skeleton is "Empty" — Create without touching the Select/picker.
      fireEvent.click(screen.getByText("Create Project"));
      await waitFor(() => {
        expect(useAppStore.getState().projectLoaded).toBe(true);
      });
      const s = useAppStore.getState();
      expect(s.labels?.skeletons.length).toBe(1);
      expect(s.skeleton?.nodes.length).toBe(0);
      expect(s.labels?.videos.length).toBe(0);
      expect(s.newProjectDialogOpen).toBe(false); // dialog closed after create
    });
  });
});
