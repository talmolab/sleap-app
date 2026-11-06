/**
 * NumberInput: SLEAP/Qt spin-box behavior — type freely, commit valid values
 * live, settle (revert / clamp / round / null) on blur or Enter, Escape reverts.
 */
import { describe, it, expect, afterEach } from "../bun-test";
import { useState } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { NumberInput } from "@/components/NumberInput";

afterEach(() => cleanup());

function Harness(props: { initial: number | null; nullable?: boolean; min?: number; max?: number; integer?: boolean }) {
  const [value, setValue] = useState<number | null>(props.initial);
  const commits = (globalThis as unknown as { __commits: Array<number | null> }).__commits;
  const onCommit = (n: number | null) => {
    commits.push(n);
    setValue(n);
  };
  return (
    <>
      {props.nullable ? (
        <NumberInput aria-label="field" nullable value={value} onCommit={onCommit} min={props.min} max={props.max} integer={props.integer} />
      ) : (
        <NumberInput aria-label="field" value={value} onCommit={(n) => onCommit(n)} min={props.min} max={props.max} integer={props.integer} />
      )}
      <output data-testid="value">{String(value)}</output>
    </>
  );
}

function setup(props: Parameters<typeof Harness>[0]) {
  (globalThis as unknown as { __commits: Array<number | null> }).__commits = [];
  render(<Harness {...props} />);
  const input = screen.getByLabelText("field") as HTMLInputElement;
  fireEvent.focus(input);
  return {
    input,
    commits: (globalThis as unknown as { __commits: Array<number | null> }).__commits,
    value: () => screen.getByTestId("value").textContent,
  };
}

describe("NumberInput", () => {
  it("can be cleared while editing without snapping back to 0", () => {
    const { input, commits, value } = setup({ initial: 5 });
    fireEvent.change(input, { target: { value: "" } });
    expect(input.value).toBe("");
    expect(commits).toEqual([]);
    expect(value()).toBe("5");
  });

  it("commits each valid keystroke live", () => {
    const { input, commits, value } = setup({ initial: 0.5 });
    fireEvent.change(input, { target: { value: "0.25" } });
    expect(commits).toEqual([0.25]);
    expect(value()).toBe("0.25");
  });

  it("keeps typed text like 01 until blur, then tidies it", () => {
    const { input, commits } = setup({ initial: 0 });
    fireEvent.change(input, { target: { value: "01" } });
    expect(input.value).toBe("01");
    expect(commits).toEqual([1]);
    fireEvent.blur(input);
    expect(input.value).toBe("1");
  });

  it("reverts an empty box to the last value on blur", () => {
    const { input, commits } = setup({ initial: 8 });
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(input.value).toBe("8");
    expect(commits).toEqual([]);
  });

  it("commits null for an empty nullable box, on blur only", () => {
    const { input, commits, value } = setup({ initial: 3, nullable: true });
    fireEvent.change(input, { target: { value: "" } });
    expect(commits).toEqual([]);
    fireEvent.blur(input);
    expect(commits).toEqual([null]);
    expect(value()).toBe("null");
  });

  it("doesn't commit out-of-range text live, and clamps it on blur", () => {
    const { input, commits, value } = setup({ initial: 8, min: 1, max: 512 });
    fireEvent.change(input, { target: { value: "0" } });
    expect(commits).toEqual([]);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    fireEvent.blur(input);
    expect(commits).toEqual([1]);
    expect(value()).toBe("1");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "9999" } });
    fireEvent.blur(input);
    expect(value()).toBe("512");
  });

  it("rounds integers on blur and doesn't commit fractions live", () => {
    const { input, commits, value } = setup({ initial: 4, integer: true });
    fireEvent.change(input, { target: { value: "2.6" } });
    expect(commits).toEqual([]);
    fireEvent.blur(input);
    expect(value()).toBe("3");
  });

  it("Enter settles and Escape reverts", () => {
    const { input, value } = setup({ initial: 10, min: 1 });
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);
    expect(input.value).toBe("10");
    expect(value()).toBe("10");

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "-3" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    expect(value()).toBe("1");
  });

  it("isn't marked invalid for a valid draft", () => {
    const { input } = setup({ initial: 2, min: 0 });
    fireEvent.change(input, { target: { value: "3" } });
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });
});
