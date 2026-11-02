/**
 * The "Create a skeleton" card's example: a cropped mouse from the sample
 * video with the tutorial's skeleton drawn over it, behind a toggle.
 */

import { describe, it, expect, afterEach } from "../bun-test";
import { render, act, cleanup, fireEvent, screen } from "@testing-library/react";
import { CREATE_SKELETON_STEP, TUTORIAL_SKELETON } from "@/lib/tutorial/steps";
import { TutorialOverlay } from "@/components/tutorial/TutorialOverlay";
import { useAppStore } from "@/stores/appStore";

const example = CREATE_SKELETON_STEP.example!;

describe("skeleton example data", () => {
  it("shows exactly the skeleton the step asks for", () => {
    expect(example.nodes.map((n) => n.name)).toEqual([...TUTORIAL_SKELETON.nodes]);
    expect(example.edges).toEqual(TUTORIAL_SKELETON.edges.map(([s, d]) => [s, d]));
  });

  it("places every node inside the image", () => {
    for (const n of example.nodes) {
      expect(n.x).toBeGreaterThan(0);
      expect(n.x).toBeLessThan(example.width);
      expect(n.y).toBeGreaterThan(0);
      expect(n.y).toBeLessThan(example.height);
    }
  });

  it("points at the bundled image", () => {
    expect(example.imageUrl).toContain("mouse-skeleton-example.jpg");
  });
});

describe("skeleton example on the card", () => {
  afterEach(() => {
    cleanup();
    act(() => {
      useAppStore.setState((s) => {
        s.tutorialActive = false;
        s.tutorialSteps = [];
      });
    });
  });

  function showCreateSkeleton() {
    act(() => {
      useAppStore.setState((s) => {
        s.tutorialActive = true;
        s.tutorialSteps = [CREATE_SKELETON_STEP];
        s.tutorialStepIndex = 0;
        s.tutorialHighestStepIndex = 0;
      });
    });
    render(<TutorialOverlay />);
  }

  it("puts the toggle right after the first paragraph, before the instructions", () => {
    showCreateSkeleton();
    const toggle = screen.getByRole("button", { name: "Show an example skeleton" });
    const card = document.querySelector("[data-tutorial-overlay]")!;
    const text = card.textContent ?? "";
    const firstParagraph = CREATE_SKELETON_STEP.body.split("\n\n")[0].replace(/\*\*/g, "");
    const at = (needle: string) => text.indexOf(needle);
    expect(at(firstParagraph)).toBeGreaterThan(-1);
    expect(at("Show an example skeleton")).toBeGreaterThan(at(firstParagraph));
    expect(at("Show an example skeleton")).toBeLessThan(at("We've moved to"));
    // Colored like a primary action, so it isn't missed.
    expect(toggle.className).toContain("text-primary");
  });

  it("flips its label between show and hide", () => {
    showCreateSkeleton();
    fireEvent.click(screen.getByRole("button", { name: "Show an example skeleton" }));
    const hide = screen.getByRole("button", { name: "Hide the example skeleton" });
    expect(hide.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(hide);
    expect(document.querySelector("[data-tutorial-example]")).toBeNull();
  });

  it("is hidden until the toggle is clicked", () => {
    showCreateSkeleton();
    const toggle = screen.getByRole("button", { name: "Show an example skeleton" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("[data-tutorial-example]")).toBeNull();
  });

  it("draws the three nodes, their names, and both edges with arrows", () => {
    showCreateSkeleton();
    fireEvent.click(screen.getByRole("button", { name: "Show an example skeleton" }));

    const figure = document.querySelector("[data-tutorial-example]")!;
    expect(figure.querySelector("img")?.getAttribute("src")).toContain("mouse-skeleton-example.jpg");
    expect(screen.getByRole("img", { name: /head, torso and tailbase/ })).toBeInTheDocument();
    expect(figure.querySelectorAll("circle")).toHaveLength(3);
    expect(Array.from(figure.querySelectorAll("text")).map((t) => t.textContent)).toEqual([
      "head",
      "torso",
      "tailbase",
    ]);
    const lines = figure.querySelectorAll("line");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.getAttribute("marker-end")).toBe("url(#tutorial-example-arrow)");
    }
    expect(figure.querySelector("figcaption")?.textContent).toContain("start at torso");
  });

  it("starts each edge at torso", () => {
    showCreateSkeleton();
    fireEvent.click(screen.getByRole("button", { name: "Show an example skeleton" }));
    const torso = example.nodes.find((n) => n.name === "torso")!;
    for (const line of document.querySelectorAll("[data-tutorial-example] line")) {
      expect(Number(line.getAttribute("x1"))).toBeCloseTo(torso.x);
      expect(Number(line.getAttribute("y1"))).toBeCloseTo(torso.y);
    }
  });
});
