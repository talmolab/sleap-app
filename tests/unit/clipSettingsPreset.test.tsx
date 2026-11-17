/** Export Clips' Preset menu: PyQt's Preview / Draft / Final scale presets. */

import { describe, it, expect, afterEach } from "../bun-test";
import { render, screen, cleanup } from "@testing-library/react";
import { Video } from "@talmolab/sleap-io.js";
import { ClipSettings } from "@/components/dialogs/ClipSettings";
import type { ClipConfig } from "@/lib/videoExport";

function config(scale: number): ClipConfig {
  const video = new Video({ filename: "clip.mp4", openBackend: false, backendMetadata: { shape: [100, 480, 640, 1] } });
  return { video, include: true, start: 0, end: 99, fps: 30, scale, background: "original", includeUnlabeled: false };
}

function renderWith(scale: number) {
  render(
    <ClipSettings
      config={config(scale)}
      onRange={() => {}}
      onFps={() => {}}
      onScale={() => {}}
      onBackground={() => {}}
      onIncludeUnlabeled={() => {}}
    />
  );
}

afterEach(cleanup);

describe("ClipSettings preset", () => {
  it("shows the preset matching the scale", () => {
    renderWith(0.5);
    expect(screen.getByLabelText("Preset").textContent).toBe("Draft (0.5×)");
  });

  it("shows Custom for any other scale", () => {
    renderWith(0.8);
    expect(screen.getByLabelText("Preset").textContent).toBe("Custom");
  });

  it("starts at Final for the default scale of 1", () => {
    renderWith(1);
    expect(screen.getByLabelText("Preset").textContent).toBe("Final (1×)");
  });
});
