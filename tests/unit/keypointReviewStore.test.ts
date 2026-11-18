// Why: keypoint review is click-and-advance; each click, key and step must edit the right node of the right instance, one undo step each.
import { describe, it, expect, beforeEach, vi } from "../bun-test";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}));

const { loadFixtureWithOneInstance, makeAutomationProject } = await import("./helpers/automationFixture");
const { useAppStore } = await import("@/stores/appStore");
const { useQcStore } = await import("@/stores/qcStore");
const { commandContext } = await import("@/commands");
const {
  useKeypointReviewStore,
  openKeypointReview,
  closeKeypointReview,
  placeKeypointReviewNode,
  hideKeypointReviewNode,
  handleKeypointReviewKey,
  setKeypointReview,
  qcBlamedKeys,
} = await import("@/stores/keypointReviewStore");

const key = (k: string, code = "") => ({ key: k, code, metaKey: false, ctrlKey: false, altKey: false });
const where = () => {
  const s = useAppStore.getState();
  const lf = s.labeledFrame;
  return `${s.frameIdx}/${s.instance && lf ? lf.userInstances.indexOf(s.instance) : -1}`;
};

beforeEach(() => {
  loadFixtureWithOneInstance();
  useAppStore.getState().setFrameIdx(0);
  useAppStore.getState().setInstance(null);
  closeKeypointReview();
});

describe("keypoint review", () => {
  it("opens on the first instance with its node, selected and zoomed", () => {
    openKeypointReview({ node: 1 });
    const s = useKeypointReviewStore.getState();
    expect(s.active).toBe(true);
    expect(s.node).toBe(1);
    expect(s.queue.length).toBe(3);
    expect(where()).toBe("10/0");
    expect(s.fitNonce).toBeGreaterThan(0);
  });

  it("starts on the selected instance when it's in the list", () => {
    const lf = useAppStore.getState().labels!.find({ video: useAppStore.getState().video!, frameIdx: 20 })[0];
    useAppStore.getState().setFrameIdx(20);
    useAppStore.getState().setInstance(lf.userInstances[1]);
    openKeypointReview({ node: 0 });
    expect(useKeypointReviewStore.getState().pos).toBe(2);
    expect(where()).toBe("20/1");
  });

  // Why: the click is the whole interaction; it must move exactly this node and move on.
  it("a click moves the node there and goes to the next instance; one ⌘Z undoes it", async () => {
    openKeypointReview({ node: 0 });
    const inst = useAppStore.getState().instance!;
    placeKeypointReviewNode(55, 66);
    expect(inst.points[0].xy).toEqual([55, 66]);
    expect(inst.points[1].xy).toEqual([110, 110]);
    expect(where()).toBe("20/0");
    expect(useKeypointReviewStore.getState().changed).toBe(1);
    await Promise.resolve();
    expect(commandContext.undo()).toBe(true);
    const restored = useAppStore.getState().labels!.find({ video: useAppStore.getState().video!, frameIdx: 10 })[0];
    expect(restored.userInstances[0].points[0].xy).toEqual([100, 100]);
  });

  it("V marks the node not visible and moves on", () => {
    openKeypointReview({ node: 2 });
    const inst = useAppStore.getState().instance!;
    expect(handleKeypointReviewKey(key("v", "KeyV"))).toBe(true);
    expect(inst.points[2].visible).toBe(false);
    expect(where()).toBe("20/0");
  });

  it("hiding a node that's already hidden changes nothing but still moves on", () => {
    openKeypointReview({ node: 2 });
    useAppStore.getState().instance!.points[2].visible = false;
    hideKeypointReviewNode();
    expect(useKeypointReviewStore.getState().changed).toBe(0);
    expect(where()).toBe("20/0");
  });

  it("Enter / → keep and go on, ← / Backspace go back, Esc stops", () => {
    openKeypointReview({ node: 0 });
    handleKeypointReviewKey(key("Enter"));
    expect(where()).toBe("20/0");
    handleKeypointReviewKey(key("ArrowRight"));
    expect(where()).toBe("20/1");
    handleKeypointReviewKey(key("ArrowRight")); // the end: stays
    expect(where()).toBe("20/1");
    handleKeypointReviewKey(key("Backspace"));
    expect(where()).toBe("20/0");
    handleKeypointReviewKey(key("ArrowLeft"));
    expect(where()).toBe("10/0");
    expect(handleKeypointReviewKey(key("Escape"))).toBe(true);
    expect(useKeypointReviewStore.getState().active).toBe(false);
    // Off: the keys go back to the app.
    expect(handleKeypointReviewKey(key("Enter"))).toBe(false);
  });

  // Why: ⌘Z, ⌘V and friends must keep working during the review.
  it("leaves modifier shortcuts alone", () => {
    openKeypointReview({ node: 0 });
    expect(handleKeypointReviewKey({ ...key("z", "KeyZ"), metaKey: true })).toBe(false);
    expect(handleKeypointReviewKey({ ...key("v", "KeyV"), ctrlKey: true })).toBe(false);
  });

  it("switching the node starts the list again", () => {
    openKeypointReview({ node: 0 });
    handleKeypointReviewKey(key("Enter"));
    setKeypointReview({ node: 2 });
    const s = useKeypointReviewStore.getState();
    expect(s.node).toBe(2);
    expect(s.pos).toBe(0);
    expect(where()).toBe("10/0");
  });

  it("stops when another project loads", () => {
    openKeypointReview({ node: 0 });
    useAppStore.getState().setLabels(makeAutomationProject().labels, "other.slp");
    expect(useKeypointReviewStore.getState().active).toBe(false);
  });

  it("closes the Label QC Review window when it starts", () => {
    useQcStore.setState({ reviewOpen: true });
    openKeypointReview({ node: 0 });
    expect(useQcStore.getState().reviewOpen).toBe(false);
  });
});

describe("qcBlamedKeys", () => {
  it("lists flagged instances whose flag is about this node (issue nodes or the GMM's node)", async () => {
    const { anomalyAt } = await import("./helpers/automationFixture");
    const labels = useAppStore.getState().labels!;
    useQcStore.setState({
      labels,
      state: "done",
      findings: [],
      threshold: 0.7,
      anomaly: {
        instances: [
          anomalyAt(10, 0, 0.9, [0, 1]), // flagged, about nose + head
          anomalyAt(20, 0, 0.9, [2]), // flagged, about tail
          anomalyAt(20, 1, 0.3, [0]), // not flagged
          { ...anomalyAt(20, 1, 0.3, []), gmmScore: 0.99, gmmNode: 0 }, // GMM blames nose
        ],
        featureNames: [],
        gmmThreshold: 0.95,
      },
    });
    expect([...qcBlamedKeys(labels, 0)].sort()).toEqual(["0:10:0", "0:20:1"]);
    expect([...qcBlamedKeys(labels, 2)]).toEqual(["0:20:0"]);
  });
});
