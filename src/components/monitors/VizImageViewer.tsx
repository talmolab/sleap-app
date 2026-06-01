import { useState, useEffect, useRef } from "react";
import type { ModelProgress } from "@/stores/trainingStore";
import { getPlatform } from "@/platform";

/**
 * Validation/Training visualization panel for the Loss Viewer modal
 * (PyQt LossViewer viz side-panel parity).
 *
 * sleap-nn writes per-epoch PNGs to `<runDir>/viz/validation.{epoch:04d}.png`
 * and `train.{epoch:04d}.png` (epoch 0-based) at the end of each epoch. The
 * images only exist live DURING training (keep_viz is off, so sleap-nn deletes
 * them afterward) — so the panel must handle "file not found" gracefully for
 * early epochs and after training finishes.
 *
 * Reads PNG bytes via the platform FS wrapper and renders a Blob URL (the asset
 * protocol is disabled, so convertFileSrc is not used). The web platform's
 * readFile throws, which the catch handles → placeholder.
 */
export function VizImageViewer({ model }: { model: ModelProgress }) {
  const [kind, setKind] = useState<"validation" | "train">("validation");
  const [url, setUrl] = useState<string | null>(null);
  const objUrlRef = useRef<string | null>(null);

  const latestEpoch =
    model.epochSamples.length > 0
      ? model.epochSamples[model.epochSamples.length - 1].epoch
      : null;
  const runDir = model.runDir;

  useEffect(() => {
    let cancelled = false;
    const revoke = () => {
      if (objUrlRef.current) {
        URL.revokeObjectURL(objUrlRef.current);
        objUrlRef.current = null;
      }
    };
    if (!runDir || latestEpoch == null) {
      setUrl(null);
      return;
    }
    const path = `${runDir}/viz/${kind}.${String(latestEpoch).padStart(4, "0")}.png`;
    (async () => {
      try {
        const platform = await getPlatform();
        const bytes = await platform.readFile(path); // Uint8Array
        if (cancelled) return;
        const blob = new Blob([bytes as BlobPart], { type: "image/png" });
        const u = URL.createObjectURL(blob);
        revoke();
        objUrlRef.current = u;
        setUrl(u);
      } catch {
        if (!cancelled) {
          revoke();
          setUrl(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runDir, latestEpoch, kind]);

  useEffect(
    () => () => {
      if (objUrlRef.current) URL.revokeObjectURL(objUrlRef.current);
    },
    [],
  );

  if (!runDir) return null; // remote / no local viz dir

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="text-muted-foreground">Visualization:</span>
        <select
          className="bg-transparent border border-muted-foreground/30 rounded px-1 py-0.5 text-[10px]"
          value={kind}
          onChange={(e) => setKind(e.target.value as "validation" | "train")}
        >
          <option value="validation">Validation</option>
          <option value="train">Training</option>
        </select>
      </div>
      <div
        className="flex items-center justify-center rounded border border-muted-foreground/20 bg-black/20"
        style={{ height: 200 }}
      >
        {url ? (
          <img
            src={url}
            alt={`${kind} visualization`}
            className="max-h-[196px] max-w-full object-contain"
          />
        ) : (
          <span className="text-[10px] text-muted-foreground">
            {latestEpoch == null
              ? "Waiting for first epoch…"
              : "No visualization available"}
          </span>
        )}
      </div>
    </div>
  );
}
