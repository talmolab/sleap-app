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

/**
 * PKCS8 DER prefix for Ed25519 private keys.
 * Structure: SEQUENCE { INTEGER(0), SEQUENCE { OID(1.3.101.112) }, OCTET STRING { OCTET STRING { key } } }
 * The 32-byte raw key seed is appended after this prefix.
 */
const ED25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
  0x04, 0x22, 0x04, 0x20,
]);

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
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]);
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
  // Wrap raw 32-byte seed in PKCS8 DER envelope for Web Crypto import
  const pkcs8 = new Uint8Array(ED25519_PKCS8_PREFIX.length + raw.length);
  pkcs8.set(ED25519_PKCS8_PREFIX, 0);
  pkcs8.set(raw, ED25519_PKCS8_PREFIX.length);
  return crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    "Ed25519",
    false, // non-extractable
    ["sign"],
  );
}

// ── Nonce signing ────────────────────────────────────────────────

export async function signNonce(
  key: CryptoKey,
  nonce: string,
): Promise<string> {
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
