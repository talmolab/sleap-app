// Why: the bar owns the mode's keys while it's on and is the only place to switch node or stop; both must work from the real component.
import { describe, it, expect, beforeEach, afterEach, vi } from "../bun-test";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}));

const { loadFixtureWithOneInstance } = await import("./helpers/automationFixture");
const { useAppStore } = await import("@/stores/appStore");
const { useKeypointReviewStore, openKeypointReview, closeKeypointReview } = await import("@/stores/keypointReviewStore");
const { KeypointReviewBar } = await import("@/components/video/KeypointReviewBar");

beforeEach(() => {
  loadFixtureWithOneInstance();
  closeKeypointReview();
});
afterEach(cleanup);

describe("KeypointReviewBar", () => {
  it("shows nothing outside the mode", () => {
    render(<KeypointReviewBar />);
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("shows the node, position and frame, and takes Enter / Esc from the window", () => {
    openKeypointReview({ node: 1 });
    render(<KeypointReviewBar />);
    expect((screen.getByLabelText("Node to review") as HTMLSelectElement).value).toBe("1");
    expect(screen.getByLabelText("Position").textContent).toBe("1 / 3");
    // fireEvent returns false when the event was preventDefault-ed (taken by the bar).
    expect(fireEvent.keyDown(window, { key: "Enter" })).toBe(false);
    expect(useAppStore.getState().frameIdx).toBe(20);
    expect(screen.getByLabelText("Position").textContent).toBe("2 / 3");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useKeypointReviewStore.getState().active).toBe(false);
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("switching the node in the bar restarts the list on that node", () => {
    openKeypointReview({ node: 0 });
    render(<KeypointReviewBar />);
    fireEvent.click(screen.getByRole("button", { name: "Next instance" }));
    fireEvent.change(screen.getByLabelText("Node to review"), { target: { value: "2" } });
    expect(useKeypointReviewStore.getState().node).toBe(2);
    expect(screen.getByLabelText("Position").textContent).toBe("1 / 3");
  });
});
