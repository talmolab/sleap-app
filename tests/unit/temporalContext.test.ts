import { describe, expect, test } from "../bun-test";
import {
  loupeOffsets,
  neighborFrameIndices,
  missingSideNote,
  offsetLabel,
  windowLabel,
} from "@/lib/temporalContext";

describe("neighborFrameIndices", () => {
  test("nearest first, both sides", () => {
    expect(neighborFrameIndices(10, 2, 100)).toEqual([9, 11, 8, 12]);
  });

  test("leaves out frames past either end", () => {
    expect(neighborFrameIndices(0, 2, 100)).toEqual([1, 2]);
    expect(neighborFrameIndices(99, 2, 100)).toEqual([98, 97]);
  });

  test("unknown length only clamps the start", () => {
    expect(neighborFrameIndices(1, 2, null)).toEqual([0, 2, 3]);
  });

  test("only the chosen side", () => {
    expect(neighborFrameIndices(10, 2, 100, { earlier: true, later: false })).toEqual([9, 8]);
    expect(neighborFrameIndices(10, 2, 100, { earlier: false, later: true })).toEqual([11, 12]);
    expect(neighborFrameIndices(10, 2, 100, { earlier: false, later: false })).toEqual([]);
  });
});

describe("loupeOffsets", () => {
  test("loops out to +N, back through 0 to -N, and toward 0", () => {
    expect(loupeOffsets([-1, 1, -2, 2])).toEqual([0, 1, 2, 1, 0, -1, -2, -1]);
  });

  test("skips the side with no frames", () => {
    expect(loupeOffsets([1, 2])).toEqual([0, 1, 2, 1]);
    expect(loupeOffsets([-1, -2])).toEqual([0, -1, -2, -1]);
    expect(loupeOffsets([1])).toEqual([0, 1]);
  });

  test("just the current frame without neighbors", () => {
    expect(loupeOffsets([])).toEqual([0]);
  });
});

test("offsetLabel", () => {
  expect(offsetLabel(0)).toBe("current");
  expect(offsetLabel(2)).toBe("+2");
  expect(offsetLabel(-1)).toBe("−1");
});

test("windowLabel follows the chosen side(s)", () => {
  expect(windowLabel({ earlier: true, later: true })).toBe("Frames each side");
  expect(windowLabel({ earlier: true, later: false })).toBe("Frames before");
  expect(windowLabel({ earlier: false, later: true })).toBe("Frames after");
});

test("missingSideNote names a chosen side with no frames", () => {
  const both = { earlier: true, later: true };
  const earlierOnly = { earlier: true, later: false };
  // Frame 0: nothing before it.
  expect(missingSideNote(earlierOnly, false, true)).toBe("no earlier frames");
  expect(missingSideNote(both, false, true)).toBe("no earlier frames");
  // Last frame: nothing after it.
  expect(missingSideNote({ earlier: false, later: true }, true, false)).toBe("no later frames");
  expect(missingSideNote(both, false, false)).toBe("no other frames");
  // An unchosen side never counts as missing.
  expect(missingSideNote(earlierOnly, true, false)).toBeNull();
  expect(missingSideNote({ earlier: false, later: false }, false, false)).toBeNull();
});
