/**
 * Welcome screen "Unsaved work" dropdown: the per-draft detail line helpers and
 * the menu's restore / discard (with inline confirm) wiring.
 */

import { describe, it, expect, vi } from "../bun-test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  UnsavedWorkDropdown,
  folderOf,
  contentsLabel,
} from "@/components/layout/UnsavedWork";
import type { RecoverableDraft } from "@/lib/recoverableDrafts";

/** An async spy typed as the prop it stands in for (the vi shim's Mock type is untyped). */
const spy = <A extends unknown[] = []>() =>
  vi.fn(async () => {}) as unknown as (...args: A) => Promise<void>;

function draft(over: Partial<RecoverableDraft> = {}): RecoverableDraft {
  return {
    key: "k1",
    displayName: "mice.slp",
    savedAt: Date.now() - 4 * 60_000,
    projectPath: "/Users/someone/labels/mice/mice.slp",
    videoCount: 2,
    embedded: false,
    restore: spy(),
    discard: spy(),
    ...over,
  };
}

function openMenu() {
  const trigger = screen.getByRole("button", { name: /Unsaved work/ });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
}

describe("Unsaved work detail helpers", () => {
  it("abbreviates the home folder and drops the file name", () => {
    expect(folderOf("/Users/someone/labels/mice/mice.slp")).toBe("~/labels/mice");
    expect(folderOf("/home/someone/x/a.slp")).toBe("~/x");
    expect(folderOf("C:\\Users\\someone\\data\\a.slp")).toBe("~\\data");
    expect(folderOf("/Volumes/share/a.slp")).toBe("/Volumes/share");
  });

  it("describes what the draft carries", () => {
    expect(contentsLabel(draft({ videoCount: 1 }))).toBe("1 video");
    expect(contentsLabel(draft({ videoCount: 3 }))).toBe("3 videos");
    expect(contentsLabel(draft({ videoCount: 0 }))).toBe("no videos");
    expect(contentsLabel(draft({ embedded: true }))).toBe("embedded frames");
  });
});

describe("UnsavedWorkDropdown", () => {
  it("shows the draft count and lists each draft's detail", () => {
    const drafts = [draft(), draft({ key: "k2", displayName: "untitled.slp", projectPath: null, videoCount: 1 })];
    render(
      <UnsavedWorkDropdown drafts={drafts} loading={false} onDiscard={spy<[RecoverableDraft]>()} onDiscardAll={spy()} />,
    );
    expect(screen.getByRole("button", { name: /Unsaved work/ }).textContent).toContain("2");
    openMenu();
    expect(screen.getByText("~/labels/mice")).toBeInTheDocument();
    expect(screen.getByText("never saved to disk")).toBeInTheDocument();
    expect(screen.getByText(/2 videos · saved 4 min ago/)).toBeInTheDocument();
  });

  it("restores a draft when its row is chosen", async () => {
    const d = draft();
    render(<UnsavedWorkDropdown drafts={[d]} loading={false} onDiscard={spy<[RecoverableDraft]>()} onDiscardAll={spy()} />);
    openMenu();
    fireEvent.click(screen.getByText("mice.slp"));
    await waitFor(() => expect(d.restore).toHaveBeenCalledTimes(1));
  });

  it("asks before discarding, and discards only on confirm", async () => {
    const d = draft();
    const onDiscard = spy<[RecoverableDraft]>();
    render(<UnsavedWorkDropdown drafts={[d]} loading={false} onDiscard={onDiscard} onDiscardAll={spy()} />);
    openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Discard mice.slp" }));
    expect(d.restore).not.toHaveBeenCalled();
    expect(onDiscard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(onDiscard).toHaveBeenCalledWith(d));
  });

  it("offers Discard all only when there is more than one draft", () => {
    const onDiscardAll = spy();
    render(
      <UnsavedWorkDropdown
        drafts={[draft(), draft({ key: "k2" })]}
        loading={false}
        onDiscard={spy<[RecoverableDraft]>()}
        onDiscardAll={onDiscardAll}
      />,
    );
    openMenu();
    fireEvent.click(screen.getByText("Discard all…"));
    expect(onDiscardAll).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onDiscardAll).toHaveBeenCalledTimes(1);
  });
});
