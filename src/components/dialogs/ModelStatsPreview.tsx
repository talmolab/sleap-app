import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { useAppStore } from "@/stores/appStore";
import { Button } from "@/components/ui/button";
import { computeReceptiveField, computeCropSize, computeParamCount } from "@/lib/modelStats";
import { expandFrameBytesToRGBA, inferFrameChannels } from "@/lib/videoExport";
import type { ConfigHyperparams } from "@/stores/trainingStore";

interface ModelStatsPreviewProps {
  hp: ConfigHyperparams;
  maxStride: number;
  filters: number;
  filtersRate: number;
  outputStride: number;
  stemStride: number | null;
  backbone: string;
  inputChannels?: number;
  slot?: string;
}

const THUMBNAIL_SIZE = 200;
const DPR = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;

export function ModelStatsPreview({ hp, maxStride, filters, filtersRate, outputStride, stemStride, backbone, inputChannels = 1, slot }: ModelStatsPreviewProps) {
  const labels = useAppStore((s) => s.labels);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [thumbnail, setThumbnail] = useState<ImageBitmap | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);
  const rf = computeReceptiveField(maxStride, stemStride);
  const showCropSize = slot !== "centroid";
  // Honor a MANUAL crop size (hp.cropSize) so the preview + drawn crop box update
  // when the user edits it in the full config; fall back to the data-derived value
  // only in "Auto" mode (hp.cropSize === null). Both are in scaled-image px, matching
  // computeCropSize and the `/ hp.scale` used when drawing the crop rectangle below.
  const cropSize = showCropSize
    ? hp.cropSize ?? computeCropSize(labels, maxStride, hp.scale)
    : null;
  const params = computeParamCount(backbone, maxStride, filters, filtersRate, undefined, outputStride, stemStride, inputChannels);
  const downBlocks = Math.log2(maxStride);

  // Compute features at output stride (decoder output channels at the final up block)
  // With block_contraction=false: decoder block output = filters * rate^(max(0, downBlocks - 1 - blockIdx))
  // The last decoder block (blockIdx = upBlocks-1) determines features at the output stride
  const stemBlksForFeatures = stemStride ? Math.log2(stemStride) : 0;
  const downBlocksForFeatures = Math.log2(maxStride) - stemBlksForFeatures;
  const upBlocksForFeatures = Math.log2(maxStride / outputStride) + stemBlksForFeatures;
  const lastDecoderBlockIdx = upBlocksForFeatures - 1;
  const featuresAtStride = backbone === "unet"
    ? Math.floor(filters * Math.pow(filtersRate, Math.max(0, downBlocksForFeatures + stemBlksForFeatures - 1 - lastDecoderBlockIdx)))
    : null;
  const numKeypoints = labels?.skeletons?.[0]?.nodes?.length ?? 0;
  const headName = slot === "centroid" ? "centroids" : "confmaps";

  // Load thumbnail from first labeled frame
  useEffect(() => {
    if (!labels) return;

    let cancelled = false;

    (async () => {
      // Find first frame with user instances
      let targetFrame = null;
      for (const lf of labels.labeledFrames) {
        const hasUser = lf.instances.some((i) => !("score" in i));
        if (hasUser) { targetFrame = lf; break; }
      }

      if (!targetFrame) return;

      const video = targetFrame.video ?? labels.videos[0];
      if (!video?.backend) return;

      try {
        const frame = await video.backend.getFrame(targetFrame.frameIdx);
        if (cancelled || !frame) return;

        let bmp: ImageBitmap;
        if (frame instanceof ImageBitmap) {
          bmp = await createImageBitmap(frame);
        } else if (frame instanceof ImageData) {
          bmp = await createImageBitmap(frame);
        } else if (frame instanceof ArrayBuffer || frame instanceof Uint8Array) {
          const bytes = frame instanceof ArrayBuffer ? new Uint8Array(frame) : frame;
          const shape = video.shape;
          if (!shape) return;
          const [, h, w] = shape;
          const channels = inferFrameChannels(bytes.length, w, h, shape[3]);
          const imageData = new ImageData(
            expandFrameBytesToRGBA(bytes, w, h, channels),
            w,
            h
          );
          bmp = await createImageBitmap(imageData);
        } else if (
          frame &&
          typeof frame === "object" &&
          "data" in frame &&
          "width" in frame &&
          "height" in frame
        ) {
          const raw = frame as {
            data: Uint8Array | Uint8ClampedArray;
            width: number;
            height: number;
            channels?: number;
          };
          const bytes =
            raw.data instanceof Uint8ClampedArray
              ? new Uint8Array(raw.data)
              : raw.data;
          const imageData = new ImageData(
            expandFrameBytesToRGBA(bytes, raw.width, raw.height, raw.channels ?? 1),
            raw.width,
            raw.height
          );
          bmp = await createImageBitmap(imageData);
        } else {
          return;
        }

        if (!cancelled) {
          setThumbnail(bmp);
        }
      } catch {
        // Frame decoding failed — thumbnail stays empty
      }
    })();

    return () => { cancelled = true; };
  }, [labels]);

  // Draw thumbnail + overlay boxes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // HiDPI: scale backing buffer by devicePixelRatio
    canvas.width = THUMBNAIL_SIZE * DPR;
    canvas.height = THUMBNAIL_SIZE * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, THUMBNAIL_SIZE, THUMBNAIL_SIZE);

    if (thumbnail) {
      // Apply zoom + pan
      ctx.save();
      ctx.translate(THUMBNAIL_SIZE / 2 + pan.x, THUMBNAIL_SIZE / 2 + pan.y);
      ctx.scale(zoom, zoom);
      ctx.translate(-THUMBNAIL_SIZE / 2, -THUMBNAIL_SIZE / 2);

      // Draw scaled thumbnail centered
      const aspect = thumbnail.width / thumbnail.height;
      let drawW: number, drawH: number, offsetX: number, offsetY: number;
      if (aspect > 1) {
        drawW = THUMBNAIL_SIZE;
        drawH = THUMBNAIL_SIZE / aspect;
        offsetX = 0;
        offsetY = (THUMBNAIL_SIZE - drawH) / 2;
      } else {
        drawH = THUMBNAIL_SIZE;
        drawW = THUMBNAIL_SIZE * aspect;
        offsetX = (THUMBNAIL_SIZE - drawW) / 2;
        offsetY = 0;
      }
      ctx.drawImage(thumbnail, offsetX, offsetY, drawW, drawH);

      // Scale factor: thumbnail pixels per original pixel
      const imgScale = drawW / thumbnail.width;

      // Box center follows mouse; falls back to image center when cursor is outside
      let boxCenterX: number, boxCenterY: number;
      if (mousePos) {
        // Convert CSS mouse coords to pre-transform canvas coords
        boxCenterX = (mousePos.x - THUMBNAIL_SIZE / 2 - pan.x) / zoom + THUMBNAIL_SIZE / 2;
        boxCenterY = (mousePos.y - THUMBNAIL_SIZE / 2 - pan.y) / zoom + THUMBNAIL_SIZE / 2;
      } else {
        boxCenterX = offsetX + drawW / 2;
        boxCenterY = offsetY + drawH / 2;
      }

      // Draw crop size box (red dashed)
      if (cropSize != null) {
        const cropPx = (cropSize / hp.scale) * imgScale;
        ctx.strokeStyle = "#ef4444";
        ctx.lineWidth = 2 / zoom;
        ctx.setLineDash([6 / zoom, 4 / zoom]);
        ctx.strokeRect(boxCenterX - cropPx / 2, boxCenterY - cropPx / 2, cropPx, cropPx);
        ctx.setLineDash([]);
      }

      // Draw receptive field box (blue solid)
      const rfPx = (rf / hp.scale) * imgScale;
      ctx.strokeStyle = "#3b82f6";
      ctx.lineWidth = 3 / zoom;
      ctx.strokeRect(boxCenterX - rfPx / 2, boxCenterY - rfPx / 2, rfPx, rfPx);

      ctx.restore();
    } else {
      ctx.fillStyle = "#27272a";
      ctx.fillRect(0, 0, THUMBNAIL_SIZE, THUMBNAIL_SIZE);
      ctx.fillStyle = "#71717a";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No labeled frames", THUMBNAIL_SIZE / 2, THUMBNAIL_SIZE / 2);
    }
  }, [thumbnail, cropSize, rf, hp.scale, zoom, pan, mousePos]);

  return (
    <div className="mb-5 pb-4 border-b">
      <div className="flex gap-6">
        {/* Thumbnail canvas */}
        <div className="shrink-0">
          <div className="relative" style={{ width: THUMBNAIL_SIZE, height: THUMBNAIL_SIZE }}>
            <canvas
              ref={canvasRef}
              width={THUMBNAIL_SIZE * DPR}
              height={THUMBNAIL_SIZE * DPR}
              style={{ width: THUMBNAIL_SIZE, height: THUMBNAIL_SIZE }}
              className="rounded border border-border cursor-crosshair"
              onWheel={(e) => {
                e.preventDefault();
                setZoom((z) => Math.max(0.5, Math.min(10, z * (e.deltaY < 0 ? 1.15 : 0.87))));
              }}
              onMouseDown={(e) => {
                dragRef.current = { startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y };
              }}
              onMouseMove={(e) => {
                const rect = canvasRef.current!.getBoundingClientRect();
                setMousePos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
                if (!dragRef.current) return;
                setPan({
                  x: dragRef.current.panX + (e.clientX - dragRef.current.startX),
                  y: dragRef.current.panY + (e.clientY - dragRef.current.startY),
                });
              }}
              onMouseUp={() => { dragRef.current = null; }}
              onMouseLeave={() => { dragRef.current = null; setMousePos(null); }}
            />
            {/* Reset the zoom/pan of this preview back to its default view. */}
            <Button
              type="button"
              variant="secondary"
              size="icon-xs"
              title="Reset view"
              aria-label="Reset view"
              disabled={zoom === 1 && pan.x === 0 && pan.y === 0}
              onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}
              className="absolute top-1.5 right-1.5 shadow-sm"
            >
              <RotateCcw />
            </Button>
          </div>
        </div>

        {/* Stats text */}
        <div className="flex-1 space-y-3">
          <div className="flex items-center gap-6">
            {cropSize != null && (
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 border-2 border-red-500 border-dashed" />
                <span className="text-sm"><span className="font-medium">Crop Size:</span> {cropSize} px</span>
              </div>
            )}
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 bg-blue-500" />
              <span className="text-sm"><span className="font-medium">Receptive Field:</span> {rf} px</span>
            </div>
          </div>

          <div className="text-sm text-muted-foreground leading-relaxed">
            <p>
              Receptive field size is a function of the number
              of down blocks ({downBlocks}), the number of convolutions
              per block (2), and the convolution kernel size (3).
            </p>
            <p className="mt-1">
              You can control the number of down blocks by setting
              the <span className="font-medium text-foreground">Max Stride</span> ({maxStride}).
            </p>
            <p className="mt-1">
              You can also control the receptive field size relative to
              the original image by adjusting
              the <span className="font-medium text-foreground">Input Scaling</span> ({hp.scale}).
            </p>
          </div>

          <div className="text-sm">
            <span className="font-medium">
              {backbone === "unet" ? "UNet" : backbone === "convnext" ? "ConvNeXt" : "Swin Transformer"}:
            </span>
            <br />
            <span className="font-medium">Parameters:</span> <span className="text-muted-foreground">{params}</span>
            {featuresAtStride != null && numKeypoints > 0 && (
              <>
                <br />
                <span className="font-medium">Features ({headName} @ stride {outputStride}):</span>{" "}
                <span className="text-green-400">{featuresAtStride}→{numKeypoints} ✓</span>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
