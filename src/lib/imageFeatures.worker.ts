/**
 * Vite `?worker` entry for the image-features suggestion clustering. All math
 * lives in the pure, unit-tested imageFeaturesWorkerCore.runImageFeaturesJob —
 * this module is intentionally a thin message bridge (mirrors
 * statisticSeries.worker.ts).
 *
 * The orchestrator (imageFeatures.ts) decodes + crops + downscales frames on the
 * main thread and transfers the small RGBA buffers here (zero-copy), so the
 * heavy flatten → Gram-PCA → k-means runs off the UI thread.
 */
import {
  runImageFeaturesJob,
  type ImageFeaturesJob,
} from "./imageFeaturesWorkerCore";

self.onmessage = (e: MessageEvent<ImageFeaturesJob>) => {
  self.postMessage(runImageFeaturesJob(e.data));
};
