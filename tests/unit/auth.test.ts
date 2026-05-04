import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
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
