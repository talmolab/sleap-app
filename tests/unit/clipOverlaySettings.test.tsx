/** Render Clip's Overlay / Motion trails section. */

import { describe, it, expect, afterEach } from "../bun-test";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ClipOverlaySettings } from "@/components/dialogs/ClipOverlaySettings";
import { initialClipOverlayStyle, type ClipOverlayStyle } from "@/lib/videoExport";

const style = initialClipOverlayStyle({
  markerSize: 4,
  boldLines: false,
  showEdges: true,
  trailLength: 0,
  trailNode: "centroid",
  trailWidth: 4,
  trailAlpha: 1,
  trailFade: true,
});

afterEach(cleanup);

describe("ClipOverlaySettings", () => {
  it("disables trail options until trails are turned on", () => {
    render(<ClipOverlaySettings style={style} nodeNames={["head"]} hasTracks onChange={() => {}} />);
    expect(screen.getByLabelText("Length (frames)")).toBeDisabled();
    expect(screen.getByLabelText("Show motion trails")).not.toBeDisabled();
  });

  it("enables trail options when trails are on", () => {
    render(<ClipOverlaySettings style={{ ...style, showTrails: true }} nodeNames={["head"]} hasTracks onChange={() => {}} />);
    expect(screen.getByLabelText("Length (frames)")).not.toBeDisabled();
  });

  it("explains and disables trails in an untracked project", () => {
    render(<ClipOverlaySettings style={{ ...style, showTrails: true }} nodeNames={[]} hasTracks={false} onChange={() => {}} />);
    expect(screen.getByLabelText("Show motion trails")).toBeDisabled();
    expect(screen.getByText(/this project has none/)).toBeInTheDocument();
  });

  it("reports edits as patches", () => {
    const patches: Partial<ClipOverlayStyle>[] = [];
    render(<ClipOverlaySettings style={style} nodeNames={[]} hasTracks onChange={(p) => patches.push(p)} />);
    fireEvent.click(screen.getByLabelText("Nodes"));
    expect(patches).toContainEqual({ showNodes: false });
    fireEvent.change(screen.getByLabelText("Line width (px)"), { target: { value: "3" } });
    expect(patches).toContainEqual({ lineWidth: 3 });
  });
});
