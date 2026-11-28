/**
 * WelcomeScreen layout alignment tests:
 * - The main New/Open Project card stays horizontally centered (aligned with
 *   the centered SLEAP logo in background.jpg) regardless of whether the
 *   one-time "New to SLEAP?" hints prompt is visible.
 * - The hints prompt sits out of normal flow further to the left on desktop
 *   viewports (>=920px) and falls back cleanly in vertical flow on narrow
 *   viewports so it never clips off the left edge.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "../bun-test";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { useAppStore } from "@/stores/appStore";

vi.mock("@/hooks/useFileIO", () => ({
  useFileIO: () => ({
    openProject: vi.fn(),
    openFromDrop: vi.fn(),
    loading: false,
    error: null,
  }),
}));

vi.mock("@/lib/recoverableDrafts", () => ({
  loadRecoverableDrafts: async () => [],
}));

function resetStore() {
  useAppStore.setState(useAppStore.getInitialState());
}

describe("WelcomeScreen hints prompt alignment", () => {
  beforeEach(() => {
    cleanup();
    resetStore();
  });

  afterEach(cleanup);

  it("keeps the main New/Open card centered and positions the hints prompt out of flow to the left on wide viewports", async () => {
    useAppStore.setState({ hasSeenLabelingHintsPrompt: false });
    const { WelcomeScreen } = await import("@/components/layout/WelcomeScreen");
    await act(async () => {
      render(<WelcomeScreen />);
    });

    const mainCard = screen.getByTestId("welcome-main-card");
    const prompt = screen.getByTestId("welcome-hints-prompt");

    // Wrapper stacks vertically (so on narrow viewports the prompt never
    // shifts the main card sideways) and anchors the absolutely-positioned
    // prompt on >=920px viewports.
    const wrapper = mainCard.parentElement!;
    expect(prompt.parentElement).toBe(wrapper);
    expect(wrapper.className).toContain("relative");
    expect(wrapper.className).toContain("flex-col");
    expect(wrapper.className).toContain("items-center");

    // Main card is rendered before the optional prompt in the DOM and is not
    // in a horizontal flex row with it.
    expect(wrapper.firstElementChild).toBe(mainCard);

    // Prompt sits out of normal flow further to the left on >=920px viewports
    // with generous breathing room, and falls back in-flow below on narrow
    // viewports (no unconditional `absolute`).
    const classes = prompt.className.split(/\s+/);
    expect(classes).not.toContain("absolute");
    expect(classes).toContain("min-[920px]:absolute");
    expect(classes).toContain("min-[920px]:right-full");
    expect(classes).toContain("min-[920px]:top-1/2");
    expect(classes).toContain("min-[920px]:-translate-y-1/2");
    expect(classes).toContain("min-[920px]:mr-8");
    expect(classes).toContain("lg:mr-12");
    expect(classes).toContain("xl:mr-16");
  });

  it("hides the hints prompt once answered or dismissed while leaving the main card intact", async () => {
    useAppStore.setState({ hasSeenLabelingHintsPrompt: false });
    const { WelcomeScreen } = await import("@/components/layout/WelcomeScreen");
    await act(async () => {
      render(<WelcomeScreen />);
    });

    expect(screen.getByTestId("welcome-hints-prompt")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "No" }));

    expect(useAppStore.getState().hasSeenLabelingHintsPrompt).toBe(true);
    expect(useAppStore.getState().showLabelingHints).toBe(false);
    expect(screen.queryByTestId("welcome-hints-prompt")).not.toBeInTheDocument();
    expect(screen.getByTestId("welcome-main-card")).toBeInTheDocument();
  });

  it("does not render the hints prompt when already seen", async () => {
    useAppStore.setState({ hasSeenLabelingHintsPrompt: true });
    const { WelcomeScreen } = await import("@/components/layout/WelcomeScreen");
    await act(async () => {
      render(<WelcomeScreen />);
    });

    expect(screen.queryByTestId("welcome-hints-prompt")).not.toBeInTheDocument();
    expect(screen.getByTestId("welcome-main-card")).toBeInTheDocument();
  });
});
