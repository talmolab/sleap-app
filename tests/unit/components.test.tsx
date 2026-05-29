/**
 * Basic component rendering tests.
 */

import { describe, it, expect, beforeEach, vi } from "../bun-test";
import { render, screen } from "@testing-library/react";
import { useAppStore } from "@/stores/appStore";

// Mock the useFileIO hook used by WelcomeScreen
vi.mock("@/hooks/useFileIO", () => ({
  useFileIO: () => ({
    openProject: vi.fn(),
    openFromDrop: vi.fn(),
    loading: false,
    error: null,
  }),
}));

// Mock the platform module used by WelcomeScreen
vi.mock("@/lib/platform", () => ({
  isTauri: false,
  isMac: false,
  modKey: "Ctrl",
}));

// Mock sonner toast for MenuBar
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

/** Reset the store between tests. */
function resetStore() {
  useAppStore.setState(useAppStore.getInitialState());
}

describe("Component rendering", () => {
  beforeEach(() => {
    resetStore();
  });

  describe("StatusBar", () => {
    it("renders without crashing", async () => {
      const { StatusBar } = await import(
        "@/components/layout/StatusBar"
      );
      const { container } = render(<StatusBar />);
      expect(container).toBeTruthy();
    });

    it("shows 'No project loaded' when no labels", async () => {
      const { StatusBar } = await import(
        "@/components/layout/StatusBar"
      );
      render(<StatusBar />);
      expect(screen.getByText("No project loaded")).toBeInTheDocument();
    });

    it("shows filename when project is loaded", async () => {
      useAppStore.setState({
        filename: "test_project.slp",
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
        video: {
          filename: "test.mp4",
          shape: [100, 480, 640, 3],
        } as unknown as import("@/types").Video,
      });

      const { StatusBar } = await import(
        "@/components/layout/StatusBar"
      );
      render(<StatusBar />);
      expect(screen.getByText(/test_project\.slp/)).toBeInTheDocument();
    });

    it("shows asterisk when project has unsaved changes", async () => {
      useAppStore.setState({
        filename: "project.slp",
        hasChanges: true,
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
        video: {
          filename: "test.mp4",
          shape: [100, 480, 640, 3],
        } as unknown as import("@/types").Video,
      });

      const { StatusBar } = await import(
        "@/components/layout/StatusBar"
      );
      render(<StatusBar />);
      expect(screen.getByText(/project\.slp \*/)).toBeInTheDocument();
    });

    it("shows frame information with video", async () => {
      useAppStore.setState({
        filename: "test.slp",
        frameIdx: 42,
        labels: {
          videos: [{ filename: "test.mp4", shape: [100, 480, 640, 3] }],
          skeletons: [],
          labeledFrames: [],
          tracks: [],
          suggestions: [],
          provenance: {},
          find: () => [],
          append: () => {},
        } as unknown as import("@/types").Labels,
        projectLoaded: true,
        video: {
          filename: "test.mp4",
          shape: [100, 480, 640, 3],
        } as unknown as import("@/types").Video,
      });

      const { StatusBar } = await import(
        "@/components/layout/StatusBar"
      );
      render(<StatusBar />);
      expect(screen.getByText(/Frame 42/)).toBeInTheDocument();
    });

    it("shows labeled frame count", async () => {
      useAppStore.setState({
        filename: "test.slp",
        labels: {
          videos: [{ filename: "test.mp4", shape: [100, 480, 640, 3] }],
          skeletons: [],
          labeledFrames: [{ instances: [] }, { instances: [] }],
          tracks: [],
          suggestions: [],
          provenance: {},
          find: () => [],
          append: () => {},
        } as unknown as import("@/types").Labels,
        projectLoaded: true,
        video: {
          filename: "test.mp4",
          shape: [100, 480, 640, 3],
        } as unknown as import("@/types").Video,
      });

      const { StatusBar } = await import(
        "@/components/layout/StatusBar"
      );
      render(<StatusBar />);
      expect(screen.getByText("2 labeled")).toBeInTheDocument();
    });
  });

  describe("WelcomeScreen", () => {
    it("renders without crashing", async () => {
      const { WelcomeScreen } = await import(
        "@/components/layout/WelcomeScreen"
      );
      const { container } = render(<WelcomeScreen />);
      expect(container).toBeTruthy();
    });

    it("has Open Project button", async () => {
      const { WelcomeScreen } = await import(
        "@/components/layout/WelcomeScreen"
      );
      render(<WelcomeScreen />);
      expect(screen.getByText("Open Project")).toBeInTheDocument();
    });

    it("shows drag and drop hint", async () => {
      const { WelcomeScreen } = await import(
        "@/components/layout/WelcomeScreen"
      );
      render(<WelcomeScreen />);
      expect(
        screen.getByText(/drag and drop a .slp file/i)
      ).toBeInTheDocument();
    });

    it("shows SLEAP Label title", async () => {
      const { WelcomeScreen } = await import(
        "@/components/layout/WelcomeScreen"
      );
      render(<WelcomeScreen />);
      expect(screen.getByText("SLEAP Label")).toBeInTheDocument();
    });

    it("shows keyboard shortcut hint", async () => {
      const { WelcomeScreen } = await import(
        "@/components/layout/WelcomeScreen"
      );
      render(<WelcomeScreen />);
      expect(screen.getByText(/Ctrl\+O/)).toBeInTheDocument();
    });

    it("shows logo image", async () => {
      const { WelcomeScreen } = await import(
        "@/components/layout/WelcomeScreen"
      );
      render(<WelcomeScreen />);
      const img = screen.getByAltText("SLEAP");
      expect(img).toBeInTheDocument();
      expect(img.getAttribute("src")).toBe("/icon.png");
    });
  });

  describe("VideosPanel", () => {
    it("renders empty state", async () => {
      const { VideosPanel } = await import(
        "@/components/panels/VideosPanel"
      );
      render(<VideosPanel />);
      expect(
        screen.getByText("No videos in project.")
      ).toBeInTheDocument();
    });
  });

  describe("InstancesPanel", () => {
    it("renders empty state", async () => {
      const { InstancesPanel } = await import(
        "@/components/panels/InstancesPanel"
      );
      render(<InstancesPanel />);
      expect(
        screen.getByText("No instances on this frame.")
      ).toBeInTheDocument();
    });
  });

  describe("MenuBar", () => {
    it("renders without crashing", async () => {
      const { MenuBar } = await import(
        "@/components/layout/MenuBar"
      );
      const { container } = render(<MenuBar />);
      expect(container).toBeTruthy();
    });

    it("shows SLEAP branding", async () => {
      const { MenuBar } = await import(
        "@/components/layout/MenuBar"
      );
      render(<MenuBar />);
      expect(screen.getByText("SLEAP")).toBeInTheDocument();
    });

    it("renders all menu triggers including Help", async () => {
      const { MenuBar } = await import(
        "@/components/layout/MenuBar"
      );
      render(<MenuBar />);

      expect(screen.getByText("File")).toBeInTheDocument();
      expect(screen.getByText("Edit")).toBeInTheDocument();
      expect(screen.getByText("Go")).toBeInTheDocument();
      expect(screen.getByText("View")).toBeInTheDocument();
      expect(screen.getByText("Labels")).toBeInTheDocument();
      expect(screen.getByText("Predict")).toBeInTheDocument();
      expect(screen.getByText("Tracks")).toBeInTheDocument();
      // Help menu should exist
      expect(screen.getByText("Help")).toBeInTheDocument();
    });
  });

  describe("SuggestionsPanel", () => {
    it("renders empty state", async () => {
      const { SuggestionsPanel } = await import(
        "@/components/panels/SuggestionsPanel"
      );
      render(<SuggestionsPanel />);
      expect(
        screen.getByText(/No suggestions generated/i)
      ).toBeInTheDocument();
    });

    it("has Generate Suggestions button", async () => {
      const { SuggestionsPanel } = await import(
        "@/components/panels/SuggestionsPanel"
      );
      render(<SuggestionsPanel />);
      expect(
        screen.getByText("Generate")
      ).toBeInTheDocument();
    });
  });

  describe("FramesPanel", () => {
    it("renders empty state when no project loaded", async () => {
      const { FramesPanel } = await import(
        "@/components/panels/FramesPanel"
      );
      render(<FramesPanel />);
      expect(screen.getByText(/no labeled frames/i)).toBeInTheDocument();
    });
  });

  describe("ErrorBoundary", () => {
    it("renders children when no error", async () => {
      const { ErrorBoundary } = await import(
        "@/components/layout/ErrorBoundary"
      );
      render(
        <ErrorBoundary>
          <div>Child content</div>
        </ErrorBoundary>
      );

      expect(screen.getByText("Child content")).toBeInTheDocument();
    });

    it("catches errors and shows fallback UI", async () => {
      const { ErrorBoundary } = await import(
        "@/components/layout/ErrorBoundary"
      );

      // Component that throws on render
      function ThrowingComponent() {
        throw new Error("Test error");
      }

      // Suppress console.error for expected error
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      render(
        <ErrorBoundary>
          <ThrowingComponent />
        </ErrorBoundary>
      );

      expect(screen.getByText("Something went wrong")).toBeInTheDocument();
      expect(screen.getByText("Reload")).toBeInTheDocument();

      consoleSpy.mockRestore();
    });

    it("shows reload button in error state", async () => {
      const { ErrorBoundary } = await import(
        "@/components/layout/ErrorBoundary"
      );

      function ThrowingComponent() {
        throw new Error("Test error");
      }

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      render(
        <ErrorBoundary>
          <ThrowingComponent />
        </ErrorBoundary>
      );

      const reloadButton = screen.getByText("Reload");
      expect(reloadButton).toBeInTheDocument();
      expect(reloadButton.closest("button")).toBeTruthy();

      consoleSpy.mockRestore();
    });
  });
});
