/**
 * "Allow Claude to control SLEAP" (desktop only, off by default). On, the app
 * runs a loopback MCP endpoint (src-tauri/src/mcp_bridge.rs) that Claude Code
 * connects to, and ONE window — the one that turned it on — answers it
 * (src/automation/mcpServer.ts). Claude can only look at Label QC flags and
 * propose fixes; the user accepts each one in the QC Review window.
 *
 * The choice is remembered. At the next launch only the first window
 * ("main") turns it back on; windows opened later never take it over.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { sleapCmd } from "@/lib/sleapPlugin";

export interface McpInfo {
  port: number;
  url: string;
}

/** What the desktop endpoint reports (mcp_status / mcp_start). */
export interface McpStatus {
  running: boolean;
  info: McpInfo | null;
  /** Label of the window that answers Claude. */
  owner: string | null;
  owner_alive: boolean;
  error: string | null;
  /** `claude mcp add-json …` with a headersHelper that reads this launch's token. */
  connect_command: string | null;
}

/** The desktop side (swapped out in tests). */
export interface ConnectorBackend {
  start(opts: { newPort: boolean }): Promise<McpStatus>;
  stop(): Promise<void>;
  status(): Promise<McpStatus>;
  /** This window's label ("main" for the first window of a launch). */
  windowLabel(): Promise<string>;
}

const tauriBackend: ConnectorBackend = {
  async start({ newPort }) {
    const { invoke } = await import("@tauri-apps/api/core");
    const { startMcpInWindow, stopMcpInWindow } = await import("@/automation/mcpServer");
    await startMcpInWindow();
    try {
      return await invoke<McpStatus>(sleapCmd("mcp_start"), { newPort });
    } catch (e) {
      await stopMcpInWindow();
      throw e;
    }
  },
  async stop() {
    const { invoke } = await import("@tauri-apps/api/core");
    const { stopMcpInWindow } = await import("@/automation/mcpServer");
    await invoke(sleapCmd("mcp_stop"));
    await stopMcpInWindow();
  },
  async status() {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<McpStatus>(sleapCmd("mcp_status"));
  },
  async windowLabel() {
    const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    return getCurrentWebviewWindow().label;
  },
};

let backend: ConnectorBackend = tauriBackend;
export function setConnectorBackend(b: ConnectorBackend): void {
  backend = b;
}

/** The launch's first window: the only one that turns the connector back on. */
export const LAUNCH_WINDOW = "main";

interface ConnectorState {
  /** The user's choice (persisted, shared by all windows). */
  enabled: boolean;
  /** The endpoint as last reported. */
  status: McpStatus | null;
  /** This window's label, once known. */
  windowLabel: string | null;
  busy: boolean;
  error: string | null;
  /** The saved port is taken: the user can choose a new one. */
  portInUse: boolean;
  /** The port just changed: the connect command must be run again. */
  portChanged: boolean;
  /** Turn on (this window answers Claude) or off. */
  setEnabled: (on: boolean, opts?: { newPort?: boolean }) => Promise<void>;
  refresh: () => Promise<void>;
  /** At startup: turn it back on if it was left on, in the launch window only. */
  resume: () => Promise<void>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const useClaudeConnectorStore = create<ConnectorState>()(
  persist(
    (set, get) => ({
      enabled: false,
      status: null,
      windowLabel: null,
      busy: false,
      error: null,
      portInUse: false,
      portChanged: false,

      setEnabled: async (on, opts) => {
        if (get().busy) return;
        set({ busy: true, error: null, portInUse: false });
        try {
          if (on) {
            const before = get().status?.info?.port ?? null;
            const status = await backend.start({ newPort: opts?.newPort ?? false });
            const windowLabel = get().windowLabel ?? (await backend.windowLabel());
            set({
              enabled: true,
              status,
              windowLabel,
              portChanged: !!opts?.newPort && status.info?.port !== before,
            });
          } else {
            await backend.stop();
            set({ enabled: false, status: null, portChanged: false });
          }
        } catch (e) {
          const msg = message(e);
          const portInUse = msg.startsWith("PORT_IN_USE");
          set({
            // A failed start leaves it off; the choice stays "on" for a taken
            // port so a relaunch tries again once the port is free.
            enabled: portInUse ? get().enabled : on ? false : get().enabled,
            error: portInUse ? msg.replace(/^PORT_IN_USE:\s*/, "") : msg,
            portInUse,
          });
        } finally {
          set({ busy: false });
        }
      },

      refresh: async () => {
        try {
          const [status, windowLabel] = await Promise.all([
            backend.status(),
            get().windowLabel ? Promise.resolve(get().windowLabel!) : backend.windowLabel(),
          ]);
          set({ status, windowLabel });
        } catch {
          // Not desktop, or the command isn't there: leave the last state.
        }
      },

      resume: async () => {
        if (!get().enabled) return;
        const label = await backend.windowLabel();
        set({ windowLabel: label });
        // Windows opened later must not take Claude away from the first one.
        if (label !== LAUNCH_WINDOW) {
          await get().refresh();
          return;
        }
        await get().setEnabled(true);
      },
    }),
    {
      name: "sleap-claude-connector",
      partialize: (s) => ({ enabled: s.enabled }),
    },
  ),
);

/** Whether this window is the one answering Claude. */
export function ownsConnector(s: Pick<ConnectorState, "status" | "windowLabel">): boolean {
  return !!s.status?.running && !!s.windowLabel && s.status.owner === s.windowLabel;
}
