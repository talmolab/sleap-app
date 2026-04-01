import { useEffect, useState } from "react";
import {
  LogOut,
  Loader2,
  Unplug,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useConnectStore } from "@/stores/connectStore";
import { isTauri } from "@/platform/index";
import { runPythonCommand } from "@/platform/backend";

// GitHub OAuth config
const GITHUB_CLIENT_ID =
  import.meta.env?.VITE_GITHUB_CLIENT_ID || "Ov23liqVylRvty5d84VS";
const SIGNALING_HTTP =
  import.meta.env?.VITE_SIGNALING_HTTP || "https://signaling.sleap.ai";

// GitHub OAuth SVG icon
const GitHubIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="currentColor"
  >
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
  </svg>
);

function StatusDot({ status }: { status: string }) {
  const color =
    status === "available"
      ? "bg-green-500"
      : status === "busy"
        ? "bg-orange-500"
        : "bg-zinc-400";
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${color}`} />;
}

export function ConnectPanel() {
  const credentials = useConnectStore((s) => s.credentials);
  const connectionStatus = useConnectStore((s) => s.connectionStatus);
  const connectionError = useConnectStore((s) => s.connectionError);
  const roomId = useConnectStore((s) => s.roomId);
  const availableRooms = useConnectStore((s) => s.availableRooms);
  const workers = useConnectStore((s) => s.workers);
  const selectedWorkerId = useConnectStore((s) => s.selectedWorkerId);
  const setCredentials = useConnectStore((s) => s.setCredentials);
  const connect = useConnectStore((s) => s.connect);
  const disconnect = useConnectStore((s) => s.disconnect);
  const connectToWorker = useConnectStore((s) => s.connectToWorker);
  const fetchRooms = useConnectStore((s) => s.fetchRooms);
  const loadCredentialsFromDisk = useConnectStore(
    (s) => s.loadCredentialsFromDisk,
  );

  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [expandedWorkerId, setExpandedWorkerId] = useState<string | null>(null);

  // Auto-detect credentials on mount (desktop only)
  useEffect(() => {
    if (isTauri && !credentials) {
      loadCredentialsFromDisk();
    }
  }, []);

  // Handle GitHub OAuth callback (web only)
  useEffect(() => {
    if (isTauri || credentials) return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    if (!code) return;

    // Clear URL params immediately
    window.history.replaceState({}, "", window.location.pathname);

    (async () => {
      setLoggingIn(true);
      setLoginError(null);
      try {
        const res = await fetch(
          `${SIGNALING_HTTP}/api/auth/github/callback`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              code,
              redirect_uri:
                window.location.origin + window.location.pathname,
            }),
          },
        );
        if (!res.ok) {
          const err = await res.json();
          setLoginError(err.detail || "OAuth exchange failed");
          return;
        }
        const data = await res.json();
        setCredentials({
          jwt: data.jwt,
          username: data.user.username,
          avatarUrl: data.user.avatar_url,
          defaultRoom: data.user.default_room,
        });
      } catch (err) {
        setLoginError(
          err instanceof Error ? err.message : "OAuth callback failed",
        );
      } finally {
        setLoggingIn(false);
      }
    })();
  }, []);

  // Fetch rooms when credentials become available
  useEffect(() => {
    if (credentials) {
      fetchRooms();
    }
  }, [credentials]);

  const handleLogin = async () => {
    if (!isTauri) {
      // Web: redirect to GitHub OAuth
      const redirectUri =
        window.location.origin + window.location.pathname;
      const authUrl = new URL(
        "https://github.com/login/oauth/authorize",
      );
      authUrl.searchParams.set("client_id", GITHUB_CLIENT_ID);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("scope", "read:user");
      window.location.href = authUrl.toString();
      return;
    }

    // Desktop: existing sleap-rtc login flow
    setLoggingIn(true);
    setLoginError(null);
    try {
      await loadCredentialsFromDisk();
      if (useConnectStore.getState().credentials) return;

      const success = await runPythonCommand("sleap-rtc", ["login"], (event) => {
        if (event.event === "stderr") {
          console.warn("[connect:login]", event.data.line);
        }
      });
      if (success) {
        await loadCredentialsFromDisk();
        if (!useConnectStore.getState().credentials) {
          setLoginError("Login completed but credentials were not saved.");
        }
      } else {
        setLoginError("Login process exited without completing.");
      }
    } catch (err) {
      setLoginError(
        err instanceof Error ? err.message : "Failed to start login",
      );
    } finally {
      setLoggingIn(false);
    }
  };

  // ── Not logged in ──────────────────────────────────────────
  if (!credentials) {
    return (
      <div className="p-2 space-y-3">
        <div className="bg-zinc-800/50 border border-border rounded-md p-5 text-center space-y-2">
          <h3 className="text-sm font-medium">Connect to SLEAP Workers</h3>
          <p className="text-[10px] text-muted-foreground">
            Log in with GitHub to connect to remote workers for inference and
            training.
          </p>
          <Button
            size="sm"
            className="gap-2"
            onClick={handleLogin}
            disabled={loggingIn}
          >
            {loggingIn ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <GitHubIcon />
            )}
            {loggingIn ? "Waiting for browser..." : "Login with GitHub"}
          </Button>
        </div>
        {loginError && (
          <div className="bg-red-500/8 border border-red-500/20 rounded-md p-2 text-[11px] text-red-400">
            {loginError}
          </div>
        )}
        {isTauri ? (
          <div className="bg-blue-500/8 border border-blue-500/20 rounded-md p-2 text-[11px] text-blue-400 leading-relaxed">
            <b>Tip:</b> If you&apos;ve already run{" "}
            <code className="bg-black/30 px-1 py-0.5 rounded text-[10px] font-mono">
              sleap-rtc login
            </code>{" "}
            from the terminal, your credentials will be detected automatically.
          </div>
        ) : (
          <div className="bg-blue-500/8 border border-blue-500/20 rounded-md p-2 text-[11px] text-blue-400 leading-relaxed">
            <b>Tip:</b> Log in with GitHub to connect to remote GPU workers
            for training and inference.
          </div>
        )}
      </div>
    );
  }

  // ── Logged in ──────────────────────────────────────────────
  return (
    <div className="p-2 space-y-1">
      {/* User info */}
      <div className="flex items-center gap-2 py-1">
        <div className="w-7 h-7 rounded-full bg-primary flex items-center justify-center text-xs font-semibold text-primary-foreground">
          {credentials.username.slice(0, 2).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium truncate">
            {credentials.username}
          </div>
        </div>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => {
            disconnect();
            setCredentials(null);
          }}
        >
          <LogOut className="h-3 w-3" />
        </Button>
      </div>

      <div className="h-px bg-border" />

      {connectionStatus === "disconnected" && (
        <>
          {/* Room selector */}
          <div className="space-y-1 py-1">
            <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              Room
            </label>
            <Select
              value={roomId || credentials.defaultRoom || ""}
              onValueChange={(v) =>
                useConnectStore.setState({ roomId: v })
              }
            >
              <SelectTrigger className="h-7 text-xs">
                <SelectValue placeholder="Select a room" />
              </SelectTrigger>
              <SelectContent>
                {availableRooms.map((room) => (
                  <SelectItem key={room.roomId} value={room.roomId}>
                    <span>{room.name || room.roomId}</span>
                    <span className="text-muted-foreground ml-1.5">
                      · {room.workerCount ?? 0} worker{room.workerCount !== 1 ? "s" : ""}
                    </span>
                  </SelectItem>
                ))}
                {availableRooms.length === 0 && credentials.defaultRoom && (
                  <SelectItem value={credentials.defaultRoom}>
                    {credentials.defaultRoom}
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>
          <Button
            className="w-full h-8 text-xs"
            onClick={() =>
              connect(roomId || credentials.defaultRoom || "")
            }
            disabled={!roomId && !credentials.defaultRoom}
          >
            Connect
          </Button>
        </>
      )}

      {connectionStatus === "connecting" && (
        <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Connecting...
        </div>
      )}

      {connectionStatus === "error" && (
        <div className="bg-red-500/8 border border-red-500/20 rounded-md p-2 text-[11px] text-red-400">
          {connectionError || "Connection failed"}
        </div>
      )}

      {connectionStatus === "connected" && (
        <>
          {/* Connected status */}
          <div className="flex items-center gap-1.5 py-1">
            <span className="w-2 h-2 rounded-full bg-green-500" />
            <span className="text-xs">
              Connected to <b>{availableRooms.find((r) => r.roomId === roomId)?.name || roomId}</b>
            </span>
            <Button
              variant="ghost"
              size="xs"
              className="ml-auto"
              onClick={disconnect}
            >
              <Unplug className="h-3 w-3" />
            </Button>
          </div>

          <div className="h-px bg-border" />

          {/* Workers */}
          <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            Workers ({workers.length})
          </label>
          {workers.length === 0 && (
            <p className="text-[10px] text-muted-foreground py-1">
              No workers found in this room.
            </p>
          )}
          {workers.map((w) => {
            const isSelected = selectedWorkerId === w.peerId;
            const isExpanded = expandedWorkerId === w.peerId;
            return (
              <div
                key={w.peerId}
                className={`border rounded-md p-2 transition-colors ${
                  isSelected
                    ? "bg-primary/10 border-primary"
                    : "bg-zinc-800/50 border-border"
                } ${w.status === "available" && !isSelected ? "cursor-pointer hover:border-muted-foreground/50" : ""}`}
                onClick={() => {
                  if (w.status === "available" && !isSelected) {
                    setExpandedWorkerId(isExpanded ? null : w.peerId);
                  }
                }}
              >
                <div className="flex items-center gap-1.5 text-xs font-medium">
                  <StatusDot status={w.status} />
                  {w.name}
                  {isSelected && (
                    <span className="text-[10px] text-primary ml-auto">Connected</span>
                  )}
                </div>
                {w.gpu && (
                  <div className="text-[10px] text-muted-foreground font-mono mt-0.5">
                    {w.gpu.model} · {Math.round(w.gpu.memoryMb / 1024)} GB ·
                    CUDA {w.gpu.cudaVersion}
                  </div>
                )}
                {isExpanded && !isSelected && w.status === "available" && (
                  <Button
                    size="sm"
                    className="w-full mt-2 h-7 text-xs"
                    onClick={(e) => {
                      e.stopPropagation();
                      setExpandedWorkerId(null);
                      connectToWorker(w.peerId);
                    }}
                  >
                    Connect to {w.name}
                  </Button>
                )}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
