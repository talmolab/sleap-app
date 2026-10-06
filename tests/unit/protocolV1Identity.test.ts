import { describe, it, expect, beforeEach } from "../bun-test";
import "fake-indexeddb/auto";
import {
  getClientIdentity,
  clearClientIdentity,
  _resetClientIdentityCache,
} from "@/lib/protocolV1/identity";

describe("protocolV1 identity", () => {
  beforeEach(async () => {
    _resetClientIdentityCache();
    await clearClientIdentity();
  });

  it("generates a node_id that looks like URL-safe base64", async () => {
    const identity = await getClientIdentity();
    expect(identity.nodeId.length).toBeGreaterThan(0);
    expect(identity.nodeId).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("decodes to exactly 32 raw bytes (a raw Ed25519 public key)", async () => {
    const identity = await getClientIdentity();
    let b64 = identity.nodeId.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect(bytes.length).toBe(32);
  });

  it("memoizes across calls within the same process (same node_id)", async () => {
    const a = await getClientIdentity();
    const b = await getClientIdentity();
    expect(b.nodeId).toBe(a.nodeId);
  });

  it("persists across a fresh in-memory cache (same IndexedDB-backed key)", async () => {
    const a = await getClientIdentity();
    _resetClientIdentityCache();
    const b = await getClientIdentity();
    expect(b.nodeId).toBe(a.nodeId);
  });

  it("generates a new identity after clearClientIdentity()", async () => {
    const a = await getClientIdentity();
    _resetClientIdentityCache();
    await clearClientIdentity();
    const b = await getClientIdentity();
    expect(b.nodeId).not.toBe(a.nodeId);
  });

  describe("sign", () => {
    it("returns a non-empty URL-safe base64 signature", async () => {
      const identity = await getClientIdentity();
      const sig = await identity.sign("some-nonce");
      expect(sig.length).toBeGreaterThan(0);
      expect(sig).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it("produces different signatures for different nonces", async () => {
      const identity = await getClientIdentity();
      const sig1 = await identity.sign("nonce-1");
      const sig2 = await identity.sign("nonce-2");
      expect(sig1).not.toBe(sig2);
    });

    it("produces a signature verifiable against the raw public key", async () => {
      const identity = await getClientIdentity();
      const sig = await identity.sign("verify-me");

      let b64 = identity.nodeId.replace(/-/g, "+").replace(/_/g, "/");
      while (b64.length % 4) b64 += "=";
      const rawPublicKey = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const publicKey = await crypto.subtle.importKey(
        "raw",
        rawPublicKey,
        "Ed25519",
        false,
        ["verify"],
      );

      let sigB64 = sig.replace(/-/g, "+").replace(/_/g, "/");
      while (sigB64.length % 4) sigB64 += "=";
      const sigBytes = Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0));

      const valid = await crypto.subtle.verify(
        "Ed25519",
        publicKey,
        sigBytes,
        new TextEncoder().encode("verify-me"),
      );
      expect(valid).toBe(true);
    });
  });
});

/** Reads/writes the identity record directly, bypassing identity.ts. */
function rawStore(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("sleap-app-protocol-v1", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("identity");
    open.onsuccess = () => {
      const db = open.result;
      const req = fn(db.transaction("identity", mode).objectStore("identity"));
      req.onsuccess = () => {
        db.close();
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
    };
    open.onerror = () => reject(open.error);
  });
}

describe("protocolV1 identity storage (no CryptoKey objects at rest)", () => {
  beforeEach(async () => {
    _resetClientIdentityCache();
    await clearClientIdentity();
  });

  it("stores the key as plain bytes, not CryptoKey objects", async () => {
    await getClientIdentity();
    const stored = (await rawStore("readonly", (s) => s.get("client-identity"))) as Record<string, unknown>;
    expect(stored.v).toBe(2);
    expect(Object.prototype.toString.call(stored.pkcs8)).toBe("[object ArrayBuffer]");
    expect(Object.prototype.toString.call(stored.publicRaw)).toBe("[object ArrayBuffer]");
    expect(Object.values(stored).some((v) => v instanceof CryptoKey)).toBe(false);
  });

  it("migrates a legacy stored CryptoKeyPair to bytes, keeping the same node_id", async () => {
    const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
    await rawStore("readwrite", (s) => s.put(pair, "client-identity"));
    const legacyRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));

    const identity = await getClientIdentity();
    let b64 = identity.nodeId.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    expect(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))).toEqual(legacyRaw);

    const stored = (await rawStore("readonly", (s) => s.get("client-identity"))) as Record<string, unknown>;
    expect(stored.v).toBe(2);
  });

  it("refuses to replace a stored record it can't read (never silently re-keys)", async () => {
    await rawStore("readwrite", (s) => s.put({ unreadable: true }, "client-identity"));
    await expect(getClientIdentity()).rejects.toThrow(/Couldn't read this device's saved pairing key/);
    const stored = (await rawStore("readonly", (s) => s.get("client-identity"))) as Record<string, unknown>;
    expect(stored).toEqual({ unreadable: true }); // untouched
  });

  it("concurrent first calls share one load (same identity object)", async () => {
    const [a, b, c] = await Promise.all([getClientIdentity(), getClientIdentity(), getClientIdentity()]);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });
});
