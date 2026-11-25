/**
 * The Masks list in the Instances panel (#155): one row per mask on the frame,
 * like the vibes apps' mask / ROI lists — canvas-colored swatch, editable name,
 * hover highlights, click selects (again deselects), delete; each polygon its
 * own mask (Shift adds to / Alt cuts from the selected one) — plus category,
 * track (incl. starting a new one), linked instance and accept / reject.
 */
import { describe, it, expect, afterEach, vi } from "../bun-test";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import {
  Labels,
  LabeledFrame,
  Instance,
  Skeleton,
  Track,
  Video,
  UserSegmentationMask,
  PredictedSegmentationMask,
  encodeRle,
} from "@talmolab/sleap-io.js";
import { MaskList, maskImageArea, polygonHint } from "@/components/panels/MaskList";
import { useAppStore } from "@/stores/appStore";
import { polygonRaster, type Pt } from "@/lib/maskPolygon";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

afterEach(() => {
  cleanup();
  useAppStore.setState(useAppStore.getInitialState());
});

const square = (x0: number, y0: number, x1: number, y1: number): Pt[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];
const GRID = { height: 40, width: 50, scale: [1, 1] as [number, number], offset: [0, 0] as [number, number] };

function setup() {
  const sk = new Skeleton({ nodes: ["a", "b"], name: "s" });
  const video = new Video({
    filename: "/v/main.mp4",
    backendMetadata: { shape: [10, 40, 50, 3] },
    openBackend: false,
  });
  const track = new Track("A");
  const inst = Instance.fromArray([[10, 10], [20, 20]], sk);
  inst.track = track;
  const user = UserSegmentationMask.fromArray(polygonRaster(square(0, 0, 10, 10), GRID), 40, 50, {
    name: "left",
  });
  const pred = new PredictedSegmentationMask({
    rleCounts: encodeRle(polygonRaster(square(20, 20, 30, 30), GRID), 40, 50),
    height: 40,
    width: 50,
    score: 0.6,
  });
  const lf = new LabeledFrame({ video, frameIdx: 0, instances: [inst], masks: [user, pred] });
  const labels = new Labels({ labeledFrames: [lf], skeletons: [sk], videos: [video], tracks: [track] });
  const store = useAppStore.getState();
  store.setLabels(labels, "t.slp");
  store.setVideo(video);
  store.setFrameIdx(0);
  store.setLabeledFrame(lf);
  return { labels, lf, inst, track };
}

describe("MaskList", () => {
  it("is hidden with no masks unless the polygon tool is on", () => {
    const { container } = render(<MaskList labeledFrame={null} />);
    expect(container.textContent).toBe("");
    cleanup();
    useAppStore.getState().set("maskPolygonMode", true);
    render(<MaskList labeledFrame={null} />);
    expect(screen.getByText("Masks (0)")).toBeTruthy();
    expect(screen.getByText(polygonHint(null))).toBeTruthy();
  });

  it("lists each mask with its swatch, name, type, score and area", () => {
    const { lf } = setup();
    useAppStore.getState().set("maskSwatches", [[255, 0, 0], null]);
    render(<MaskList labeledFrame={lf} />);
    expect(screen.getByText("Masks (2)")).toBeTruthy();
    for (const h of ["Name", "Type", "Category", "Track", "Linked instance", "Area"]) {
      expect(screen.getByRole("columnheader", { name: h })).toBeTruthy();
    }
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect((screen.getByLabelText("Mask 1 name") as HTMLInputElement).value).toBe("left");
    expect(screen.getByText("0.60")).toBeTruthy();
    expect(screen.getAllByText("100")).toHaveLength(2);
    expect((screen.getByTestId("mask-swatch-0") as HTMLElement).style.background).toContain("255, 0, 0");
  });

  it("click selects (and deselects); hover highlights", () => {
    const { lf } = setup();
    render(<MaskList labeledFrame={lf} />);
    const row = screen.getAllByRole("row")[2];
    fireEvent.click(row);
    expect(useAppStore.getState().selectedMaskIdx).toBe(1);
    fireEvent.mouseEnter(row);
    expect(useAppStore.getState().hoveredMaskIdx).toBe(1);
    fireEvent.click(row);
    expect(useAppStore.getState().selectedMaskIdx).toBeNull();
  });

  it("renames in place on Enter", () => {
    const { lf } = setup();
    render(<MaskList labeledFrame={lf} />);
    const input = screen.getByLabelText("Mask 2 name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "right" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    expect(lf.masks[1].name).toBe("right");
  });

  it("accepts a predicted mask, links an instance, starts a new track, deletes", () => {
    const { lf, labels, inst, track } = setup();
    render(<MaskList labeledFrame={lf} />);
    fireEvent.click(screen.getByLabelText("Accept mask 2"));
    expect(lf.masks[1]).toBeInstanceOf(UserSegmentationMask);
    fireEvent.change(screen.getByLabelText("Mask 1 linked instance"), { target: { value: "0" } });
    expect(lf.masks[0].instance).toBe(inst);
    expect(lf.masks[0].track).toBe(track);
    fireEvent.change(screen.getByLabelText("Mask 2 track"), { target: { value: "-2" } });
    expect(labels.tracks).toHaveLength(2);
    expect(lf.masks[1].track).toBe(labels.tracks[1]);
    fireEvent.click(screen.getByLabelText("Delete mask 1"));
    expect(lf.masks).toHaveLength(1);
  });

  it("area is in image pixels for a scaled mask", () => {
    const half = UserSegmentationMask.fromArray(Uint8Array.from([1, 1, 0, 0]), 2, 2, { scale: [0.5, 0.5] });
    expect(maskImageArea(half)).toBe(8);
  });

  it("the hint says where the next polygon goes", () => {
    expect(polygonHint(null)).toContain("new mask");
    expect(polygonHint(2)).toContain("Shift adds to mask 3");
  });
});
