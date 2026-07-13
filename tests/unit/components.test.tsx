/**
 * Basic component rendering tests.
 */

import { describe, it, expect, beforeEach, vi } from "../bun-test";
import { render, screen, fireEvent } from "@testing-library/react";
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
      // StatusBar shows a 0-based frame counter: frameIdx 42 of 100 -> "Frame 42 / 99".
      expect(screen.getByText(/Frame 42 \/ 99/)).toBeInTheDocument();
    });

    it("shows user-labeled frame count", async () => {
      // Single video: "Labeled: {userInVideo}" with no in-video/in-project split.
      // The video object is shared between labels.videos[0], store.video, and
      // each frame's .video so reference-identity matching counts them.
      const vid = { filename: "test.mp4", shape: [100, 480, 640, 3] };
      const userFrame = {
        video: vid,
        userInstances: [{}],
        unusedPredictions: [],
        hasUserInstances: true,
        hasPredictedInstances: false,
        isNegative: false,
        instances: [{}],
      };
      useAppStore.setState({
        filename: "test.slp",
        labels: {
          videos: [vid],
          skeletons: [],
          labeledFrames: [userFrame, userFrame],
          tracks: [],
          suggestions: [],
          provenance: {},
          find: () => [],
          append: () => {},
        } as unknown as import("@/types").Labels,
        projectLoaded: true,
        video: vid as unknown as import("@/types").Video,
      });

      const { StatusBar } = await import(
        "@/components/layout/StatusBar"
      );
      render(<StatusBar />);
      expect(screen.getByText(/Labeled: 2/)).toBeInTheDocument();
    });

    it("shows Video index out of total", async () => {
      const vidA = { filename: "a.mp4", shape: [100, 1, 1, 1] };
      const vidB = { filename: "b.mp4", shape: [50, 1, 1, 1] };
      useAppStore.setState({
        filename: "test.slp",
        labels: {
          videos: [vidA, vidB],
          skeletons: [],
          labeledFrames: [],
          tracks: [],
          suggestions: [],
          provenance: {},
          find: () => [],
          append: () => {},
        } as unknown as import("@/types").Labels,
        projectLoaded: true,
        video: vidB as unknown as import("@/types").Video,
      });
      const { StatusBar } = await import("@/components/layout/StatusBar");
      render(<StatusBar />);
      expect(screen.getByText(/Video 2\s*\/\s*2/)).toBeInTheDocument();
    });

    it("shows in-video / in-project labeled split with >1 video", async () => {
      const vidA = { filename: "a.mp4", shape: [100, 1, 1, 1] };
      const vidB = { filename: "b.mp4", shape: [50, 1, 1, 1] };
      const userA = {
        video: vidA,
        userInstances: [{}],
        unusedPredictions: [],
        hasUserInstances: true,
        hasPredictedInstances: false,
        isNegative: false,
        instances: [{}],
      };
      const userB = { ...userA, video: vidB };
      useAppStore.setState({
        filename: "test.slp",
        labels: {
          videos: [vidA, vidB],
          skeletons: [],
          labeledFrames: [userA, userA, userB],
          tracks: [],
          suggestions: [],
          provenance: {},
          find: () => [],
          append: () => {},
        } as unknown as import("@/types").Labels,
        projectLoaded: true,
        video: vidA as unknown as import("@/types").Video,
      });
      const { StatusBar } = await import("@/components/layout/StatusBar");
      render(<StatusBar />);
      expect(screen.getByText(/2 in video/)).toBeInTheDocument();
      expect(screen.getByText(/3 in project/)).toBeInTheDocument();
    });

    it("shows predicted frames count and percentage when > 0", async () => {
      const vid = { filename: "a.mp4", shape: [100, 1, 1, 1] };
      const pred = {
        video: vid,
        userInstances: [],
        unusedPredictions: [{}],
        hasUserInstances: false,
        hasPredictedInstances: true,
        isNegative: false,
        instances: [{}],
      };
      useAppStore.setState({
        filename: "test.slp",
        labels: {
          videos: [vid],
          skeletons: [],
          labeledFrames: [pred, pred],
          tracks: [],
          suggestions: [],
          provenance: {},
          find: () => [],
          append: () => {},
        } as unknown as import("@/types").Labels,
        projectLoaded: true,
        video: vid as unknown as import("@/types").Video,
      });
      const { StatusBar } = await import("@/components/layout/StatusBar");
      render(<StatusBar />);
      expect(screen.getByText(/Predicted/)).toBeInTheDocument();
      expect(screen.getByText(/2\.00%/)).toBeInTheDocument();
    });

    it("shows [Hidden] warning when instances present but hidden", async () => {
      const vid = { filename: "a.mp4", shape: [100, 1, 1, 1] };
      const lf = {
        video: vid,
        userInstances: [{}],
        unusedPredictions: [],
        hasUserInstances: true,
        hasPredictedInstances: false,
        isNegative: false,
        instances: [{}],
      };
      useAppStore.setState({
        filename: "test.slp",
        showInstances: false,
        labels: {
          videos: [vid],
          skeletons: [],
          labeledFrames: [lf],
          tracks: [],
          suggestions: [],
          provenance: {},
          find: () => [],
          append: () => {},
        } as unknown as import("@/types").Labels,
        projectLoaded: true,
        video: vid as unknown as import("@/types").Video,
        labeledFrame: lf as unknown as import("@/types").LabeledFrame,
      });
      const { StatusBar } = await import("@/components/layout/StatusBar");
      render(<StatusBar />);
      expect(screen.getByText(/\[Hidden\]/)).toBeInTheDocument();
    });

    it("shows [NEGATIVE FRAME] when frame is negative", async () => {
      const vid = { filename: "a.mp4", shape: [100, 1, 1, 1] };
      const lf = {
        video: vid,
        userInstances: [],
        unusedPredictions: [],
        hasUserInstances: false,
        hasPredictedInstances: false,
        isNegative: true,
        instances: [],
      };
      useAppStore.setState({
        filename: "test.slp",
        labels: {
          videos: [vid],
          skeletons: [],
          labeledFrames: [lf],
          tracks: [],
          suggestions: [],
          provenance: {},
          find: () => [],
          append: () => {},
        } as unknown as import("@/types").Labels,
        projectLoaded: true,
        video: vid as unknown as import("@/types").Video,
        labeledFrame: lf as unknown as import("@/types").LabeledFrame,
      });
      const { StatusBar } = await import("@/components/layout/StatusBar");
      render(<StatusBar />);
      expect(screen.getByText(/\[NEGATIVE FRAME\]/)).toBeInTheDocument();
    });

    it("shows the selection range 0-based (consistent with Frame counter)", async () => {
      const vid = { filename: "a.mp4", shape: [100, 1, 1, 1] };
      useAppStore.setState({
        filename: "test.slp",
        labels: {
          videos: [vid],
          skeletons: [],
          labeledFrames: [],
          tracks: [],
          suggestions: [],
          provenance: {},
          find: () => [],
          append: () => {},
        } as unknown as import("@/types").Labels,
        projectLoaded: true,
        video: vid as unknown as import("@/types").Video,
        // 0-based inclusive [4, 9] -> displayed 0-based as "Frames 4-9 selected".
        frameRange: [4, 9],
      });
      const { StatusBar } = await import("@/components/layout/StatusBar");
      render(<StatusBar />);
      expect(screen.getByText(/Frames 4-9 selected/)).toBeInTheDocument();
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

    it("has New and Open Project buttons (#132)", async () => {
      const { WelcomeScreen } = await import(
        "@/components/layout/WelcomeScreen"
      );
      render(<WelcomeScreen />);
      expect(
        screen.getByRole("button", { name: /New Project/i })
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /Open Project/i })
      ).toBeInTheDocument();
    });

    it("New Project opens the guided new-project dialog (#132/#138)", async () => {
      const { WelcomeScreen } = await import(
        "@/components/layout/WelcomeScreen"
      );
      render(<WelcomeScreen />);
      expect(useAppStore.getState().newProjectDialogOpen).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: /New Project/i }));
      expect(useAppStore.getState().newProjectDialogOpen).toBe(true);
    });

    it("shows a drag-and-drop hint", async () => {
      const { WelcomeScreen } = await import(
        "@/components/layout/WelcomeScreen"
      );
      render(<WelcomeScreen />);
      expect(
        screen.getByText(/drag .* drop a .slp file/i)
      ).toBeInTheDocument();
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

    it("renders the SLEAP icon + wordmark in web mode (#133)", async () => {
      // The top-level platform mock reports isTauri: false (web deployment),
      // where there is no OS title bar — so the brand block should render.
      const { MenuBar } = await import(
        "@/components/layout/MenuBar"
      );
      const { container } = render(<MenuBar />);
      expect(screen.getByText("SLEAP")).toBeInTheDocument();
      // Icon uses alt="" (decorative; the wordmark carries the text), so query
      // the element directly rather than by accessible role/name.
      const icon = container.querySelector("img");
      expect(icon).toBeInTheDocument();
      expect(icon?.getAttribute("src")).toContain("icon.png");
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
      expect(screen.getByText("Panels")).toBeInTheDocument();
      expect(screen.getByText("Labels")).toBeInTheDocument();
      expect(screen.getByText("Predict")).toBeInTheDocument();
      expect(screen.getByText("Tracks")).toBeInTheDocument();
      // Help menu should exist
      expect(screen.getByText("Help")).toBeInTheDocument();
    });
  });

  describe("panelRegistry (#135)", () => {
    it("PANELS ids match DEFAULT_PANEL_ORDER (no drift)", async () => {
      // Guards against adding a panel to the registry without adding it to the
      // default order, which would let reconcile/reset silently drop it.
      const { PANELS } = await import("@/components/layout/panelRegistry");
      const { DEFAULT_PANEL_ORDER } = await import("@/lib/panelLayout");
      expect(PANELS.map((p) => p.id).sort()).toEqual(
        [...DEFAULT_PANEL_ORDER].sort()
      );
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
      function ThrowingComponent(): never {
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

      function ThrowingComponent(): never {
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
