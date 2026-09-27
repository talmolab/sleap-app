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

// ── IndexedDB storage of the raw CryptoKeyPair ──────────────────────

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

async function loadStoredKeyPair(): Promise<CryptoKeyPair | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(KEY_ID);
    request.onsuccess = () => {
      db.close();
      resolve((request.result as CryptoKeyPair) ?? null);
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

async function storeKeyPair(pair: CryptoKeyPair): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(pair, KEY_ID);
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

/**
 * Load this device's persistent protocol-v1 identity, generating one on
 * first call. Memoized in-process — the private `CryptoKey` never leaves
 * this module; callers only ever see `nodeId` and `sign()`.
 */
export async function getClientIdentity(): Promise<ClientIdentity> {
  if (_cached) return _cached;

  let pair = await loadStoredKeyPair();
  if (!pair) {
    pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
    await storeKeyPair(pair);
  }

  const rawPublicKey = await crypto.subtle.exportKey("raw", pair.publicKey);
  const nodeId = bytesToB64(new Uint8Array(rawPublicKey));
  const privateKey = pair.privateKey;

  _cached = {
    nodeId,
    async sign(nonce: string): Promise<string> {
      const data = new TextEncoder().encode(nonce);
      const signature = await crypto.subtle.sign("Ed25519", privateKey, data);
      return bytesToB64(new Uint8Array(signature));
    },
  };
  return _cached;
}

/** Drops the in-memory cache — for tests only; does not touch IndexedDB. */
export function _resetClientIdentityCache(): void {
  _cached = null;
}
