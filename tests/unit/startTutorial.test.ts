/**
 * Unit tests for `requestStartTutorial` — the "Start Tutorial" menu entry
 * point. With no project open it starts the tutorial in place; with one open it
 * asks first and, on confirm, opens a new window carrying `?tutorial=1`
 * instead of adding sample data to the open project.
 */
import { describe, it, expect, vi, beforeEach } from "../bun-test";

const openNewInstanceMock = vi.fn(async (_opts?: { tutorial?: boolean }) => {});
vi.mock("@/lib/newInstance", () => ({ openNewInstance: openNewInstanceMock }));

import { useAppStore } from "@/stores/appStore";
import { useConfirmStore } from "@/stores/confirmStore";
import { readTutorialParam, requestStartTutorial } from "@/lib/tutorial/startTutorial";

describe("readTutorialParam", () => {
  it("is true only for tutorial=1", () => {
    expect(readTutorialParam("?tutorial=1")).toBe(true);
    expect(readTutorialParam("?openFile=%2Fa.slp&tutorial=1")).toBe(true);
    expect(readTutorialParam("?tutorial=0")).toBe(false);
    expect(readTutorialParam("")).toBe(false);
  });
});

describe("requestStartTutorial", () => {
  beforeEach(() => {
    openNewInstanceMock.mockClear();
    useAppStore.setState({ tutorialActive: false });
  });

  it("starts the tutorial in place when no project is open", async () => {
    useAppStore.setState({ projectLoaded: false });
    await requestStartTutorial();
    expect(useAppStore.getState().tutorialActive).toBe(true);
    expect(openNewInstanceMock).not.toHaveBeenCalled();
  });

  it("opens a new tutorial window on confirm when a project is open", async () => {
    useAppStore.setState({ projectLoaded: true });
    const pending = requestStartTutorial();
    expect(useConfirmStore.getState().request).not.toBeNull();
    useConfirmStore.getState().respond(true);
    await pending;
    expect(openNewInstanceMock).toHaveBeenCalledWith({ tutorial: true });
    expect(useAppStore.getState().tutorialActive).toBe(false);
  });

  it("does nothing on cancel when a project is open", async () => {
    useAppStore.setState({ projectLoaded: true });
    const pending = requestStartTutorial();
    useConfirmStore.getState().respond(false);
    await pending;
    expect(openNewInstanceMock).not.toHaveBeenCalled();
    expect(useAppStore.getState().tutorialActive).toBe(false);
  });
});
