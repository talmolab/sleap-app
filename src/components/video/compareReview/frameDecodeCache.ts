/**
 * Review prototypes (dev only): decoded frames shared by the crop canvases, so
 * several panes of one frame decode it once.
 *
 * Only successful decodes are kept. A read can fail for a moment — e.g. while
 * the main canvas is seeking to the same frame on a worker-decoded video, or
 * while the video's backend is still starting — and a failure that was cached
 * left a pane black for good (hand-test of #525 on a grayscale mp4). On a
 * worker-decoded video, many reads at once (a page of crops plus the main
 * canvas) also made some come back empty. So reads go one at a time, a failed
 * read is retried a few times with a growing pause, and failures are never
 * cached.
 */
import type { Video } from "@/types";
import { frameToCanvas } from "@/lib/frameCanvas";

export type FrameDrawable = OffscreenCanvas | HTMLCanvasElement;

export interface DecodeDeps {
  read: (video: Video, frame: number) => Promise<unknown>;
  toDrawable: (raw: unknown, video: Video) => Promise<FrameDrawable | null>;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: DecodeDeps = {
  read: (video, frame) => video.getFrame(frame, { prefetch: false }),
  toDrawable: (raw, video) => frameToCanvas(raw, video.shape),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** Tries per frame before giving up (the pane then says the frame isn't available). */
export const DECODE_ATTEMPTS = 5;
const CACHE_SIZE = 48;
const cache = new Map<string, FrameDrawable>();
const pending = new Map<string, Promise<FrameDrawable | null>>();
const videoIds = new WeakMap<Video, number>();
let nextVideoId = 1;
/** Reads run one after another (see the module comment). */
let queue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

function keyOf(video: Video, frame: number): string {
  let id = videoIds.get(video);
  if (id === undefined) videoIds.set(video, (id = nextVideoId++));
  return `${id}:${frame}`;
}

/** The frame as something drawable, or null after {@link DECODE_ATTEMPTS} failed tries. */
export function decodeFrame(video: Video, frame: number, deps: DecodeDeps = defaultDeps): Promise<FrameDrawable | null> {
  const key = keyOf(video, frame);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const p = (async () => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < DECODE_ATTEMPTS; attempt++) {
      if (attempt > 0) await deps.sleep(200 * attempt);
      try {
        const drawable = await oneAtATime(async () => deps.toDrawable(await deps.read(video, frame), video));
        if (drawable) {
          if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value as string);
          cache.set(key, drawable);
          return drawable;
        }
        lastError = "frame could not be converted";
      } catch (e) {
        lastError = e;
      }
    }
    console.warn(`[compare review] frame ${frame} not available after ${DECODE_ATTEMPTS} tries:`, lastError);
    return null;
  })().finally(() => pending.delete(key));
  pending.set(key, p);
  return p;
}

/** For tests. */
export function clearFrameDecodeCache(): void {
  cache.clear();
  pending.clear();
  queue = Promise.resolve();
}
