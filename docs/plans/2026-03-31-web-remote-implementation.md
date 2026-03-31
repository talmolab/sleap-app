# Web App Remote Training & Inference Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable remote training and inference from the web version of sleap-app by adding browser GitHub OAuth and removing `isTauri` gates on Training/Inference panels.

**Architecture:** Three component changes: ConnectPanel gets browser OAuth (redirect to GitHub + callback handler), TrainingPanel and InferencePanel remove their `isTauri` gates and auto-enable remote mode when running in browser. No store or infrastructure changes needed.

**Tech Stack:** React 19, TypeScript 5.7, browser `window.location` for OAuth redirect, `URLSearchParams` for callback parsing

**Design doc:** `docs/plans/2026-03-31-web-remote-training-inference.md`

**Branch:** `amick/remote-web-pipeline`

---

## Task 1: Add GitHub OAuth for web login in ConnectPanel

**Files:**
- Modify: `src/components/panels/ConnectPanel.tsx`

### Step 1: Add OAuth config and callback handler

Add a constant for the GitHub client ID and signaling server URL at the top of the file (after imports):

```typescript
const GITHUB_CLIENT_ID = import.meta.env?.VITE_GITHUB_CLIENT_ID || "Ov23liThtdK2nvPctNXU";
const SIGNALING_HTTP = import.meta.env?.VITE_SIGNALING_HTTP || "https://signaling.sleap.ai";
```

### Step 2: Add OAuth callback effect

Inside `ConnectPanel`, add a `useEffect` that checks for the OAuth `code` parameter on mount. This handles the redirect back from GitHub:

```typescript
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
      const res = await fetch(`${SIGNALING_HTTP}/api/auth/github/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          redirect_uri: window.location.origin + window.location.pathname,
        }),
      });
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
      setLoginError(err instanceof Error ? err.message : "OAuth callback failed");
    } finally {
      setLoggingIn(false);
    }
  })();
}, []);
```

### Step 3: Update handleLogin for web

Replace the `handleLogin` function to branch on `isTauri`:

```typescript
const handleLogin = async () => {
  if (!isTauri) {
    // Web: redirect to GitHub OAuth
    const redirectUri = window.location.origin + window.location.pathname;
    const authUrl = new URL("https://github.com/login/oauth/authorize");
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
    setLoginError(err instanceof Error ? err.message : "Failed to start login");
  } finally {
    setLoggingIn(false);
  }
};
```

### Step 4: Update the tip text for web

In the "Not logged in" view, update the tip at the bottom to be conditional:

Replace the existing tip `<div>` with:

```typescript
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
    <b>Tip:</b> Log in with GitHub to connect to remote GPU workers for training and inference.
  </div>
)}
```

### Step 5: Run build

Run: `cd /Users/amickl/repos/sleap-app && npm run build`
Expected: PASS

### Step 6: Commit

```bash
git add src/components/panels/ConnectPanel.tsx
git commit -m "feat: add browser GitHub OAuth login for web app"
```

---

## Task 2: Enable TrainingPanel for web with remote-only mode

**Files:**
- Modify: `src/components/panels/TrainingPanel.tsx`

### Step 1: Replace the isTauri gate

Replace the existing gate (lines 455-463):
```typescript
if (!isTauri) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
      <p className="text-xs text-muted-foreground">
        Training is only available in the desktop app.
      </p>
    </div>
  );
}
```

With a connection check for web users:
```typescript
if (!isTauri && connectionStatus !== "connected") {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
      <p className="text-xs text-muted-foreground">
        Connect to a worker in the Connect tab to start remote training.
      </p>
    </div>
  );
}
```

### Step 2: Auto-enable remote in browser

Change the `remoteEnabled` state initialization:
```typescript
const [remoteEnabled, setRemoteEnabled] = useState(!isTauri);
```

This defaults to `true` in browser, `false` on desktop.

### Step 3: Hide the Remote section in browser

Wrap the Remote section (the `<Section title="Remote" ...>` block and its preceding `<Separator />`) with a conditional:

```typescript
{isTauri && (
  <>
    <Separator />
    <Section title="Remote" defaultOpen={false}>
      {/* ... existing Remote section content ... */}
    </Section>
  </>
)}
```

### Step 4: Run build

Run: `cd /Users/amickl/repos/sleap-app && npm run build`
Expected: PASS

### Step 5: Commit

```bash
git add src/components/panels/TrainingPanel.tsx
git commit -m "feat: enable TrainingPanel for web with remote-only mode"
```

---

## Task 3: Enable InferencePanel for web with remote-only mode

**Files:**
- Modify: `src/components/panels/InferencePanel.tsx`

### Step 1: Replace the isTauri gate

Replace the existing gate (lines 311-317):
```typescript
if (!isTauri) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
      <p className="text-xs text-muted-foreground">Inference is only available in the desktop app.</p>
    </div>
  );
}
```

With a connection check for web users:
```typescript
if (!isTauri && connectionStatus !== "connected") {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
      <p className="text-xs text-muted-foreground">
        Connect to a worker in the Connect tab to start remote inference.
      </p>
    </div>
  );
}
```

### Step 2: Auto-enable remote in browser

Change the `remoteEnabled` state initialization:
```typescript
const [remoteEnabled, setRemoteEnabled] = useState(!isTauri);
```

### Step 3: Hide local-only UI in browser

Wrap the following with `{isTauri && ...}` or `{(!remoteEnabled || isTauri) && ...}`:

a) The `sleap-nn not detected` warning (lines 364-369):
```typescript
{!sleapNnAvailable && isTauri && (
  <div className="rounded-md border ...">
    <p className="font-medium">sleap-nn not detected</p>
    ...
  </div>
)}
```

b) The Device selector in the Inference section — wrap with `{isTauri && ...}`:
```typescript
{isTauri && (
  <div className="flex items-center justify-between gap-2">
    <span className="text-[10px] text-muted-foreground">Device</span>
    <Select value={device} ...>
      ...
    </Select>
  </div>
)}
```

c) The Remote section (toggle + worker selector) — hide in browser:
```typescript
{isTauri && (
  <>
    <Separator />
    <Section title="Remote" defaultOpen={false}>
      {/* ... existing Remote section content ... */}
    </Section>
  </>
)}
```

### Step 4: Update Load Results button for web

Replace the Load Results button (around line 807-813) with a conditional:

```typescript
{inferenceStatus === "completed" && outputPath && (
  isTauri ? (
    <Button size="sm" className="h-7 text-xs"
      onClick={async () => { setMerging(true); await loadAndMergeResults(); setMerging(false); }}
      disabled={merging}>
      {merging ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Download className="h-3.5 w-3.5 mr-1" />}
      {merging ? "Loading..." : "Load Results"}
    </Button>
  ) : (
    <div className="text-[10px] text-muted-foreground">
      Results saved on worker. Download from the worker filesystem to load.
    </div>
  )
)}
```

### Step 5: Update canRun guard for web

The `canRun` logic already handles remote mode:
```typescript
const canRun = (remoteEnabled ? (!!selectedWorkerId && !!remoteDataPath) : sleapNnAvailable) && !isRunning && !isDone && activeModelPaths.length > 0;
```

Since `remoteEnabled` is `true` in browser, it will check for `selectedWorkerId` and `remoteDataPath` — correct. No change needed.

### Step 6: Run build and tests

Run: `cd /Users/amickl/repos/sleap-app && npm run build && npm test -- --run`
Expected: PASS

### Step 7: Commit

```bash
git add src/components/panels/InferencePanel.tsx
git commit -m "feat: enable InferencePanel for web with remote-only mode"
```

---

## Task 4: Integration verification

### Step 1: Run full build

Run: `cd /Users/amickl/repos/sleap-app && npm run build`
Expected: No errors

### Step 2: Run all tests

Run: `cd /Users/amickl/repos/sleap-app && npm test -- --run`
Expected: All tests pass

### Step 3: Lint modified files

Run: `npx eslint src/components/panels/ConnectPanel.tsx src/components/panels/TrainingPanel.tsx src/components/panels/InferencePanel.tsx`
Expected: 0 errors in modified files

### Step 4: Verify web mode visually

Run: `npm run dev`
Expected (in browser, not Tauri):
- ConnectPanel: "Login with GitHub" redirects to GitHub OAuth
- After login: room selector and worker list appear
- After connecting to worker:
  - TrainingPanel: shows remote-only mode (no Remote toggle), config upload works
  - InferencePanel: shows remote-only mode (no Device selector, no Remote toggle), model/data browser works
  - Both panels show "Start Remote Training" / "Run Remote Inference" buttons

### Step 5: Verify desktop mode unchanged

Run: `npm run tauri:dev` (if available)
Expected:
- ConnectPanel: "Login with GitHub" runs sleap-rtc subprocess
- TrainingPanel: shows full UI with Remote toggle
- InferencePanel: shows full UI with Device selector and Remote toggle

### Step 6: Commit any fixes

```bash
git add -A
git commit -m "fix: resolve integration issues from web remote pipeline"
```

---

## Summary

| Task | Component | Change |
|------|-----------|--------|
| 1 | ConnectPanel | Browser GitHub OAuth (redirect + callback) |
| 2 | TrainingPanel | Remove isTauri gate, auto-enable remote, hide Remote section |
| 3 | InferencePanel | Remove isTauri gate, auto-enable remote, hide local-only fields, results message |
| 4 | Integration | Build, test, lint, visual verification |

**Total: 4 tasks, ~100 lines of changes**

---

## Configuration (one-time, outside codebase)

After implementation, the following GitHub OAuth configuration is needed:
- Add `https://app.sleap.ai` as an authorized redirect URI in the GitHub OAuth app settings
- Add `https://app.sleap.ai/dev/` for dev deployments
- Add `http://localhost:5173` for local development
- The GitHub client ID (`Ov23liThtdK2nvPctNXU`) is already public and shared with the dashboard
