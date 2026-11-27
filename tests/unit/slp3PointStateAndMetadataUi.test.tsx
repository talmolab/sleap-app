/**
 * Component & UX tests for PR 4:
 * - Customizable shortcuts `KeyU` (unlabeled) & `Shift+KeyU` (absent)
 * - `<MetadataEditor />` (collapsed-when-empty, add/edit/delete string/num/bool,
 *   Python boolean caveat note, View-only read-only mode)
 * - `InstancesPanel` interactive 4-state node rows, state switching, "Place on
 *   canvas" targeting, instance & frame metadata editors, row metadata tag
 * - `BboxList` metadata badge & selected-box `<MetadataEditor />`
 * - `ContextMenu` 4-state node items
 * - `FramesPanel` automatic `Meta` column & metadata-only frames
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from "../bun-test";
import { render, screen, cleanup, fireEvent, act, waitFor } from "@testing-library/react";
import {
  Instance,
  LabeledFrame,
  Labels,
  Skeleton,
  UserBoundingBox,
  Video,
} from "@talmolab/sleap-io.js";
import { useAppStore } from "@/stores/appStore";
import { commandContext } from "@/commands/CommandContext";
import { DEFAULT_SHORTCUTS } from "@/lib/shortcuts";
import { SHORTCUT_CATEGORIES } from "@/lib/shortcutEditing";
import { getPointState } from "@/lib/pointState";
import { MetadataEditor } from "@/components/common/MetadataEditor";
import { ContextMenu } from "@/components/video/ContextMenu";

vi.mock("@/lib/platform", () => ({ isTauri: false, isMac: false, modKey: "Ctrl" }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

function setupStoreWithFourStates() {
  const skeleton = new Skeleton({
    nodes: ["nose", "left_ear", "right_ear", "tail_base"],
    name: "mouse",
  });
  const video = new Video({
    filename: "session.mp4",
    backendMetadata: { shape: [50, 480, 640, 3] },
    openBackend: false,
  });
  const inst = new Instance({
    skeleton,
    points: [
      { xy: [10, 20], visible: true, complete: true },
      { xy: [30, 40], visible: false, complete: true },
      { xy: [Number.NaN, Number.NaN], visible: false, complete: false },
      { xy: [Number.NaN, Number.NaN], visible: false, complete: false, labeled: false },
    ],
  });
  const box = new UserBoundingBox({
    x1: 5,
    y1: 5,
    x2: 50,
    y2: 50,
    category: "body",
    metadata: { quality: "ok" },
  });
  const lf = new LabeledFrame({ video, frameIdx: 0, instances: [inst] });
  lf.bboxes = [box];
  const labels = new Labels({ videos: [video], skeletons: [skeleton], labeledFrames: [lf] });

  useAppStore.setState(useAppStore.getInitialState());
  commandContext.reset();
  useAppStore.setState({
    labels,
    video,
    skeleton,
    frameIdx: 0,
    labeledFrame: lf,
    instance: inst,
  });
  return { labels, video, skeleton, lf, inst, box };
}

describe("4-state keyboard shortcuts registration", () => {
  it("registers KeyU and Shift+KeyU in Editing without colliding or altering V/Shift+V", () => {
    expect(DEFAULT_SHORTCUTS["toggle node visibility"]).toBe("KeyV");
    expect(DEFAULT_SHORTCUTS["show non-visible nodes"]).toBe("Shift+KeyV");
    expect(DEFAULT_SHORTCUTS["mark node unlabeled"]).toBe("KeyU");
    expect(DEFAULT_SHORTCUTS["mark node absent"]).toBe("Shift+KeyU");

    expect(SHORTCUT_CATEGORIES.Editing).toContain("mark node unlabeled");
    expect(SHORTCUT_CATEGORIES.Editing).toContain("mark node absent");

    expect(Object.values(DEFAULT_SHORTCUTS).filter((k) => k === "KeyU")).toHaveLength(1);
    expect(Object.values(DEFAULT_SHORTCUTS).filter((k) => k === "Shift+KeyU")).toHaveLength(1);
  });
});

describe("MetadataEditor component", () => {
  beforeEach(() => cleanup());

  it("starts collapsed when empty, expands on + Add, and supports string/number/boolean", () => {
    let latest: Record<string, string | number | boolean> = {};
    const onChange = (next: Record<string, string | number | boolean>) => {
      latest = next;
    };

    const { rerender } = render(
      <MetadataEditor label="Instance metadata" metadata={{}} onChange={onChange} testId="meta" />,
    );

    // Collapsed by default: no input rendered yet
    expect(screen.queryByPlaceholderText("key")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("+ Add"));

    // Add string field
    fireEvent.change(screen.getByLabelText("New instance metadata key"), {
      target: { value: "trial" },
    });
    fireEvent.change(screen.getByLabelText("New instance metadata value"), {
      target: { value: "T1" },
    });
    fireEvent.click(screen.getByLabelText("Add instance metadata field"));
    expect(latest).toEqual({ trial: "T1" });

    // Rerender with string value, then add number & boolean
    rerender(
      <MetadataEditor label="Instance metadata" metadata={latest} onChange={onChange} testId="meta" />,
    );
    fireEvent.change(screen.getByLabelText("New instance metadata key"), {
      target: { value: "age" },
    });
    fireEvent.change(screen.getByLabelText("New instance metadata type"), {
      target: { value: "number" },
    });
    fireEvent.change(screen.getByLabelText("New instance metadata value"), {
      target: { value: "42" },
    });
    fireEvent.click(screen.getByLabelText("Add instance metadata field"));
    expect(latest).toEqual({ trial: "T1", age: 42 });

    // Switch type to boolean -> helper note about Python 0/1 appears!
    rerender(
      <MetadataEditor label="Instance metadata" metadata={latest} onChange={onChange} testId="meta" />,
    );
    fireEvent.change(screen.getByLabelText("New instance metadata type"), {
      target: { value: "boolean" },
    });
    expect(screen.getByTestId("metadata-bool-note")).toHaveTextContent(/0.*1/);

    fireEvent.change(screen.getByLabelText("New instance metadata key"), {
      target: { value: "flagged" },
    });
    fireEvent.click(screen.getByLabelText("Add instance metadata field"));
    expect(latest).toEqual({ trial: "T1", age: 42, flagged: true });

    // Delete field
    rerender(
      <MetadataEditor label="Instance metadata" metadata={latest} onChange={onChange} testId="meta" />,
    );
    fireEvent.click(screen.getByLabelText("Remove metadata age"));
    expect(latest).toEqual({ trial: "T1", flagged: true });
  });

  it("hides editing controls when readOnly is true", () => {
    render(
      <MetadataEditor
        label="Frame metadata"
        metadata={{ source: "import" }}
        readOnly
        onChange={() => {}}
      />,
    );
    expect(screen.getByText("source")).toBeInTheDocument();
    expect(screen.getByText("import")).toBeInTheDocument();
    expect(screen.queryByLabelText("Remove metadata source")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("key")).not.toBeInTheDocument();
  });
});

describe("InstancesPanel interactive 4-state nodes & metadata", () => {
  beforeEach(() => {
    cleanup();
    useAppStore.setState(useAppStore.getInitialState());
    commandContext.reset();
  });

  it("renders all 4 states, switches node states via popover, and launches Place on canvas", async () => {
    const { inst } = setupStoreWithFourStates();
    const { InstancesPanel } = await import("@/components/panels/InstancesPanel");
    render(<InstancesPanel />);

    expect(screen.getByLabelText("State for nose: visible")).toHaveTextContent("10.0, 20.0");
    expect(screen.getByLabelText("State for left_ear: occluded")).toHaveTextContent("occluded");
    expect(screen.getByLabelText("State for right_ear: absent")).toHaveTextContent("absent");
    expect(screen.getByLabelText("State for tail_base: unlabeled")).toHaveTextContent("unlabeled");

    // Click nose -> Mark Unlabeled
    fireEvent.click(screen.getByLabelText("State for nose: visible"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Unlabeled" }));
    });
    expect(getPointState(inst.points[0])).toBe("unlabeled");
    await waitFor(() =>
      expect(screen.getByLabelText("State for nose: unlabeled")).toHaveTextContent("unlabeled"),
    );

    // Click tail_base -> Place on canvas targets nodeIdx=3 directly
    fireEvent.click(screen.getByLabelText("State for tail_base: unlabeled"));
    fireEvent.click(screen.getByRole("button", { name: "Place on canvas" }));
    expect(useAppStore.getState().labelingMode).toBe("place");
    expect(useAppStore.getState().placementNodeIdx).toBe(3);
  });

  it("edits instance and frame metadata through MetadataEditor", async () => {
    const { inst, lf } = setupStoreWithFourStates();
    const { InstancesPanel } = await import("@/components/panels/InstancesPanel");
    render(<InstancesPanel />);

    // Add instance metadata
    const instMeta = screen.getByTestId("instance-metadata");
    fireEvent.click(instMeta.querySelector("button:last-child")!);
    fireEvent.change(screen.getByLabelText("New instance metadata key"), {
      target: { value: "note" },
    });
    fireEvent.change(screen.getByLabelText("New instance metadata value"), {
      target: { value: "grooming" },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Add instance metadata field"));
    });
    expect(inst.metadata).toEqual({ note: "grooming" });

    // Add frame metadata
    const frameMeta = screen.getByTestId("frame-metadata");
    fireEvent.click(frameMeta.querySelector("button:last-child")!);
    fireEvent.change(screen.getByLabelText("New frame metadata key"), {
      target: { value: "block" },
    });
    fireEvent.change(screen.getByLabelText("New frame metadata type"), {
      target: { value: "number" },
    });
    fireEvent.change(screen.getByLabelText("New frame metadata value"), {
      target: { value: "3" },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Add frame metadata field"));
    });
    expect(lf.metadata).toEqual({ block: 3 });
  });
});

describe("BboxList metadata badge & selected-box editor", () => {
  beforeEach(() => {
    cleanup();
    useAppStore.setState(useAppStore.getInitialState());
    commandContext.reset();
  });

  it("shows metadata indicator on box row and edits selected box metadata", async () => {
    const { lf, box } = setupStoreWithFourStates();
    useAppStore.setState({ selectedBboxIdx: 0 });
    const { BboxList } = await import("@/components/panels/BboxList");
    render(<BboxList labeledFrame={lf} />);

    expect(screen.getByLabelText("Box 1 has metadata")).toBeInTheDocument();
    expect(screen.getByTestId("bbox-metadata")).toBeInTheDocument();
    expect(screen.getByText("quality")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("New box 1 metadata key"), {
      target: { value: "crowd" },
    });
    fireEvent.change(screen.getByLabelText("New box 1 metadata type"), {
      target: { value: "boolean" },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Add box 1 metadata field"));
    });
    expect(box.metadata).toEqual({ quality: "ok", crowd: true });
  });
});

describe("ContextMenu 4-state node actions", () => {
  beforeEach(() => {
    cleanup();
    useAppStore.setState(useAppStore.getInitialState());
    commandContext.reset();
  });

  it("marks hovered user node Unlabeled or Absent from context menu", async () => {
    const { inst } = setupStoreWithFourStates();
    const onClose = vi.fn();
    render(
      <ContextMenu
        x={10}
        y={10}
        sceneLocation={[10, 20]}
        instanceIdx={0}
        nodeIdx={0}
        onClose={onClose}
      />,
    );

    expect(screen.getByText("Mark Node Non-Visible")).toBeInTheDocument();
    expect(screen.getByText("Mark Node Absent")).toBeInTheDocument();
    expect(screen.getByText("Mark Node Unlabeled")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByText("Mark Node Unlabeled"));
    });
    expect(getPointState(inst.points[0])).toBe("unlabeled");
    expect(onClose).toHaveBeenCalled();
  });
});

describe("FramesPanel Meta column", () => {
  beforeEach(() => {
    cleanup();
    useAppStore.setState(useAppStore.getInitialState());
    commandContext.reset();
  });

  it("auto-shows Meta column when a frame carries metadata, including metadata-only frames", async () => {
    const { labels, video } = setupStoreWithFourStates();
    const metaOnly = new LabeledFrame({ video, frameIdx: 9 });
    metaOnly.metadata = { condition: "drug", rep: 2 };
    labels.append(metaOnly);

    const { FramesPanel } = await import("@/components/panels/FramesPanel");
    render(<FramesPanel />);

    await waitFor(() => expect(screen.getByText("Meta")).toBeInTheDocument());
    // Frame 9 (metadata-only, 0 instances) appears in the table with count 2
    expect(screen.getByText("9")).toBeInTheDocument();
    expect(screen.getByTitle("condition=drug, rep=2")).toBeInTheDocument();
  });
});

describe("VideoPlayer U / Shift+U in placement mode", () => {
  beforeEach(() => {
    cleanup();
    useAppStore.setState(useAppStore.getInitialState());
    commandContext.reset();
  });

  it("marks active placement node Unlabeled (U) / Absent (Shift+U) and advances forward", async () => {
    const { inst } = setupStoreWithFourStates();
    // Start in placement mode explicitly targeting node 2 (right_ear, absent)
    // followed by node 3 (tail_base, unlabeled).
    useAppStore.setState({
      labelingMode: "place",
      placementNodeIdx: 2,
    });
    const { VideoPlayer } = await import("@/components/video/VideoPlayer");
    render(<VideoPlayer />);

    // Explicit target 2 is preserved by the placement effect
    expect(useAppStore.getState().placementNodeIdx).toBe(2);

    // Press plain U -> marks node 2 Unlabeled and advances forward to node 3
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "u", code: "KeyU", bubbles: true }),
      );
    });
    expect(getPointState(inst.points[2])).toBe("unlabeled");
    expect(useAppStore.getState().placementNodeIdx).toBe(3);
    expect(useAppStore.getState().labelingMode).toBe("place");

    // Press Shift+U -> marks node 3 Absent and exits placement mode (no more nodes forward)
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "U",
          code: "KeyU",
          shiftKey: true,
          bubbles: true,
        }),
      );
    });
    expect(getPointState(inst.points[3])).toBe("absent");
    expect(useAppStore.getState().labelingMode).toBe("select");
    expect(useAppStore.getState().placementNodeIdx).toBeNull();
  });
});
