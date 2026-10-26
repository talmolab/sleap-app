/**
 * The "Train a model" card's live checklist: one row per setting the first
 * training run needs, a value shown for anything set differently, and a
 * "What do these mean?" toggle.
 *
 * The Training panel isn't mounted here, so the Post-Training Inference
 * Target select is a stand-in carrying its `data-tutorial` hook and the text
 * the real one shows.
 */

import { describe, it, expect, beforeEach, afterEach } from "../bun-test";
import { render, waitFor, act, cleanup, fireEvent, screen } from "@testing-library/react";
import { RETRAIN_STEP, RUN_TRAINING_STEP } from "@/lib/tutorial/steps";
import { TutorialOverlay } from "@/components/tutorial/TutorialOverlay";
import { useAppStore } from "@/stores/appStore";
import { useTrainingStore, type ConfigFile } from "@/stores/trainingStore";

function config(slot: string, maxEpochs: number, anchorPart: string | null): ConfigFile {
  return {
    filename: `${slot}.yaml`,
    content: "",
    modelType: slot,
    slot,
    hyperparams: { maxEpochs, anchorPart },
  } as unknown as ConfigFile;
}

function placeTargetSelect(text: string): HTMLElement {
  const el = document.createElement("button");
  el.setAttribute("data-tutorial", "post-training-inference-target-select");
  el.textContent = text;
  document.body.appendChild(el);
  return el;
}

const rowText = () =>
  Array.from(document.querySelectorAll("[data-tutorial-checklist] li")).map(
    (li) => li.textContent ?? "",
  );

describe("training step checklist", () => {
  beforeEach(() => {
    act(() => {
      useTrainingStore.setState((s) => ({
        config: {
          ...s.config,
          configs: [config("centroid", 5, null), config("centered_instance", 5, "torso")],
        },
      }));
      useAppStore.setState((s) => {
        s.tutorialActive = true;
        s.tutorialSteps = [RUN_TRAINING_STEP];
        s.tutorialStepIndex = 0;
        s.tutorialHighestStepIndex = 0;
      });
    });
  });

  afterEach(() => {
    cleanup();
    document.querySelectorAll("[data-tutorial]").forEach((el) => el.remove());
    act(() => {
      useAppStore.setState((s) => {
        s.tutorialActive = false;
        s.tutorialSteps = [];
      });
      useTrainingStore.setState((s) => ({ config: { ...s.config, configs: [] } }));
    });
  });

  it("lists the four settings, flagging one that is set differently with its value", async () => {
    placeTargetSelect("Entire current video");
    render(<TutorialOverlay />);
    await waitFor(() => expect(rowText().length).toBe(4));

    const rows = rowText();
    expect(rows[0]).toContain("Post-training inference target: Suggested frames");
    expect(rows[0]).toContain("(now Entire current video)");
    for (const row of rows.slice(1)) expect(row).not.toContain("(now");
    expect(screen.getAllByLabelText("Set").length).toBe(3);
    expect(screen.getAllByLabelText("Not set").length).toBe(1);
  });

  it("ticks a setting as soon as the user fixes it", async () => {
    const select = placeTargetSelect("Entire current video");
    render(<TutorialOverlay />);
    await waitFor(() => expect(screen.getAllByLabelText("Not set").length).toBe(1));

    act(() => {
      select.textContent = "Suggested frames";
    });
    await waitFor(() => expect(screen.queryAllByLabelText("Not set").length).toBe(0));
  });

  it("explains each setting behind the toggle", async () => {
    placeTargetSelect("Suggested frames");
    render(<TutorialOverlay />);
    const toggle = await waitFor(() => screen.getByRole("button", { name: /what do these mean/i }));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("[data-tutorial-checklist] dl")).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const meanings = document.querySelector("[data-tutorial-checklist] dl")?.textContent ?? "";
    expect(meanings).toContain("Max Epochs");
    expect(meanings).toContain("Anchor Part");
    expect(meanings).toContain("Post-Training Inference Target");
  });

  it("keeps showing live values on a revisit, when the defaults aren't re-applied", async () => {
    placeTargetSelect("Suggested frames");
    act(() => {
      useTrainingStore.setState((s) => ({
        config: {
          ...s.config,
          configs: [config("centroid", 50, null), config("centered_instance", 50, "torso")],
        },
      }));
      // A later step was reached, then the user went back to this one.
      useAppStore.setState((s) => {
        s.tutorialSteps = [RUN_TRAINING_STEP, RUN_TRAINING_STEP];
        s.tutorialStepIndex = 0;
        s.tutorialHighestStepIndex = 1;
      });
    });
    render(<TutorialOverlay />);
    await waitFor(() => expect(rowText().length).toBe(4));

    const epochRows = rowText().filter((r) => r.includes("epochs"));
    expect(epochRows).toHaveLength(2);
    for (const row of epochRows) expect(row).toContain("(now 50)");
  });

  it("asks for 50 epochs on the retrain step, and ticks once Train Again's 5 are raised", async () => {
    placeTargetSelect("Suggested frames");
    act(() => {
      // "Train Again" reloads the first run's config: 5 epochs.
      useAppStore.setState((s) => {
        s.tutorialSteps = [RETRAIN_STEP];
        s.tutorialStepIndex = 0;
        s.tutorialHighestStepIndex = 0;
      });
    });
    render(<TutorialOverlay />);
    await waitFor(() => expect(rowText().length).toBe(4));

    // The overlay raises 5 to 50 (trainingDefaults.ts); the checklist follows.
    await waitFor(() => {
      const epochRows = rowText().filter((r) => r.includes("epochs"));
      expect(epochRows).toEqual(["Centroid epochs: 50", "Centered instance epochs: 50"]);
    });
    expect(screen.queryAllByLabelText("Not set").length).toBe(0);
  });
});
