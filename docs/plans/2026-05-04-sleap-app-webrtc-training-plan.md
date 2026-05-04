# sleap-app WebRTC Remote Training Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable sleap-app to run remote training jobs over direct WebRTC P2P connections with Ed25519 authentication, relay as fallback, and a transport mode indicator.

**Architecture:** Browser's native `RTCPeerConnection` establishes P2P data channels to workers. After channel open, Ed25519 challenge-response auth completes before any commands are sent. The existing text protocol (`TYPE::arg1::arg2`) carries job submission and progress. Private keys are stored as non-extractable `CryptoKey` objects in IndexedDB via Web Crypto API.

**Tech Stack:** TypeScript, Web Crypto API (Ed25519), IndexedDB, Zustand, Vitest, React (shadcn/ui)

**Design doc:** `docs/plans/2026-05-04-sleap-app-webrtc-training-design.md`

---

## Task 1: Protocol Constants — Add Auth and JOB_LOG Message Types

**Files:**
- Modify: `src/lib/sleapConnect.ts:10-29`
- Test: `tests/unit/sleapConnect.test.ts`

**Context:** The worker sends `AUTH_CHALLENGE`, `AUTH_SUCCESS`, `AUTH_FAILURE`, and `JOB_LOG` messages over the data channel. sleap-app needs matching constants to parse them.

**Step 1: Write the failing test**

Add to `tests/unit/sleapConnect.test.ts`:

```typescript
import {
  MSG_JOB_LOG,
  MSG_AUTH_CHALLENGE,
  MSG_AUTH_RESPONSE,
  MSG_AUTH_SUCCESS,
  MSG_AUTH_FAILURE,
} from "@/lib/sleapConnect";

describe("auth and log protocol constants", () => {
  it("exports MSG_JOB_LOG", () => {
    expect(MSG_JOB_LOG).toBe("JOB_LOG");
  });

  it("exports MSG_AUTH_CHALLENGE", () => {
    expect(MSG_AUTH_CHALLENGE).toBe("AUTH_CHALLENGE");
  });

  it("exports MSG_AUTH_RESPONSE", () => {
    expect(MSG_AUTH_RESPONSE).toBe("AUTH_RESPONSE");
  });

  it("exports MSG_AUTH_SUCCESS", () => {
    expect(MSG_AUTH_SUCCESS).toBe("AUTH_SUCCESS");
  });

  it("exports MSG_AUTH_FAILURE", () => {
    expect(MSG_AUTH_FAILURE).toBe("AUTH_FAILURE");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/unit/sleapConnect.test.ts`
Expected: FAIL — imports do not exist yet

**Step 3: Write minimal implementation**

Add to `src/lib/sleapConnect.ts` after the existing job message constants (after line 22):

```typescript
// Job log messages
export const MSG_JOB_LOG = "JOB_LOG";

// P2P auth messages (Ed25519 challenge-response)
export const MSG_AUTH_CHALLENGE = "AUTH_CHALLENGE";
export const MSG_AUTH_RESPONSE = "AUTH_RESPONSE";
export const MSG_AUTH_SUCCESS = "AUTH_SUCCESS";
export const MSG_AUTH_FAILURE = "AUTH_FAILURE";
```

Also add `privateKey` to the `Credentials` interface:

```typescript
export interface Credentials {
  jwt: string;
  username: string;
  avatarUrl?: string;
  defaultRoom?: string;
  accountKey?: string;
  privateKey?: string; // Ed25519 private key (URL-safe base64, raw 32 bytes)
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --run tests/unit/sleapConnect.test.ts`
Expected: PASS — all tests pass including existing ones

**Step 5: Commit**

```bash
git add src/lib/sleapConnect.ts tests/unit/sleapConnect.test.ts
git commit -m "feat: add auth and JOB_LOG protocol constants, privateKey to Credentials"
```

---

## Task 2: Ed25519 Auth Module — Key Import, Signing, and IndexedDB Storage

**Files:**
- Create: `src/lib/auth.ts`
- Create: `tests/unit/auth.test.ts`

**Context:** The P2P auth flow requires: (1) importing a raw Ed25519 private key as a non-extractable `CryptoKey`, (2) signing a nonce with it, (3) persisting the `CryptoKey` in IndexedDB so it survives page reloads. The Python worker uses `Ed25519PrivateKey.sign(nonce.encode())` from the `cryptography` library — the JS side must produce identical signatures. The key is 32 raw bytes, URL-safe base64 encoded (no padding), matching `sleap_rtc/auth/keypair.py`.

**Reference:** `src/lib/e2e.ts` for the existing pattern of using Web Crypto API + base64 helpers in this project.

**Step 1: Write the failing tests**

Create `tests/unit/auth.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import {
  validateKeyB64,
  importPrivateKey,
  signNonce,
  storeSigningKey,
  loadSigningKey,
  clearSigningKey,
} from "@/lib/auth";

// Test vector: 32 bytes of zeros, URL-safe base64 (no padding)
const VALID_KEY_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
// 31 bytes — wrong length
const SHORT_KEY_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
// 33 bytes — wrong length
const LONG_KEY_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("auth", () => {
  describe("validateKeyB64", () => {
    it("accepts valid 32-byte URL-safe base64 key", () => {
      expect(validateKeyB64(VALID_KEY_B64)).toBe(true);
    });

    it("rejects key with wrong length (too short)", () => {
      expect(validateKeyB64(SHORT_KEY_B64)).toBe(false);
    });

    it("rejects key with wrong length (too long)", () => {
      expect(validateKeyB64(LONG_KEY_B64)).toBe(false);
    });

    it("rejects empty string", () => {
      expect(validateKeyB64("")).toBe(false);
    });

    it("rejects non-base64 string", () => {
      expect(validateKeyB64("not!valid@base64")).toBe(false);
    });
  });

  describe("importPrivateKey", () => {
    it("imports a valid key and returns a CryptoKey", async () => {
      const key = await importPrivateKey(VALID_KEY_B64);
      expect(key).toBeDefined();
      expect(key.type).toBe("private");
      expect(key.extractable).toBe(false);
    });

    it("throws on invalid base64", async () => {
      await expect(importPrivateKey("not-valid")).rejects.toThrow();
    });
  });

  describe("signNonce", () => {
    it("returns a non-empty URL-safe base64 string", async () => {
      const key = await importPrivateKey(VALID_KEY_B64);
      const signature = await signNonce(key, "test-nonce-abc123");
      expect(signature.length).toBeGreaterThan(0);
      // URL-safe base64: only [A-Za-z0-9_-]
      expect(signature).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it("produces different signatures for different nonces", async () => {
      const key = await importPrivateKey(VALID_KEY_B64);
      const sig1 = await signNonce(key, "nonce-1");
      const sig2 = await signNonce(key, "nonce-2");
      expect(sig1).not.toBe(sig2);
    });

    it("produces consistent signatures for same nonce", async () => {
      const key = await importPrivateKey(VALID_KEY_B64);
      const sig1 = await signNonce(key, "same-nonce");
      const sig2 = await signNonce(key, "same-nonce");
      expect(sig1).toBe(sig2);
    });
  });

  describe("IndexedDB storage", () => {
    beforeEach(async () => {
      await clearSigningKey();
    });

    it("returns null when no key stored", async () => {
      const key = await loadSigningKey();
      expect(key).toBeNull();
    });

    it("round-trips a CryptoKey through store/load", async () => {
      const original = await importPrivateKey(VALID_KEY_B64);
      await storeSigningKey(original);
      const loaded = await loadSigningKey();
      expect(loaded).not.toBeNull();
      expect(loaded!.type).toBe("private");

      // Verify loaded key produces same signature as original
      const sig1 = await signNonce(original, "roundtrip-nonce");
      const sig2 = await signNonce(loaded!, "roundtrip-nonce");
      expect(sig1).toBe(sig2);
    });

    it("clearSigningKey removes stored key", async () => {
      const key = await importPrivateKey(VALID_KEY_B64);
      await storeSigningKey(key);
      await clearSigningKey();
      const loaded = await loadSigningKey();
      expect(loaded).toBeNull();
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/unit/auth.test.ts`
Expected: FAIL — module `@/lib/auth` does not exist

**Step 3: Write minimal implementation**

Create `src/lib/auth.ts`:

```typescript
/**
 * Ed25519 P2P authentication utilities.
 *
 * Provides key import, nonce signing, and IndexedDB storage for the
 * challenge-response auth protocol used with sleap-rtc workers.
 *
 * Key format: 32 raw bytes, URL-safe base64 (no padding).
 * Matches sleap_rtc/auth/keypair.py — sign_nonce(private_key, nonce)
 * signs nonce.encode("utf-8") with Ed25519.
 */

const DB_NAME = "sleap-app-auth";
const DB_VERSION = 1;
const STORE_NAME = "keys";
const KEY_ID = "signing-key";

// ── Base64 helpers (URL-safe, no padding) ────────────────────────

function b64ToBytes(b64: string): Uint8Array {
  let std = b64.replace(/-/g, "+").replace(/_/g, "/");
  while (std.length % 4) std += "=";
  const binary = atob(std);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ── Key validation ───────────────────────────────────────────────

export function validateKeyB64(b64: string): boolean {
  if (!b64 || b64.length === 0) return false;
  try {
    const bytes = b64ToBytes(b64);
    return bytes.length === 32;
  } catch {
    return false;
  }
}

// ── Key import ───────────────────────────────────────────────────

export async function importPrivateKey(b64: string): Promise<CryptoKey> {
  const raw = b64ToBytes(b64);
  if (raw.length !== 32) {
    throw new Error(`Invalid Ed25519 key: expected 32 bytes, got ${raw.length}`);
  }
  return crypto.subtle.importKey(
    "raw",
    raw,
    "Ed25519",
    false, // non-extractable
    ["sign"],
  );
}

// ── Nonce signing ────────────────────────────────────────────────

export async function signNonce(key: CryptoKey, nonce: string): Promise<string> {
  const data = new TextEncoder().encode(nonce);
  const signature = await crypto.subtle.sign("Ed25519", key, data);
  return bytesToB64(new Uint8Array(signature));
}

// ── IndexedDB storage ────────────────────────────────────────────

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function storeSigningKey(key: CryptoKey): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(key, KEY_ID);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function loadSigningKey(): Promise<CryptoKey | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(KEY_ID);
    request.onsuccess = () => {
      db.close();
      resolve((request.result as CryptoKey) ?? null);
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

export async function clearSigningKey(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(KEY_ID);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --run tests/unit/auth.test.ts`
Expected: PASS

**Note:** If `Ed25519` is not recognized by the test environment's `crypto.subtle` (jsdom/Node), you may need to check the Node version. Node 20+ supports Ed25519 in Web Crypto. If tests fail with "Algorithm not supported", the test runner may need `--experimental-vm-modules` or a polyfill. Check with `node -e "crypto.subtle.importKey('raw', new Uint8Array(32), 'Ed25519', false, ['sign']).then(() => console.log('OK')).catch(e => console.log(e.message))"` first.

**Step 5: Commit**

```bash
git add src/lib/auth.ts tests/unit/auth.test.ts
git commit -m "feat: add Ed25519 auth module with IndexedDB key storage"
```

---

## Task 3: Connect Store — Auth Handshake, JOB_LOG Handler, and Role Change

**Files:**
- Modify: `src/stores/connectStore.ts`
- Modify: `tests/unit/connectStore.test.ts`

**Context:** Three changes to connectStore:
1. Change `role: "client"` to `role: "app"` in register + offer messages (triggers worker auth)
2. Add Ed25519 auth handshake between data channel open and `finalize()`
3. Add `JOB_LOG` case to `_handleDataChannelMessage`
4. Update `loadCredentialsFromDisk` to read `private_key`

**Step 1: Write the failing tests**

Add to `tests/unit/connectStore.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { useConnectStore } from "@/stores/connectStore";
import {
  MSG_AUTH_CHALLENGE,
  MSG_AUTH_SUCCESS,
  MSG_AUTH_FAILURE,
  MSG_SEPARATOR,
} from "@/lib/sleapConnect";

// Reset helper (already exists in the file, extend if needed)

describe("_handleDataChannelMessage — JOB_LOG", () => {
  beforeEach(() => {
    useConnectStore.setState({
      credentials: null,
      connectionStatus: "disconnected",
      connectionError: null,
      roomId: null,
      workers: [],
      selectedWorkerId: null,
      _ws: null,
      _pc: null,
      _transport: null,
      _pendingFs: new Map(),
      _pendingJobs: new Map(),
    });
  });

  it("strips JOB_LOG prefix and routes text to pending job by ID", () => {
    const lines: string[] = [];
    const pendingJobs = new Map();
    pendingJobs.set("job_abc", {
      onProgress: (line: string) => lines.push(line),
      onComplete: () => {},
      remainingCompletions: 1,
    });
    useConnectStore.setState({ _pendingJobs: pendingJobs });

    useConnectStore.getState()._handleDataChannelMessage("JOB_LOG::job_abc::Training epoch 1");
    expect(lines).toEqual(["Training epoch 1"]);
  });

  it("handles JOB_LOG with :: in the text body", () => {
    const lines: string[] = [];
    const pendingJobs = new Map();
    pendingJobs.set("job_abc", {
      onProgress: (line: string) => lines.push(line),
      onComplete: () => {},
      remainingCompletions: 1,
    });
    useConnectStore.setState({ _pendingJobs: pendingJobs });

    useConnectStore.getState()._handleDataChannelMessage("JOB_LOG::job_abc::loss: 0.5 :: val: 0.3");
    expect(lines).toEqual(["loss: 0.5 :: val: 0.3"]);
  });

  it("ignores JOB_LOG for unknown job ID", () => {
    const lines: string[] = [];
    const pendingJobs = new Map();
    pendingJobs.set("job_abc", {
      onProgress: (line: string) => lines.push(line),
      onComplete: () => {},
      remainingCompletions: 1,
    });
    useConnectStore.setState({ _pendingJobs: pendingJobs });

    useConnectStore.getState()._handleDataChannelMessage("JOB_LOG::job_xyz::Unknown job");
    expect(lines).toEqual([]);
  });
});

describe("_handleDataChannelMessage — AUTH messages are not forwarded to jobs", () => {
  it("does not forward AUTH_CHALLENGE to pending jobs", () => {
    const lines: string[] = [];
    const pendingJobs = new Map();
    pendingJobs.set("job_abc", {
      onProgress: (line: string) => lines.push(line),
      onComplete: () => {},
      remainingCompletions: 1,
    });
    useConnectStore.setState({ _pendingJobs: pendingJobs });

    useConnectStore.getState()._handleDataChannelMessage("AUTH_CHALLENGE::test-nonce");
    expect(lines).toEqual([]);
  });

  it("does not forward AUTH_SUCCESS to pending jobs", () => {
    const lines: string[] = [];
    const pendingJobs = new Map();
    pendingJobs.set("job_abc", {
      onProgress: (line: string) => lines.push(line),
      onComplete: () => {},
      remainingCompletions: 1,
    });
    useConnectStore.setState({ _pendingJobs: pendingJobs });

    useConnectStore.getState()._handleDataChannelMessage("AUTH_SUCCESS");
    expect(lines).toEqual([]);
  });

  it("does not forward AUTH_FAILURE to pending jobs", () => {
    const lines: string[] = [];
    const pendingJobs = new Map();
    pendingJobs.set("job_abc", {
      onProgress: (line: string) => lines.push(line),
      onComplete: () => {},
      remainingCompletions: 1,
    });
    useConnectStore.setState({ _pendingJobs: pendingJobs });

    useConnectStore.getState()._handleDataChannelMessage("AUTH_FAILURE::invalid");
    expect(lines).toEqual([]);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- --run tests/unit/connectStore.test.ts`
Expected: FAIL — JOB_LOG falls through to default, AUTH messages forwarded to jobs

**Step 3: Implement changes**

**3a. Add imports** at top of `src/stores/connectStore.ts` (around line 10-29):

Add `MSG_JOB_LOG`, `MSG_AUTH_CHALLENGE`, `MSG_AUTH_RESPONSE`, `MSG_AUTH_SUCCESS`, `MSG_AUTH_FAILURE` to the import from `@/lib/sleapConnect`.

**3b. Change role from "client" to "app"** in two places:

In `connect()` method (~line 241), change the register message:
```typescript
role: "app",  // was "client"
```

In `connectToWorker()` method (~line 404), change the SDP offer:
```typescript
role: "app",  // was "client"
```

**3c. Add auth handshake** in `connectToWorker()`. Replace the `dc.onopen` block (~line 363-366):

```typescript
dc.onopen = async () => {
  console.log("[connect] Data channel open → starting auth handshake");
  const transport = new WebRTCTransport(dc);

  // Auth handshake: wait for AUTH_CHALLENGE, sign with Ed25519, await AUTH_SUCCESS
  try {
    await new Promise<void>((resolve, reject) => {
      const authTimeout = setTimeout(() => {
        // No challenge received — assume older worker without auth, proceed
        console.warn("[connect] No AUTH_CHALLENGE after 10s — proceeding without auth");
        resolve();
      }, 10000);

      transport.onMessage((data) => {
        const parts = data.split("::");
        const msgType = parts[0];

        if (msgType === MSG_AUTH_CHALLENGE) {
          clearTimeout(authTimeout);
          const nonce = parts.slice(1).join("::");
          console.log("[connect] Received AUTH_CHALLENGE, signing nonce");

          (async () => {
            try {
              const { loadSigningKey, signNonce } = await import("@/lib/auth");
              const key = await loadSigningKey();
              if (!key) {
                reject(new Error("No signing key available"));
                return;
              }
              const signature = await signNonce(key, nonce);
              transport.send(`${MSG_AUTH_RESPONSE}::${signature}`);
            } catch (err) {
              reject(err);
            }
          })();
        } else if (msgType === MSG_AUTH_SUCCESS) {
          clearTimeout(authTimeout);
          console.log("[connect] AUTH_SUCCESS — authenticated");
          resolve();
        } else if (msgType === MSG_AUTH_FAILURE) {
          clearTimeout(authTimeout);
          const reason = parts.slice(1).join("::");
          console.error("[connect] AUTH_FAILURE:", reason);
          reject(new Error(`Authentication failed: ${reason}`));
        }
      });
    });

    finalize(transport, "direct");
  } catch (err) {
    console.error("[connect] Auth handshake failed:", err);
    transport.close();
    set({
      connectionStatus: "error",
      connectionError: err instanceof Error ? err.message : "Auth failed",
    });
  }
};
```

**3d. Add JOB_LOG and AUTH cases** to `_handleDataChannelMessage` (~line 617 switch block).

Add before the `default` case:

```typescript
case MSG_JOB_LOG: {
  // Worker sends: JOB_LOG::{job_id}::{text}
  const logJobId = parts[1];
  const text = parts.slice(2).join(MSG_SEPARATOR);
  const { _pendingJobs: logJobs } = get();
  const pending = logJobs.get(logJobId);
  if (pending) {
    pending.onProgress(text);
  }
  break;
}

case MSG_AUTH_CHALLENGE:
case MSG_AUTH_SUCCESS:
case MSG_AUTH_FAILURE:
  // Auth messages are handled during the handshake in connectToWorker.
  // If they arrive here, the handshake is already complete — ignore.
  break;
```

**3e. Update `loadCredentialsFromDisk`** (~line 138-165). Add `privateKey` to the set() call:

```typescript
set({
  credentials: {
    jwt: data.jwt,
    username: data.user.username,
    avatarUrl: data.user.avatar_url,
    defaultRoom: data.default_room,
    accountKey: data.account_key,
    privateKey: data.private_key,  // Ed25519 private key for P2P auth
  },
});
```

Also, after setting credentials, auto-import the private key into IndexedDB for Tauri:

```typescript
// Auto-import private key into IndexedDB for auth
if (data.private_key) {
  try {
    const { importPrivateKey, storeSigningKey } = await import("@/lib/auth");
    const cryptoKey = await importPrivateKey(data.private_key);
    await storeSigningKey(cryptoKey);
    console.log("[connect] Private key imported into IndexedDB");
  } catch (err) {
    console.warn("[connect] Failed to import private key:", err);
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npm test -- --run tests/unit/connectStore.test.ts`
Expected: PASS

Also run the full test suite:

Run: `npm test -- --run`
Expected: All existing tests still pass

**Step 5: Commit**

```bash
git add src/stores/connectStore.ts tests/unit/connectStore.test.ts
git commit -m "feat: add auth handshake, JOB_LOG handler, role: app in connectStore"
```

---

## Task 4: Connect Panel — Credentials Import UI

**Files:**
- Modify: `src/components/panels/ConnectPanel.tsx`

**Context:** Browser users need a way to import their Ed25519 private key (from `~/.sleap-rtc/credentials.json`). This is a one-time setup step. The Connect button to workers should be disabled if no signing key exists in IndexedDB. For Tauri, the key is auto-imported from disk — no UI needed.

**Step 1: Add key state and import handler**

Add state hooks and an import section to `ConnectPanel.tsx`. After the existing state hooks (~line 48-66), add:

```typescript
const [hasSigningKey, setHasSigningKey] = useState<boolean | null>(null);
const [keyImportValue, setKeyImportValue] = useState("");
const [keyImportError, setKeyImportError] = useState<string | null>(null);
const [showKeyImport, setShowKeyImport] = useState(false);
const transportMode = useConnectStore((s) => s.transportMode);
```

Add a `useEffect` to check for existing key on mount (~after line 73):

```typescript
useEffect(() => {
  (async () => {
    try {
      const { loadSigningKey } = await import("@/lib/auth");
      const key = await loadSigningKey();
      setHasSigningKey(key !== null);
    } catch {
      setHasSigningKey(false);
    }
  })();
}, []);
```

Add the import handler function:

```typescript
const handleKeyImport = async () => {
  setKeyImportError(null);
  try {
    const { validateKeyB64, importPrivateKey, storeSigningKey } = await import("@/lib/auth");
    if (!validateKeyB64(keyImportValue.trim())) {
      setKeyImportError("Invalid key: must be 32 bytes, URL-safe base64 encoded");
      return;
    }
    const cryptoKey = await importPrivateKey(keyImportValue.trim());
    await storeSigningKey(cryptoKey);
    setHasSigningKey(true);
    setKeyImportValue("");
    setShowKeyImport(false);
  } catch (err) {
    setKeyImportError(err instanceof Error ? err.message : "Failed to import key");
  }
};
```

**Step 2: Add credentials import UI section**

In the logged-in section, after the room selector and before the Connect button (~line 282-291), add a credentials section for browser users:

```tsx
{/* Private key import (browser only) */}
{!isTauri && hasSigningKey === false && (
  <div className="bg-yellow-500/8 border border-yellow-500/20 rounded-md p-2 space-y-1.5">
    <p className="text-[11px] text-yellow-400">
      <b>Setup required:</b> Import your Ed25519 private key to connect to workers.
    </p>
    {!showKeyImport ? (
      <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => setShowKeyImport(true)}>
        Import Private Key
      </Button>
    ) : (
      <div className="space-y-1.5">
        <p className="text-[10px] text-muted-foreground">
          Paste the <code className="bg-black/30 px-1 py-0.5 rounded text-[10px] font-mono">private_key</code> value from your <code className="bg-black/30 px-1 py-0.5 rounded text-[10px] font-mono">~/.sleap-rtc/credentials.json</code>
        </p>
        <input
          type="password"
          value={keyImportValue}
          onChange={(e) => setKeyImportValue(e.target.value)}
          placeholder="Paste private key (base64)"
          className="w-full h-7 px-2 text-xs bg-zinc-900 border border-border rounded-md font-mono"
        />
        <div className="flex gap-1">
          <Button size="sm" className="h-6 text-[10px]" onClick={handleKeyImport} disabled={!keyImportValue.trim()}>
            Save
          </Button>
          <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => { setShowKeyImport(false); setKeyImportError(null); }}>
            Cancel
          </Button>
        </div>
        {keyImportError && (
          <p className="text-[10px] text-red-400">{keyImportError}</p>
        )}
      </div>
    )}
  </div>
)}
{!isTauri && hasSigningKey === true && (
  <div className="flex items-center gap-1 text-[10px] text-green-400 py-0.5">
    <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
    Signing key imported
  </div>
)}
```

**Step 3: Disable worker connect button without signing key**

In the worker card button (~line 367-378), add a disabled condition:

```tsx
<Button
  size="sm"
  className="w-full mt-2 h-7 text-xs"
  disabled={!isTauri && !hasSigningKey}
  onClick={(e) => {
    e.stopPropagation();
    setExpandedWorkerId(null);
    connectToWorker(w.peerId);
  }}
>
  {!isTauri && !hasSigningKey ? "Import key to connect" : `Connect to ${w.name}`}
</Button>
```

**Step 4: Add transport mode badge**

In the connected status section (~line 310-323), add the transport mode badge after "Connected to ...":

```tsx
<div className="flex items-center gap-1.5 py-1">
  <span className="w-2 h-2 rounded-full bg-green-500" />
  <span className="text-xs">
    Connected to <b>{availableRooms.find((r) => r.roomId === roomId)?.name || roomId}</b>
  </span>
  {transportMode && (
    <span
      className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${
        transportMode === "direct"
          ? "bg-green-500/15 text-green-400"
          : "bg-yellow-500/15 text-yellow-400"
      }`}
      title={transportMode === "direct" ? "Connected peer-to-peer via WebRTC" : "Connected via relay server (WebRTC unavailable)"}
    >
      {transportMode === "direct" ? "Direct" : "Relay"}
    </span>
  )}
  <Button
    variant="ghost"
    size="xs"
    className="ml-auto"
    onClick={disconnect}
  >
    <Unplug className="h-3 w-3" />
  </Button>
</div>
```

**Step 5: Test visually**

Run: `npm run dev`
Open: `http://localhost:5173`

Verify:
- Not logged in → normal login flow
- Logged in (browser, no key) → yellow "Setup required" box appears, Connect to worker button disabled
- Import valid key → green "Signing key imported" indicator, Connect button enabled
- Import invalid key → red error message
- Connected → "Direct" or "Relay" badge shows next to room name

**Step 6: Commit**

```bash
git add src/components/panels/ConnectPanel.tsx
git commit -m "feat: add private key import UI and transport mode badge to ConnectPanel"
```

---

## Task 5: Integration Testing and Verification

**Files:**
- All modified files from Tasks 1-4

**Step 1: Run full test suite**

Run: `npm test -- --run`
Expected: All tests pass

**Step 2: Run lint**

Run: `npm run lint`
Expected: No errors

**Step 3: Run type check + build**

Run: `npm run build`
Expected: Clean build with no type errors

**Step 4: Visual testing in browser**

Run: `npm run dev`

Test the following scenarios:
1. **No credentials:** Login page shows normally
2. **Browser with credentials, no key:** Key import UI visible, connect button disabled
3. **Import key:** Paste a valid 32-byte base64 key, verify it saves, green indicator appears
4. **Connect to room:** Room selector and connect works as before
5. **Worker list:** Workers appear with status dots
6. **Transport badge:** After connecting to worker, "Direct" or "Relay" badge shows

**Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: address integration test findings"
```

**Step 6: Push branch**

```bash
git push -u origin amick/webrtc-rs-implementation
```
