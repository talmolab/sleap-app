/**
 * DEV-ONLY prototype gallery for the simpler pairing / connecting flow
 * (opened with `?prototype=pairing` in a dev build; see main.tsx). Nothing
 * here pairs for real: each pasted-code case is a mock of what
 * `decodePairCode` would return, so every layout can be compared on every
 * case side by side. Delete once a layout is picked and built for real.
 */

import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Copy,
  Loader2,
  Plug,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PairWorkerForm } from "@/components/connect/PairWorkerForm";

// --- mock cases --------------------------------------------------------------

type Env = "desktop" | "browser";

interface MockCode {
  label: string;
  /** What the pasted text decodes to; null = not a pairing code at all. */
  decoded: {
    workerId: string;
    expiresInSecs: number;
    /** The worker's own network addresses (proposed: added automatically). */
    addrs: string[];
    /** iroh relay: present when the worker was running when `pair` ran. */
    relay: boolean;
    /** Proposed: the worker's name, so the app can say who it's pairing with. */
    name?: string;
  } | null;
}

const CODES: Record<string, MockCode> = {
  full: {
    label: "Code with relay + network address (proposed default)",
    decoded: {
      workerId: "7HV7KAOR2QXM",
      expiresInSecs: 272,
      addrs: ["ws://192.168.1.42:9631", "ws://100.88.12.7:9631"],
      relay: true,
      name: "gpu-box-01",
    },
  },
  relayOnly: {
    label: "Code with relay only (today's default)",
    decoded: { workerId: "7HV7KAOR2QXM", expiresInSecs: 272, addrs: [], relay: true },
  },
  addrOnly: {
    label: "Code with network address only (worker started with --no-iroh)",
    decoded: {
      workerId: "7HV7KAOR2QXM",
      expiresInSecs: 272,
      addrs: ["ws://192.168.1.42:9631"],
      relay: false,
    },
  },
  nothing: {
    label: "Code with neither (worker wasn't running when `pair` ran)",
    decoded: { workerId: "7HV7KAOR2QXM", expiresInSecs: 272, addrs: [], relay: false },
  },
  expired: {
    label: "Expired code",
    decoded: { workerId: "7HV7KAOR2QXM", expiresInSecs: -180, addrs: [], relay: true },
  },
  garbage: { label: "Not a pairing code", decoded: null },
};

// --- what the app decides from a code ------------------------------------------

type Verdict =
  | { kind: "ready"; how: "auto" | "network"; detail: string }
  | { kind: "needs-address"; why: string }
  | { kind: "error"; message: string };

/** The one decision the real form makes: can it connect, and how. */
function verdict(env: Env, code: MockCode): Verdict {
  const d = code.decoded;
  if (!d) {
    return {
      kind: "error",
      message: "That doesn't look like a pairing code. Copy the whole line starting with sleap1.",
    };
  }
  if (d.expiresInSecs <= 0) {
    return {
      kind: "error",
      message: `This code expired ${Math.round(-d.expiresInSecs / 60)} min ago. Run sleap-connect pair on the worker for a new one.`,
    };
  }
  if (env === "desktop" && d.relay) {
    return { kind: "ready", how: "auto", detail: "Connects directly when it can, through a relay when it can't." };
  }
  if (d.addrs.length) {
    return { kind: "ready", how: "network", detail: `Connects over your network (${d.addrs[0]}).` };
  }
  if (env === "browser" && d.relay) {
    return {
      kind: "needs-address",
      why: "The web version can only reach workers on your network or VPN. Use the desktop app, or enter the worker's address.",
    };
  }
  return {
    kind: "needs-address",
    why: "This code doesn't say how to reach the worker. Make sure it's running (sleap-connect serve), then run sleap-connect pair again.",
  };
}

function expiresLabel(secs: number): string {
  return `expires in ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

// --- shared bits --------------------------------------------------------------

function Cmd({ children }: { children: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-black/30 px-1.5 py-0.5 font-mono text-[10px]">
      {children}
      <Copy className="h-2.5 w-2.5 cursor-pointer text-muted-foreground" />
    </span>
  );
}

function VerdictLine({ v }: { v: Verdict }) {
  if (v.kind === "ready") {
    return (
      <p className="flex items-start gap-1.5 text-[10px] text-green-400">
        <CheckCircle2 className="mt-px h-3 w-3 shrink-0" />
        <span>{v.detail}</span>
      </p>
    );
  }
  if (v.kind === "needs-address") {
    return (
      <p className="flex items-start gap-1.5 text-[10px] text-amber-400">
        <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
        <span>{v.why}</span>
      </p>
    );
  }
  return (
    <p className="flex items-start gap-1.5 text-[10px] text-red-400">
      <XCircle className="mt-px h-3 w-3 shrink-0" />
      <span>{v.message}</span>
    </p>
  );
}

/** "Advanced" disclosure with the address box — open by itself when needed. */
function Advanced({ open: forced }: { open: boolean }) {
  const [open, setOpen] = useState(false);
  const shown = open || forced;
  return (
    <div className="space-y-1">
      {!forced && (
        <button
          type="button"
          className="flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground"
          onClick={() => setOpen((o) => !o)}
        >
          <ChevronRight className={`h-3 w-3 transition-transform ${shown ? "rotate-90" : ""}`} />
          Advanced: connect by address
        </button>
      )}
      {shown && (
        <div className="space-y-1">
          <label className="text-[10px] text-muted-foreground">
            Worker address (e.g. its Tailscale IP)
          </label>
          <Input placeholder="ws://192.168.1.42:9631" className="h-7 font-mono text-xs" />
        </div>
      )}
    </div>
  );
}

function PairButton({ disabled }: { disabled: boolean }) {
  return (
    <Button size="sm" className="h-7 w-full text-xs" disabled={disabled}>
      Pair
    </Button>
  );
}

// --- layout A: just the box -----------------------------------------------------

function LayoutA({ env, code }: { env: Env; code: MockCode }) {
  const v = verdict(env, code);
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-medium">Pair with a worker</h3>
      <p className="text-[10px] leading-relaxed text-muted-foreground">
        On the worker, run <Cmd>sleap-connect pair</Cmd> and paste the code it prints.
      </p>
      <Input readOnly value="sleap1q7v…x2m" className="h-7 font-mono text-xs" />
      <VerdictLine v={v} />
      <Advanced open={v.kind === "needs-address"} />
      <PairButton disabled={v.kind === "error"} />
    </div>
  );
}

// --- layout B: box + who you're pairing with ----------------------------------------

function LayoutB({ env, code }: { env: Env; code: MockCode }) {
  const v = verdict(env, code);
  const d = code.decoded;
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-medium">Pair with a worker</h3>
      <Input readOnly value="sleap1q7v…x2m" className="h-7 font-mono text-xs" />
      {d && v.kind !== "error" ? (
        <div className="space-y-1 rounded-md border border-border bg-black/20 p-2">
          <div className="flex items-center gap-1.5 text-xs font-medium">
            <span className="h-1.5 w-1.5 rounded-full bg-zinc-500" />
            {d.name ?? `Worker ${d.workerId.slice(0, 8)}`}
            <span className="ml-auto text-[10px] font-normal text-muted-foreground">
              {expiresLabel(d.expiresInSecs)}
            </span>
          </div>
          <VerdictLine v={v} />
        </div>
      ) : (
        <VerdictLine v={v} />
      )}
      <Advanced open={v.kind === "needs-address"} />
      <PairButton disabled={v.kind === "error"} />
    </div>
  );
}

// --- layout C: guided steps -------------------------------------------------------

function LayoutC({ env, code }: { env: Env; code: MockCode }) {
  const v = verdict(env, code);
  const step = (n: number, body: React.ReactNode) => (
    <li className="flex gap-2">
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary/20 text-[9px] font-semibold text-primary">
        {n}
      </span>
      <div className="min-w-0 flex-1 space-y-1 text-[10px] text-muted-foreground">{body}</div>
    </li>
  );
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-medium">Pair with a worker</h3>
      <ol className="space-y-2">
        {step(1, <>On the GPU machine, in your data folder: <Cmd>sleap-connect serve</Cmd></>)}
        {step(2, <>Then get a code: <Cmd>sleap-connect pair</Cmd></>)}
        {step(
          3,
          <>
            <span>Paste it here:</span>
            <Input readOnly value="sleap1q7v…x2m" className="h-7 font-mono text-xs" />
            <VerdictLine v={v} />
            <Advanced open={v.kind === "needs-address"} />
          </>,
        )}
      </ol>
      <PairButton disabled={v.kind === "error"} />
    </div>
  );
}

// --- reconnecting: one button ---------------------------------------------------------

function ReconnectCard({ state }: { state: "idle" | "connecting" | "direct" | "relay" | "network" }) {
  const connected = state === "direct" || state === "relay" || state === "network";
  const via = { direct: "directly", relay: "through a relay", network: "over your network" } as const;
  return (
    <div className="space-y-1.5 rounded-md border border-border bg-zinc-800/50 p-2">
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <span className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-green-500" : "bg-zinc-500"}`} />
        gpu-box-01
      </div>
      {connected && (
        <div className="text-[10px] text-muted-foreground">
          Connected {via[state as keyof typeof via]}
        </div>
      )}
      <Button size="sm" variant={connected ? "outline" : "default"} className="h-7 w-full text-xs">
        {state === "connecting" ? (
          <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
        ) : (
          <Plug className="mr-1.5 h-3 w-3" />
        )}
        {connected ? "Disconnect" : state === "connecting" ? "Connecting…" : "Connect"}
      </Button>
    </div>
  );
}

// --- the gallery ------------------------------------------------------------------

const LAYOUTS = {
  A: { name: "A · Just the box", Component: LayoutA },
  B: { name: "B · Box + who you're pairing with", Component: LayoutB },
  C: { name: "C · Guided steps", Component: LayoutC },
} as const;

export function PairingPrototypes() {
  const [env, setEnv] = useState<Env>("desktop");
  return (
    <div className="dark min-h-screen overflow-auto bg-background p-6 text-foreground">
      <div className="mb-4 flex items-center gap-4">
        <h1 className="text-sm font-semibold">Pairing prototypes</h1>
        <div className="flex gap-1">
          {(["desktop", "browser"] as const).map((e) => (
            <Button
              key={e}
              size="sm"
              variant={env === e ? "default" : "outline"}
              className="h-6 text-[11px]"
              onClick={() => setEnv(e)}
            >
              {e === "desktop" ? "Desktop app" : "Browser"}
            </Button>
          ))}
        </div>
        <span className="text-[11px] text-muted-foreground">
          Rows: what the pasted code contains · Columns: layouts
        </span>
      </div>

      <div className="grid grid-cols-[180px_repeat(3,280px)] gap-3">
        <div />
        {Object.values(LAYOUTS).map((l) => (
          <div key={l.name} className="text-[11px] font-semibold text-muted-foreground">
            {l.name}
          </div>
        ))}
        {Object.entries(CODES).map(([key, code]) => (
          <Row key={key} env={env} code={code} />
        ))}
      </div>

      <h2 className="mb-2 mt-8 text-xs font-semibold">The real form (layout A, built) — paste a code</h2>
      <div className="w-[280px]" data-testid="real-form">
        <PairWorkerForm showCancel={false} />
      </div>

      <h2 className="mb-2 mt-8 text-xs font-semibold">Reconnecting a paired worker (one button, no transport words)</h2>
      <div className="grid grid-cols-[repeat(5,200px)] gap-3">
        {(["idle", "connecting", "direct", "relay", "network"] as const).map((s) => (
          <ReconnectCard key={s} state={s} />
        ))}
      </div>
    </div>
  );
}

function Row({ env, code }: { env: Env; code: MockCode }) {
  return (
    <>
      <div className="pt-2 text-[11px] text-muted-foreground">{code.label}</div>
      {Object.values(LAYOUTS).map(({ name, Component }) => (
        <div key={name} className="rounded-md border border-border bg-zinc-800/50 p-3">
          <Component env={env} code={code} />
        </div>
      ))}
    </>
  );
}
