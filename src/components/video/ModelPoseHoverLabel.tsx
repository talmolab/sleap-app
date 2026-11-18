/**
 * Hover label for a model's pose (Compare Model Predictions), in the same
 * style as the canvas's caption for a hovered project instance: "Predicted
 * Instance · <model name>", plus the node's name and position when the
 * pointer is on a node. Shown only while no project instance is hovered.
 */
import type { RefObject } from "react";
import { useAppStore } from "@/stores/appStore";
import { useModelOverlayStore } from "@/stores/modelOverlayStore";
import { useModelOverlayUiStore } from "@/stores/modelOverlayUiStore";

/** Pure: the label's lines for a hover, or null when it no longer points at a pose. */
export function modelHoverLines(
  modelName: string,
  pose: { xy: Float64Array; score: number | null; trackName: string | null } | undefined,
  node: number | null,
  nodeNames: readonly string[]
): string[] | null {
  if (!pose) return null;
  const lines = [`Predicted Instance · ${modelName}`];
  if (node !== null) {
    const x = pose.xy[2 * node];
    const y = pose.xy[2 * node + 1];
    if (Number.isFinite(x) && Number.isFinite(y)) {
      lines.push(`${nodeNames[node] ?? `node_${node}`} · x: ${x.toFixed(1)}, y: ${y.toFixed(1)}`);
    }
  }
  const extra = [pose.trackName, pose.score !== null ? `score ${pose.score.toFixed(2)}` : null].filter(Boolean);
  if (extra.length > 0) lines.push(extra.join(" · "));
  return lines;
}

export function ModelPoseHoverLabel({ containerRef }: { containerRef: RefObject<HTMLDivElement | null> }) {
  const hover = useModelOverlayUiStore((s) => s.hover);
  const models = useModelOverlayStore((s) => s.models);
  const frameIdx = useAppStore((s) => s.frameIdx);
  const skeleton = useAppStore((s) => s.skeleton);
  if (!hover) return null;
  const model = models.find((m) => m.id === hover.modelId);
  if (!model || !model.visible) return null;
  const lines = modelHoverLines(
    model.name,
    model.frames.get(frameIdx)?.[hover.pose],
    hover.node,
    skeleton?.nodes.map((n) => n.name) ?? []
  );
  const rect = containerRef.current?.getBoundingClientRect();
  if (!lines || !rect) return null;
  return (
    <div
      className="absolute pointer-events-none bg-black/70 text-white/90 text-[11px] rounded shadow px-1.5 py-1 z-20"
      style={{ left: hover.clientX - rect.left + 16, top: hover.clientY - rect.top - 8 }}
      data-testid="model-pose-hover-label"
    >
      {lines.map((l, i) => (
        <div key={i} className={i > 0 ? "text-white/70" : undefined}>
          {l}
        </div>
      ))}
    </div>
  );
}
