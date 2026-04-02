/**
 * E2E encryption for relay transport.
 *
 * Provides ECDH P-256 key exchange and AES-256-GCM message encryption so that
 * relay messages between sleap-app and workers are encrypted end-to-end.
 * The signaling server can route messages but cannot read payloads.
 *
 * Parameters (must match Python worker exactly):
 * - Curve: P-256 (secp256r1)
 * - KDF: HKDF-SHA256, no salt, info = "sleap-rtc-relay-e2e-v1"
 * - Cipher: AES-256-GCM, 12-byte nonce
 * - Public key format: uncompressed point (65 bytes), URL-safe base64 no padding
 */

// HKDF info string — must match Python side exactly.
const HKDF_INFO = new TextEncoder().encode("sleap-rtc-relay-e2e-v1");

/** Generate an ephemeral ECDH P-256 keypair. */
export async function generateKeypair(): Promise<{
  privateKey: CryptoKey;
  publicKeyRaw: ArrayBuffer;
}> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false, // private key not extractable
    ["deriveBits"],
  );
  const publicKeyRaw = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  return { privateKey: keyPair.privateKey, publicKeyRaw };
}

/**
 * Derive an AES-256-GCM key from ECDH shared secret + HKDF.
 * Both sides call this with the other's public key to get the same key.
 */
export async function deriveSharedKey(
  privateKey: CryptoKey,
  peerPublicKeyRaw: ArrayBuffer,
): Promise<CryptoKey> {
  const peerPublicKey = await crypto.subtle.importKey(
    "raw",
    peerPublicKeyRaw,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );

  // ECDH → shared secret
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: peerPublicKey },
    privateKey,
    256,
  );

  // Import as HKDF key material
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    sharedBits,
    "HKDF",
    false,
    ["deriveKey"],
  );

  // HKDF → AES-256-GCM key
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: HKDF_INFO,
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt a JSON payload with AES-256-GCM. */
export async function encrypt(
  key: CryptoKey,
  payload: Record<string, unknown>,
): Promise<{ nonce: string; ciphertext: string }> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plaintext),
  );
  return {
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(ciphertext),
  };
}

/** Decrypt an AES-256-GCM ciphertext back to a JSON object. */
export async function decrypt(
  key: CryptoKey,
  nonceB64: string,
  ciphertextB64: string,
): Promise<Record<string, unknown> | null> {
  try {
    const nonce = base64ToBytes(nonceB64);
    const ct = base64ToBytes(ciphertextB64);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      ct,
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch (e) {
    console.warn("[E2E] Decryption failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** Encode raw bytes as URL-safe base64 (no padding). */
export function publicKeyToB64(raw: ArrayBuffer): string {
  const bytes = new Uint8Array(raw);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Decode URL-safe base64 (no padding) to raw bytes. */
export function publicKeyFromB64(b64: string): ArrayBuffer {
  let std = b64.replace(/-/g, "+").replace(/_/g, "/");
  while (std.length % 4) std += "=";
  const binary = atob(std);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// ── Internal helpers ──────────────────────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
