/**
 * Owns one worker's `WorkerClient` connection on its caller's behalf:
 * reconnects with backoff after an unintentional close, falls back from ws to
 * iroh once a drop has lasted `FALLBACK_AFTER_MS` (desktop only, when the
 * pairing offers iroh), and — while on that fallback — probes the preferred
 * route every `PROBE_PREFERRED_EVERY_MS` and switches back on success.
 *
 * Pure and injectable: no zustand, no real timers. `connectStore` (PR2b
 * §2b.4) owns one of these per worker that's either selected or has an
 * active tracked job, and supplies `dial`/`onStatus`/`onConnected` to wire it
 * into store state; tests supply a fake clock (`now`/`sleep`) instead.
 */
import type { WorkerClient, CloseInfo } from "./client";
import type { TransportKind } from "./transport";

export type LinkStatus = "connecting" | "connected" | "reconnecting" | "offline" | "stopped";

export interface ManagedConnectionDeps {
  /** Make + connect + verify peer + authProve over `route`; resolves an authenticated client or throws. */
  dial: (route: TransportKind) => Promise<WorkerClient>;
  /** The route the user asked for / remembered — what every reconnect and probe tries to get back to. */
  preferredRoute: TransportKind;
  /** Whether falling back to iroh is possible at all (pairing has iroh info AND irohTransportAvailable()). */
  canFallBackToIroh: boolean;
  onStatus: (status: LinkStatus, route: TransportKind) => void;
  /** Fires after the initial connect, a reconnect, or a route switch — never for a client that didn't become current. */
  onConnected: (client: WorkerClient, route: TransportKind) => void;
  /** Overridable for tests; defaults to `Date.now`. */
  now?: () => number;
  /** Overridable for tests; defaults to a real `setTimeout`-backed delay. */
  sleep?: (ms: number) => Promise<void>;
}

export const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000];
export const FALLBACK_AFTER_MS = 10_000;
export const PROBE_PREFERRED_EVERY_MS = 60_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ManagedConnection {
  private readonly _dial: ManagedConnectionDeps["dial"];
  private readonly _preferredRoute: TransportKind;
  private readonly _canFallBackToIroh: boolean;
  private readonly _onStatus: ManagedConnectionDeps["onStatus"];
  private readonly _onConnected: ManagedConnectionDeps["onConnected"];
  private readonly _now: () => number;
  private readonly _sleep: (ms: number) => Promise<void>;

  private _client: WorkerClient | null = null;
  private _route: TransportKind;
  private _stopped = false;
  // Bumped on every adopted client and on stop() — a reconnect/probe loop
  // started against an earlier generation checks this and exits rather than
  // acting once it's stale (rule 8: ignore a close from a client that's no
  // longer current, and never let two loops race to "win" the same slot).
  private _generation = 0;
  private _probeGeneration = 0;

  constructor(deps: ManagedConnectionDeps) {
    this._dial = deps.dial;
    this._preferredRoute = deps.preferredRoute;
    this._canFallBackToIroh = deps.canFallBackToIroh;
    this._onStatus = deps.onStatus;
    this._onConnected = deps.onConnected;
    this._now = deps.now ?? Date.now;
    this._sleep = deps.sleep ?? defaultSleep;
    this._route = deps.preferredRoute;
  }

  get client(): WorkerClient | null {
    return this._client;
  }

  get route(): TransportKind {
    return this._route;
  }

  /**
   * Initial connect on the preferred route. Throws on failure — this is a
   * user-initiated action (pair / connect / resume-on-launch), so a failed
   * first dial is the caller's to handle; no silent retry loop starts.
   */
  async start(): Promise<WorkerClient> {
    const client = await this._dial(this._preferredRoute);
    this._route = this._preferredRoute;
    this._adopt(client);
    this._onStatus("connected", this._route);
    this._onConnected(client, this._route);
    return client;
  }

  /** Intentional stop: closes the client, cancels any retry/probe loop. Idempotent. */
  stop(): void {
    if (this._stopped) return;
    this._stopped = true;
    this._generation++;
    this._probeGeneration++;
    const client = this._client;
    this._client = null;
    this._onStatus("stopped", this._route);
    client?.close();
  }

  /** Makes `client` the current one and wires its close notification to this generation. */
  private _adopt(client: WorkerClient): void {
    this._client = client;
    const generation = ++this._generation;
    client.onClose((info) => this._handleClose(client, generation, info));
  }

  private _handleClose(client: WorkerClient, generation: number, info: CloseInfo): void {
    // A close from a client we've already moved on from (replaced by a
    // reconnect, a route switch, or stop()) is never acted on (rule 8).
    if (this._stopped || client !== this._client || generation !== this._generation) return;
    if (info.intentional) return; // our own close() — not a drop to react to
    this._client = null;
    void this._reconnectLoop(generation);
  }

  private async _reconnectLoop(generation: number): Promise<void> {
    this._onStatus("reconnecting", this._route);
    const droppedAt = this._now();
    let attempt = 0;
    let announcedOffline = false;
    let altIndex = 0;
    const routes: TransportKind[] =
      this._canFallBackToIroh && this._preferredRoute !== "iroh"
        ? [this._preferredRoute, "iroh"]
        : [this._preferredRoute];

    while (!this._stopped && generation === this._generation) {
      const elapsed = this._now() - droppedAt;
      const windowPassed = elapsed >= FALLBACK_AFTER_MS;

      // Within the window, retry the route we were on. After it, alternate
      // between every usable route, starting with the one we weren't on, so
      // neither a blocked relay nor a still-down LAN can pin us to a route
      // that never comes back (and a drop while on iroh also retries the
      // preferred route).
      let dialRoute: TransportKind = this._route;
      if (windowPassed && routes.length > 1) {
        dialRoute = routes[(routes.indexOf(this._route) + 1 + altIndex) % routes.length];
        altIndex++;
      }

      try {
        const client = await this._dial(dialRoute);
        if (this._stopped || generation !== this._generation) {
          client.close();
          return;
        }
        this._route = dialRoute;
        this._adopt(client);
        this._onStatus("connected", this._route);
        this._onConnected(client, this._route);
        if (this._route !== this._preferredRoute) this._startProbeLoop();
        return;
      } catch {
        // Fall through to backoff + retry below.
      }

      if (this._stopped || generation !== this._generation) return;
      // Unreachable on every route we tried past the window: say so (once),
      // and keep retrying.
      if (windowPassed && !announcedOffline) {
        announcedOffline = true;
        this._onStatus("offline", this._route);
      }
      const backoff = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)];
      attempt++;
      await this._sleep(backoff);
    }
  }

  private _startProbeLoop(): void {
    const probeGeneration = ++this._probeGeneration;
    const connectionGeneration = this._generation;
    void this._probeLoop(probeGeneration, connectionGeneration);
  }

  /**
   * Runs only while still on the SAME connection (`connectionGeneration`)
   * that started it and still off the preferred route — a reconnect or a
   * successful switch invalidates it (via `_generation`/`_probeGeneration`),
   * letting a fresh probe loop (or none, if back on preferred) take over.
   */
  private async _probeLoop(probeGeneration: number, connectionGeneration: number): Promise<void> {
    const stillRelevant = () =>
      !this._stopped &&
      probeGeneration === this._probeGeneration &&
      connectionGeneration === this._generation &&
      this._route !== this._preferredRoute;

    while (stillRelevant()) {
      await this._sleep(PROBE_PREFERRED_EVERY_MS);
      if (!stillRelevant()) return;

      try {
        const client = await this._dial(this._preferredRoute);
        if (!stillRelevant()) {
          client.close();
          return;
        }
        const old = this._client;
        this._route = this._preferredRoute;
        this._adopt(client); // bumps _generation; `old`'s close becomes stale and is ignored.
        old?.close();
        this._onStatus("connected", this._route);
        this._onConnected(client, this._route);
        return;
      } catch {
        // Stay on the fallback route; try again next tick.
      }
    }
  }
}
