/**
 * Unit tests for the co-visibility QC model (V3 feature
 * visibility_pattern_score).
 *
 * Faithful port of the reference suite github.com/alexwu-z/sleap-qc-webapp
 * (src/lib/qc/checks/features/visibility.test.js), a lab JS port of Python
 * `sleap.qc`, intended for integration into sleap-app.
 *
 * worstNode answers WHICH node; worstNodeDetail also answers WHICH WAY —
 * "absent" (expected co-visible yet missing) vs "present" (rarely co-visible
 * yet labelled) — because the two conditions call for opposite canvas marks.
 */
import { describe, it, expect } from "../bun-test";
import { VisibilityModel } from "@/lib/analyze/qc/visibility";

const T = true,
  F = false;

describe("VisibilityModel.worstNode — co-visibility culprit", () => {
  it("blames the node that should be visible but is absent", () => {
    const masks = Array.from({ length: 20 }, () => [T, T, T, T]); // always co-visible
    const m = new VisibilityModel().fit(masks);
    expect(m.worstNode([T, T, F, T])).toBe(2); // node 2 missing though expected
  });

  it("blames the node that is rarely co-visible yet present", () => {
    const masks = Array.from({ length: 20 }, (_, i) =>
      i === 19 ? [T, T, T, T] : [T, T, T, F],
    );
    const m = new VisibilityModel().fit(masks); // node 3 visible only 1/20 -> rare
    expect(m.worstNode([T, T, T, T])).toBe(3); // node 3 present though rare
  });

  it("returns -1 for a pose consistent with the learned pattern", () => {
    const masks = Array.from({ length: 20 }, () => [T, T, T, T]);
    const m = new VisibilityModel().fit(masks);
    expect(m.worstNode([T, T, T, T])).toBe(-1);
  });
});

describe("VisibilityModel.worstNodeDetail — which way the node is wrong", () => {
  it('an expected-but-missing node is "absent"', () => {
    const masks = Array.from({ length: 20 }, () => [T, T, T, T]);
    const d = new VisibilityModel().fit(masks).worstNodeDetail([T, T, F, T]);
    expect(d.node).toBe(2);
    expect(d.kind).toBe("absent");
  });

  it('a rarely-co-visible node that IS labelled is "present"', () => {
    const masks = Array.from({ length: 20 }, (_, i) =>
      i === 19 ? [T, T, T, T] : [T, T, T, F],
    );
    const d = new VisibilityModel().fit(masks).worstNodeDetail([T, T, T, T]);
    expect(d.node).toBe(3);
    expect(d.kind).toBe("present");
  });

  it("kind is null when nothing is blamed", () => {
    const masks = Array.from({ length: 20 }, () => [T, T, T, T]);
    const d = new VisibilityModel().fit(masks).worstNodeDetail([T, T, T, T]);
    expect(d).toMatchObject({ node: -1, kind: null });
  });

  it("worstNode stays exactly the node worstNodeDetail names", () => {
    const masks = Array.from({ length: 20 }, () => [T, T, T, T]);
    const m = new VisibilityModel().fit(masks);
    for (const mask of [
      [T, T, F, T],
      [F, T, T, T],
      [T, T, T, T],
    ]) {
      expect(m.worstNode(mask)).toBe(m.worstNodeDetail(mask).node);
    }
  });
});

describe("VisibilityModel.score — pattern score + violations", () => {
  it("a consistent pose scores 0 violations", () => {
    const masks = Array.from({ length: 20 }, () => [T, T, T, T]);
    const s = new VisibilityModel().fit(masks).score([T, T, T, T]);
    expect(s.nViolations).toBe(0);
    expect(s.patternScore).toBe(0);
  });

  it("a missing expected node scores a violation", () => {
    const masks = Array.from({ length: 20 }, () => [T, T, T, T]);
    const s = new VisibilityModel().fit(masks).score([T, T, F, T]);
    expect(s.nViolations).toBeGreaterThan(0);
    expect(s.patternScore).toBeGreaterThan(0);
    expect(s.patternScore).toBeLessThanOrEqual(1);
  });

  it("score() before fit() throws", () => {
    expect(() => new VisibilityModel().score([T, T])).toThrow();
  });
});
