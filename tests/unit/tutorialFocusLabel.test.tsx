/**
 * The tutorial card says at the top where the step happens: the sidebar panel
 * it opens (named and iconed as in the sidebar strip), or for a step outside
 * the sidebar, its location (e.g. "File menu").
 */

import { describe, it, expect, afterEach } from "../bun-test";
import { render, act, cleanup } from "@testing-library/react";
import {
  CREATE_SKELETON_STEP,
  RUN_INFERENCE_STEP,
  SAVE_PROJECT_STEP,
  WELCOME_STEP,
  type TutorialStep,
} from "@/lib/tutorial/steps";
import { TutorialOverlay } from "@/components/tutorial/TutorialOverlay";
import { useAppStore } from "@/stores/appStore";

function showStep(step: TutorialStep) {
  act(() => {
    useAppStore.setState((s) => {
      s.tutorialActive = true;
      s.tutorialSteps = [step];
      s.tutorialStepIndex = 0;
      s.tutorialHighestStepIndex = 0;
    });
  });
  render(<TutorialOverlay />);
  return document.querySelector("[data-tutorial-focus]");
}

describe("tutorial card focus label", () => {
  afterEach(() => {
    cleanup();
    act(() => {
      useAppStore.setState((s) => {
        s.tutorialActive = false;
        s.tutorialSteps = [];
      });
    });
  });

  it("names the step's sidebar panel, with its sidebar icon", () => {
    const chip = showStep(CREATE_SKELETON_STEP);
    expect(chip?.textContent).toBe("Skeleton panel");
    expect(chip?.querySelector("svg")).not.toBeNull();
  });

  it("names other panels the same way", () => {
    expect(showStep(RUN_INFERENCE_STEP)?.textContent).toBe("Inference panel");
  });

  it("names the location of a step outside the sidebar, without an icon", () => {
    // Held incomplete: with nothing unsaved here, the real check passes at
    // once and the tutorial would move past the step before it's read.
    const chip = showStep({ ...SAVE_PROJECT_STEP, isComplete: () => false });
    expect(chip?.textContent).toBe("File menu");
    expect(chip?.querySelector("svg")).toBeNull();
  });

  it("shows nothing on the welcome card", () => {
    expect(showStep(WELCOME_STEP)).toBeNull();
  });
});
