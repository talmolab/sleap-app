/**
 * How a batch physically leaves the app. Two runtimes, two transports.
 *
 *   web       `fetch` to analytics.sleap.ai. Cross-origin, so it needs the
 *             service's CORS answer, which exists for `/v2/events` only.
 *             `/ping` is unreachable from a browser by design.
 *   desktop   a native command (`analytics_post`, src-tauri/src/analytics.rs).
 *             Native code is not subject to CORS, so it can reach `/ping` too
 *             — which is what makes the desktop app work against a service
 *             that has not been upgraded yet. The WebView passes only a PATH;
 *             the host is fixed in Rust, so the command cannot be used to post
 *             to anywhere else.
 */

import type { Transport } from "./client";

/** Where events go. Overridable at build time for local service development. */
export const DEFAULT_ANALYTICS_URL = "https://analytics.sleap.ai";

export function analyticsBaseUrl(): string {
  const override = import.meta.env?.VITE_ANALYTICS_URL;
  const base = typeof override === "string" && override ? override : DEFAULT_ANALYTICS_URL;
  return base.replace(/\/+$/, "");
}

const REQUEST_TIMEOUT_MS = 15_000;

/** The part of `fetch` this transport uses (so a test can supply a plain function). */
export type FetchLike = (url: string, init: RequestInit) => Promise<Pick<Response, "status">>;

export function createWebTransport(
  baseUrl: string = analyticsBaseUrl(),
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
): Transport {
  return {
    canLegacyPing: false,
    async post(path, body, opts) {
      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
      try {
        const response = await fetchImpl(`${baseUrl}${path}`, {
          method: "POST",
          // application/json makes this a preflighted request, which the
          // service requires: it is what lets it restrict browser senders to
          // our own origins.
          headers: { "Content-Type": "application/json" },
          body,
          mode: "cors",
          // No cookies, no referrer: the request carries the batch and nothing else.
          credentials: "omit",
          referrerPolicy: "no-referrer",
          cache: "no-store",
          // Lets a batch sent while the tab is closing still complete.
          keepalive: opts?.keepalive === true,
          signal: controller?.signal,
        });
        return response.status;
      } catch {
        return 0;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export function createDesktopTransport(invoke: Invoke, command: string): Transport {
  return {
    canLegacyPing: true,
    async post(path, body) {
      try {
        const status = await invoke(command, { path, body });
        return typeof status === "number" ? status : 0;
      } catch {
        return 0;
      }
    },
  };
}
