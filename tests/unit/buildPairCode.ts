/**
 * Test-only encoder for the one-line pairing code format (PR6a §a.1,
 * mirrors sleap_rtc/protocol_v1/pair_code.py). `src/lib/protocolV1/pairCode.ts`
 * only ever DECODES a code (this app never mints one), so there's no
 * production encoder to reuse — this lets connectStore/PairWorkerForm tests
 * build a real, checksum-valid code to feed through `pairWithTicket` instead
 * of only exercising the pasted-JSON-ticket path.
 */

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A deterministic 32-byte array, filled with `seed, seed+1, ...` mod 256 — good enough for a fake node id. */
export function fakeBytes(length: number, seed = 1): Uint8Array {
  return new Uint8Array(Array.from({ length }, (_, i) => (seed + i) % 256));
}

export interface PairCodeAddr {
  ip: [number, number, number, number];
  port: number;
}

export interface PairCodeOptions {
  nodeId: Uint8Array; // exactly 32 bytes
  secret: Uint8Array; // exactly 16 bytes
  expiresAt: number; // Unix seconds
  addrs?: PairCodeAddr[];
  /** A known `RELAY_TABLE` index (1-based, matching the wire tag), a custom URL, or omitted for no relay. */
  relay?: { index: number } | { url: string };
  /** Format version byte — default 1 (the only version `decodePairCode` accepts); override to build a code an unsupported-version test expects to be rejected. */
  version?: number;
}

/**
 * Corrupts a valid pairing code's checksum for an "incomplete or mistyped"
 * test, by flipping one base32 character near the START of the encoded body
 * (right after the `sleap1` prefix). NOT the last character: base32 packs 5
 * bits/char over a byte stream, so a body whose bit-length isn't a multiple
 * of 5 ends in up to 4 zero PADDING bits — depending on the exact digest
 * bytes, flipping the last character can land entirely in that padding and
 * decode to the exact same bytes, silently failing to corrupt anything. A
 * character this far from the end is always well within real data for any
 * code this format produces.
 */
export function mistypeCode(code: string): string {
  const idx = CODE_PREFIX_LEN + 3;
  const replacement = code[idx] === "a" ? "b" : "a";
  return code.slice(0, idx) + replacement + code.slice(idx + 1);
}
const CODE_PREFIX_LEN = "sleap1".length;

/** Builds a real, checksum-valid `sleap1...` pairing code for test fixtures. */
export async function buildPairCode(opts: PairCodeOptions): Promise<string> {
  const parts: number[] = [opts.version ?? 1];
  parts.push(...opts.nodeId);
  parts.push(...opts.secret);
  const expiresAtBytes = new Uint8Array(4);
  new DataView(expiresAtBytes.buffer).setUint32(0, opts.expiresAt, false);
  parts.push(...expiresAtBytes);

  const addrs = opts.addrs ?? [];
  parts.push(addrs.length);
  for (const addr of addrs) {
    parts.push(4, ...addr.ip, (addr.port >> 8) & 0xff, addr.port & 0xff);
  }

  if (!opts.relay) {
    parts.push(0);
  } else if ("index" in opts.relay) {
    parts.push(opts.relay.index);
  } else {
    const urlBytes = Array.from(new TextEncoder().encode(opts.relay.url));
    parts.push(255, urlBytes.length, ...urlBytes);
  }

  const body = new Uint8Array(parts);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body as BufferSource));
  const full = new Uint8Array(body.length + 2);
  full.set(body, 0);
  full.set(digest.subarray(0, 2), body.length);
  return "sleap1" + base32Encode(full);
}
