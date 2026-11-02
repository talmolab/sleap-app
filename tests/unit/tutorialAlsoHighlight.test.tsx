/**
 * The tutorial rings a step's `alsoHighlightSelector` controls, not only its
 * target: on "Create a skeleton" the card sends the user to the builder's bar
 * at the top of the frame, so that bar is ringed too once it appears, and the
 * card is kept off it.
 *
 * happy-dom lays nothing out, so each stand-in element gets a fixed rect.
 */

import { describe, it, expect, beforeEach, afterEach } from "../bun-test";
import { render, waitFor, act, cleanup } from "@testing-library/react";
import { CREATE_SKELETON_STEP } from "@/lib/tutorial/steps";
import { TutorialOverlay } from "@/components/tutorial/TutorialOverlay";
import { useAppStore } from "@/stores/appStore";

type Box = { top: number; left: number; width: number; height: number };

function placeStandIn(dataTutorial: string, box: Box): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-tutorial", dataTutorial);
  el.getBoundingClientRect = () =>
    ({
      ...box,
      x: box.left,
      y: box.top,
      right: box.left + box.width,
      bottom: box.top + box.height,
      toJSON: () => box,
    }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

const rings = () => document.querySelectorAll("[data-tutorial-spotlight]");

// Sidebar button on the right; the builder bar centered at the top of the canvas.
const BUTTON: Box = { top: 200, left: 760, width: 240, height: 24 };
const BAR: Box = { top: 40, left: 220, width: 420, height: 34 };

describe("tutorial alsoHighlightSelector", () => {
  beforeEach(() => {
    act(() => {
      useAppStore.setState((s) => {
        s.tutorialActive = true;
        s.tutorialSteps = [CREATE_SKELETON_STEP];
        s.tutorialStepIndex = 0;
        s.tutorialHighestStepIndex = 0;
      });
    });
  });

  afterEach(() => {
    cleanup();
    document
      .querySelectorAll("[data-tutorial]")
      .forEach((el) => el.remove());
    act(() => {
      useAppStore.setState((s) => {
        s.tutorialActive = false;
        s.tutorialSteps = [];
      });
    });
  });

  it("names the skeleton builder bar on the create-skeleton step", () => {
    expect(CREATE_SKELETON_STEP.alsoHighlightSelector).toBe(
      '[data-tutorial="skeleton-build-bar"]',
    );
    expect(CREATE_SKELETON_STEP.body).toContain("highlighted bar");
  });

  it("rings only the button until the builder bar appears, then both", async () => {
    placeStandIn("draw-skeleton-button", BUTTON);
    render(<TutorialOverlay />);
    await waitFor(() => expect(rings().length).toBe(1));

    // Opening the builder mounts its bar; the overlay picks it up from the DOM.
    // In the app a MutationObserver notices it, but happy-dom drops observer
    // registrations when Bun garbage-collects (they're held weakly), so that
    // path is flaky here. A resize is the hook's other re-measure trigger.
    act(() => {
      placeStandIn("skeleton-build-bar", BAR);
      window.dispatchEvent(new Event("resize"));
    });
    await waitFor(() => expect(rings().length).toBe(2));

    const tops = Array.from(rings()).map((r) => (r as HTMLElement).style.top);
    expect(tops).toContain(`${BUTTON.top - 6}px`);
    expect(tops).toContain(`${BAR.top - 6}px`);
  });

  it("keeps the card off the builder bar", async () => {
    placeStandIn("draw-skeleton-button", BUTTON);
    // Right where the card would sit to the left of the button, so placement
    // has to move it: a narrow viewport puts the frame's bar level with the
    // sidebar button.
    const inTheWay: Box = { top: 160, left: 420, width: 330, height: 120 };
    placeStandIn("skeleton-build-bar", inTheWay);
    render(<TutorialOverlay />);
    await waitFor(() => expect(rings().length).toBe(2));

    const card = document.querySelector("[data-tutorial-overlay]") as HTMLElement;
    const top = parseFloat(card.style.top);
    const left = parseFloat(card.style.left);
    // The card's default size; happy-dom measures it as 0×0, which is ignored.
    const width = 300;
    const height = 150;
    const overlaps =
      left < inTheWay.left + inTheWay.width &&
      left + width > inTheWay.left &&
      top < inTheWay.top + inTheWay.height &&
      top + height > inTheWay.top;
    expect(overlaps).toBe(false);
  });

  it("stops ringing the bar once the step is over", async () => {
    placeStandIn("draw-skeleton-button", BUTTON);
    placeStandIn("skeleton-build-bar", BAR);
    render(<TutorialOverlay />);
    await waitFor(() => expect(rings().length).toBe(2));

    act(() => {
      useAppStore.setState((s) => {
        s.tutorialActive = false;
      });
    });
    await waitFor(() => expect(rings().length).toBe(0));
  });
});
