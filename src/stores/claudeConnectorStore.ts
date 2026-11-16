/**
 * "Allow Claude to control SLEAP" (desktop only, off by default). On, the app
 * runs a loopback MCP endpoint (src-tauri/src/mcp_bridge.rs) that Claude Code
 * connects to, and this window answers it (src/automation/mcpServer.ts).
 * Claude can only look at Label QC flags and propose fixes; the user accepts
 * each one in the QC Review window.
 *
 * The choice is remembered; the endpoint restarts with the app when it's on.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { sleapCmd } from "@/lib/sleapPlugin";

export interface McpInfo {
  port: number;
  token: string;
  url: string;
}

/** Starts/stops the endpoint and this window's server (swapped out in tests). */
export interface ConnectorBackend {
  start(): Promise<McpInfo>;
  stop(): Promise<void>;
}

const tauriBackend: ConnectorBackend = {
  async start() {
    const { invoke } = await import("@tauri-apps/api/core");
    const { startMcpInWindow } = await import("@/automation/mcpServer");
    await startMcpInWindow();
    return invoke<McpInfo>(sleapCmd("mcp_start"));
  },
  async stop() {
    const { invoke } = await import("@tauri-apps/api/core");
    const { stopMcpInWindow } = await import("@/automation/mcpServer");
    await invoke(sleapCmd("mcp_stop"));
    await stopMcpInWindow();
  },
};

let backend: ConnectorBackend = tauriBackend;
export function setConnectorBackend(b: ConnectorBackend): void {
  backend = b;
}

interface ConnectorState {
  /** The user's choice (persisted). */
  enabled: boolean;
  /** Address and token while running. */
  info: McpInfo | null;
  busy: boolean;
  error: string | null;
  setEnabled: (on: boolean) => Promise<void>;
  /** At startup: start the endpoint if the user left it on. */
  resume: () => Promise<void>;
}

export const useClaudeConnectorStore = create<ConnectorState>()(
  persist(
    (set, get) => ({
      enabled: false,
      info: null,
      busy: false,
      error: null,

      setEnabled: async (on) => {
        if (get().busy) return;
        set({ busy: true, error: null });
        try {
          if (on) {
            const info = await backend.start();
            set({ enabled: true, info });
          } else {
            await backend.stop();
            set({ enabled: false, info: null });
          }
        } catch (e) {
          set({ enabled: false, info: null, error: (e as Error)?.message ?? String(e) });
        } finally {
          set({ busy: false });
        }
      },

      resume: async () => {
        if (get().enabled && !get().info) {
          set({ enabled: false }); // setEnabled sets it back once running
          await get().setEnabled(true);
        }
      },
    }),
    {
      name: "sleap-claude-connector",
      partialize: (s) => ({ enabled: s.enabled }),
    },
  ),
);

/** The command that connects Claude Code to this SLEAP (any folder: user scope). */
export function claudeMcpAddCommand(info: McpInfo): string {
  return `claude mcp add --scope user --transport http sleap ${info.url} --header "Authorization: Bearer ${info.token}"`;
}
