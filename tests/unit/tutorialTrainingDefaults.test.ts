import { describe, it, expect } from "../bun-test";
import {
  tutorialTrainingUpdates,
  TUTORIAL_MAX_EPOCHS,
  TUTORIAL_RETRAIN_EPOCHS,
  TUTORIAL_ANCHOR_PART,
  type TutorialConfigView,
} from "@/lib/tutorial/trainingDefaults";

const NODES = ["head", "torso", "tailbase"];

function topDown(maxEpochs: number, anchorPart: string | null = null): TutorialConfigView[] {
  return [
    { slot: "centroid", maxEpochs, anchorPart: null },
    { slot: "centered_instance", maxEpochs, anchorPart },
  ];
}

describe("tutorialTrainingUpdates", () => {
  it("does nothing outside the training steps", () => {
    expect(tutorialTrainingUpdates("label-one-frame", "idle", NODES, topDown(200))).toEqual([]);
  });

  describe("run-training", () => {
    it("caps every config at 5 epochs and sets the centered-instance anchor to torso", () => {
      expect(tutorialTrainingUpdates("run-training", "idle", NODES, topDown(200))).toEqual([
        { slot: "centroid", updates: { maxEpochs: TUTORIAL_MAX_EPOCHS } },
        {
          slot: "centered_instance",
          updates: { maxEpochs: TUTORIAL_MAX_EPOCHS, anchorPart: TUTORIAL_ANCHOR_PART },
        },
      ]);
    });

    it("keeps an anchor the user picked", () => {
      const updates = tutorialTrainingUpdates("run-training", "idle", NODES, topDown(5, "head"));
      expect(updates).toEqual([]);
    });

    it("leaves the anchor on Auto when the skeleton has no torso node", () => {
      const updates = tutorialTrainingUpdates("run-training", "idle", ["a", "b"], topDown(5));
      expect(updates).toEqual([]);
    });

    it("doesn't touch the anchor while training is running", () => {
      const updates = tutorialTrainingUpdates("run-training", "running", NODES, topDown(5));
      expect(updates).toEqual([]);
    });
  });

  describe("retrain", () => {
    it("raises the leftover 5-epoch first pass to 50", () => {
      const updates = tutorialTrainingUpdates("retrain", "completed", NODES, topDown(5, "torso"));
      expect(updates).toEqual([
        { slot: "centroid", updates: { maxEpochs: TUTORIAL_RETRAIN_EPOCHS } },
        { slot: "centered_instance", updates: { maxEpochs: TUTORIAL_RETRAIN_EPOCHS } },
      ]);
    });

    it("keeps epochs the user typed", () => {
      const updates = tutorialTrainingUpdates("retrain", "completed", NODES, topDown(120, "torso"));
      expect(updates).toEqual([]);
    });

    it("re-sets torso if a reload left the anchor on Auto", () => {
      const updates = tutorialTrainingUpdates("retrain", "completed", NODES, topDown(50));
      expect(updates).toEqual([
        { slot: "centered_instance", updates: { anchorPart: TUTORIAL_ANCHOR_PART } },
      ]);
    });

    it("changes nothing while training is running", () => {
      expect(tutorialTrainingUpdates("retrain", "running", NODES, topDown(5))).toEqual([]);
    });
  });
});
