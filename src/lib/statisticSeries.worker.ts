/**
 * Vite `?worker` entry for offloading the heavy seekbar header statistic
 * graphs (point displacement, primary point displacement, min centroid
 * proximity) off the main thread. All math lives in the pure, unit-tested
 * statisticSeriesWorkerCore.runWorkerJob — this module is intentionally a
 * thin message bridge.
 */
import { runWorkerJob, type WorkerRequest } from "./statisticSeriesWorkerCore";

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  self.postMessage(runWorkerJob(e.data));
};
