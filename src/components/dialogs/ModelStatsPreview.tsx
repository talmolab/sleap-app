import { useEffect, useRef, useState } from "react";
import { useAppStore } from "@/stores/appStore";
import { computeReceptiveField, computeCropSize, computeParamCount } from "@/lib/modelStats";
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

export function ModelStatsPreview({ hp, maxStride, filters, filtersRate, outputStride, stemStride, backbone, inputChannels = 1, slot }: ModelStatsPreviewProps) {
  const labels = useAppStore((s) => s.labels);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [thumbnail, setThumbnail] = useState<ImageBitmap | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);
  const rf = computeReceptiveField(maxStride, stemStride);
  const showCropSize = slot !== "centroid";
  const cropSize = showCropSize ? computeCropSize(labels, maxStride, hp.scale) : null;
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
          const imageData = new ImageData(new Uint8ClampedArray(bytes), w, h);
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

    ctx.setTransform(1, 0, 0, 1, 0, 0);
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
      const centerX = offsetX + drawW / 2;
      const centerY = offsetY + drawH / 2;

      // Draw crop size box (red dashed)
      if (cropSize != null) {
        const cropPx = (cropSize / hp.scale) * imgScale;
        ctx.strokeStyle = "#ef4444";
        ctx.lineWidth = 2 / zoom;
        ctx.setLineDash([6 / zoom, 4 / zoom]);
        ctx.strokeRect(centerX - cropPx / 2, centerY - cropPx / 2, cropPx, cropPx);
        ctx.setLineDash([]);
      }

      // Draw receptive field box (blue solid)
      const rfPx = (rf / hp.scale) * imgScale;
      ctx.strokeStyle = "#3b82f6";
      ctx.lineWidth = 3 / zoom;
      ctx.strokeRect(centerX - rfPx / 2, centerY - rfPx / 2, rfPx, rfPx);

      ctx.restore();
    } else {
      ctx.fillStyle = "#27272a";
      ctx.fillRect(0, 0, THUMBNAIL_SIZE, THUMBNAIL_SIZE);
      ctx.fillStyle = "#71717a";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No labeled frames", THUMBNAIL_SIZE / 2, THUMBNAIL_SIZE / 2);
    }
  }, [thumbnail, cropSize, rf, hp.scale, zoom, pan]);

  return (
    <div className="mb-5 pb-4 border-b">
      <div className="flex gap-6">
        {/* Thumbnail canvas */}
        <div className="shrink-0">
          <canvas
            ref={canvasRef}
            width={THUMBNAIL_SIZE}
            height={THUMBNAIL_SIZE}
            className="rounded border border-border cursor-grab active:cursor-grabbing"
            onWheel={(e) => {
              e.preventDefault();
              setZoom((z) => Math.max(0.5, Math.min(10, z * (e.deltaY < 0 ? 1.15 : 0.87))));
            }}
            onMouseDown={(e) => {
              dragRef.current = { startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y };
            }}
            onMouseMove={(e) => {
              if (!dragRef.current) return;
              setPan({
                x: dragRef.current.panX + (e.clientX - dragRef.current.startX),
                y: dragRef.current.panY + (e.clientY - dragRef.current.startY),
              });
            }}
            onMouseUp={() => { dragRef.current = null; }}
            onMouseLeave={() => { dragRef.current = null; }}
          />
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
