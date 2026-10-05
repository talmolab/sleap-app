/**
 * Persistent Ed25519 client identity for protocol v1 pairing/auth.
 *
 * Per spec §3.1, the app generates a keypair on first run and keeps it
 * forever — this is a per-device identity, not per-account. Encoding
 * matches `sleap_rtc.auth.keypair` / the worker-side `WorkerIdentity`
 * (`sleap_rtc/protocol_v1/identity.py`): `node_id` is the raw 32-byte
 * Ed25519 public key, URL-safe base64, no padding; signatures are encoded
 * the same way.
 *
 * Deliberately separate from `@/lib/auth`, which holds the *legacy*
 * account-issued P2P key (imported from a server-side `credentials.json`)
 * used by today's `::`-string challenge-response protocol.
 */

const DB_NAME = "sleap-app-protocol-v1";
const DB_VERSION = 1;
const STORE_NAME = "identity";
const KEY_ID = "client-identity";

export interface ClientIdentity {
  /** This device's public identity — URL-safe base64 Ed25519 public key. */
  readonly nodeId: string;
  /** Sign a nonce (e.g. the worker's `hello.nonce`) with this identity. */
  sign(nonce: string): Promise<string>;
}

// ── base64 helpers (URL-safe, no padding) — matches sleap_rtc.auth.keypair ──

function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── IndexedDB storage of the key's raw bytes ────────────────────────
//
// The key is stored as plain bytes (PKCS#8 private key + raw public key),
// NOT as `CryptoKey` objects. WebKit (Safari, Tauri's macOS WebView)
// encrypts any `CryptoKey` written to IndexedDB with a "WebCrypto Master
// Key" kept in the macOS keychain, so every read asked for the keychain
// password, and again after each rebuild or update of an unsigned app
// (the keychain's "Always Allow" is tied to the app's code signature).
// Plain bytes keep the key protected the way the worker's own key file
// is: by the app's data directory, not the keychain.

/** What's stored under `KEY_ID`. */
interface StoredIdentity {
  v: 2;
  /** PKCS#8 Ed25519 private key. */
  pkcs8: ArrayBuffer;
  /** Raw 32-byte Ed25519 public key. */
  publicRaw: ArrayBuffer;
}

// Tag check, not `instanceof`: a structured-cloned buffer can come from
// another realm.
const isArrayBuffer = (v: unknown): v is ArrayBuffer =>
  Object.prototype.toString.call(v) === "[object ArrayBuffer]";

function isStoredIdentity(value: unknown): value is StoredIdentity {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { v?: unknown }).v === 2 &&
    isArrayBuffer((value as { pkcs8?: unknown }).pkcs8) &&
    isArrayBuffer((value as { publicRaw?: unknown }).publicRaw)
  );
}

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

/** The raw stored value: a `StoredIdentity`, a legacy `CryptoKeyPair` (pre-v2), or null. */
async function loadStoredValue(): Promise<unknown> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(KEY_ID);
    request.onsuccess = () => {
      db.close();
      resolve(request.result ?? null);
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

async function storeIdentity(stored: StoredIdentity): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(stored, KEY_ID);
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

/** Deletes the stored identity — for tests only; a real device keeps one forever. */
export async function clearClientIdentity(): Promise<void> {
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

let _cached: ClientIdentity | null = null;
// Concurrent first callers (several workers connecting at once) share one
// load, so the stored key is read once per launch.
let _pending: Promise<ClientIdentity> | null = null;

/** Exports an extractable key pair as the bytes stored under `KEY_ID`. */
async function toStoredIdentity(pair: CryptoKeyPair): Promise<StoredIdentity> {
  return {
    v: 2,
    pkcs8: await crypto.subtle.exportKey("pkcs8", pair.privateKey),
    publicRaw: await crypto.subtle.exportKey("raw", pair.publicKey),
  };
}

async function loadOrCreateIdentity(): Promise<ClientIdentity> {
  const value = await loadStoredValue();
  let stored: StoredIdentity;
  if (isStoredIdentity(value)) {
    stored = value;
  } else if (value && typeof value === "object" && "privateKey" in value) {
    // Legacy: a `CryptoKeyPair` stored before v2. Reading it needed the
    // keychain one last time; rewrite it as bytes so it never does again.
    // Same key, so existing pairings keep working.
    stored = await toStoredIdentity(value as CryptoKeyPair);
    await storeIdentity(stored);
  } else {
    const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
    stored = await toStoredIdentity(pair);
    await storeIdentity(stored);
  }

  // Non-extractable in memory: nothing in the app can read the key back out.
  const privateKey = await crypto.subtle.importKey("pkcs8", stored.pkcs8, "Ed25519", false, ["sign"]);
  const nodeId = bytesToB64(new Uint8Array(stored.publicRaw));

  return {
    nodeId,
    async sign(nonce: string): Promise<string> {
      const data = new TextEncoder().encode(nonce);
      const signature = await crypto.subtle.sign("Ed25519", privateKey, data);
      return bytesToB64(new Uint8Array(signature));
    },
  };
}

/**
 * Load this device's persistent protocol-v1 identity, generating one on
 * first call. Memoized in-process — the private `CryptoKey` never leaves
 * this module; callers only ever see `nodeId` and `sign()`.
 */
export async function getClientIdentity(): Promise<ClientIdentity> {
  if (_cached) return _cached;
  if (!_pending) {
    _pending = loadOrCreateIdentity()
      .then((identity) => {
        _cached = identity;
        return identity;
      })
      .finally(() => {
        _pending = null;
      });
  }
  return _pending;
}

/** Drops the in-memory cache — for tests only; does not touch IndexedDB. */
export function _resetClientIdentityCache(): void {
  _cached = null;
  _pending = null;
}
