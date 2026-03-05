/**
 * URL hash state encoding/decoding for permalink support.
 *
 * Encodes video index, frame index, and instance index in the URL hash
 * so that URLs can be shared to restore a specific view state.
 *
 * Format: #v=0&f=42&i=1
 */

import { useAppStore } from "../stores/appStore";

/** Encode current state to URL hash. */
export function encodeStateToHash(): void {
  const { labels, video, frameIdx, instance, labeledFrame } =
    useAppStore.getState();
  if (!labels || !video) {
    history.replaceState(null, "", location.pathname);
    return;
  }
  const videoIdx = labels.videos.indexOf(video);
  const params = new URLSearchParams();
  if (videoIdx >= 0) params.set("v", String(videoIdx));
  params.set("f", String(frameIdx));
  if (instance && labeledFrame) {
    const instIdx = labeledFrame.instances.indexOf(instance);
    if (instIdx >= 0) params.set("i", String(instIdx));
  }
  history.replaceState(null, "", "#" + params.toString());
}

/** Decode URL hash to state params. */
export function decodeHashToState(): {
  videoIdx?: number;
  frameIdx?: number;
  instanceIdx?: number;
} | null {
  const hash = location.hash.slice(1);
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  const result: {
    videoIdx?: number;
    frameIdx?: number;
    instanceIdx?: number;
  } = {};
  if (params.has("v")) {
    const v = parseInt(params.get("v")!, 10);
    if (!isNaN(v)) result.videoIdx = v;
  }
  if (params.has("f")) {
    const f = parseInt(params.get("f")!, 10);
    if (!isNaN(f)) result.frameIdx = f;
  }
  if (params.has("i")) {
    const i = parseInt(params.get("i")!, 10);
    if (!isNaN(i)) result.instanceIdx = i;
  }
  return Object.keys(result).length > 0 ? result : null;
}

/** Apply decoded hash state to the store. Call after project is loaded. */
export function applyHashState(): void {
  const decoded = decodeHashToState();
  if (!decoded) return;

  const state = useAppStore.getState();
  if (!state.labels) return;

  // Set video by index
  if (decoded.videoIdx !== undefined) {
    const video = state.labels.videos[decoded.videoIdx];
    if (video) {
      state.setVideo(video);
    }
  }

  // Set frame index
  if (decoded.frameIdx !== undefined) {
    useAppStore.getState().setFrameIdx(decoded.frameIdx);
  }

  // Set instance by index
  if (decoded.instanceIdx !== undefined) {
    const lf = useAppStore.getState().labeledFrame;
    if (lf && lf.instances[decoded.instanceIdx]) {
      useAppStore.getState().setInstance(lf.instances[decoded.instanceIdx]);
    }
  }
}

/**
 * Subscribe to store changes and update URL hash with debouncing.
 * Returns an unsubscribe function.
 */
export function initUrlStateSync(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const debouncedEncode = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(encodeStateToHash, 100);
  };

  // Subscribe to the specific keys that affect the URL hash
  const unsubVideo = useAppStore.subscribe(
    (s) => s.video,
    () => debouncedEncode()
  );
  const unsubFrame = useAppStore.subscribe(
    (s) => s.frameIdx,
    () => debouncedEncode()
  );
  const unsubInstance = useAppStore.subscribe(
    (s) => s.instance,
    () => debouncedEncode()
  );

  return () => {
    if (timer) clearTimeout(timer);
    unsubVideo();
    unsubFrame();
    unsubInstance();
  };
}
