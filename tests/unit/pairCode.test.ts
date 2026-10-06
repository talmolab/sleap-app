/**
 * PR6a §a.1 — `pairCode.ts`'s decode side of the one-line pairing code
 * format (protocol spec §3.2). `tests/fixtures/pair_code_vectors.json` is a
 * byte-for-byte copy of sleap-connect's own
 * `tests/protocol_v1/pair_code_vectors.json` — the two suites assert
 * against the SAME fixture so a format drift between languages is always
 * caught.
 */
import { describe, it, expect } from "../bun-test";
import { decodePairCode, isPairCode, PairCodeError, RELAY_TABLE } from "@/lib/protocolV1/pairCode";

interface Vector {
  description: string;
  ticket: {
    node_id: string;
    secret: string;
    expires_at: number;
    addrs: string[];
    relay_url: string | null;
  };
  code: string;
}

const vectors = (await Bun.file("tests/fixtures/pair_code_vectors.json").json()) as Vector[];

describe("isPairCode", () => {
  it("is true for a sleap1-prefixed string, whitespace/case tolerant", () => {
    expect(isPairCode("sleap1abc")).toBe(true);
    expect(isPairCode("  SLEAP1abc\n")).toBe(true);
  });

  it("is false for a pasted JSON ticket", () => {
    expect(isPairCode('{"node_id": "abc"}')).toBe(false);
    expect(isPairCode("")).toBe(false);
  });
});

describe("decodePairCode — shared vectors", () => {
  for (const vector of vectors) {
    it(vector.description, async () => {
      const ticket = await decodePairCode(vector.code);
      expect(ticket.node_id).toBe(vector.ticket.node_id);
      expect(ticket.secret).toBe(vector.ticket.secret);
      expect(ticket.expires_at).toBe(vector.ticket.expires_at);
      expect(ticket.addrs).toEqual(vector.ticket.addrs);
      if (vector.ticket.relay_url) {
        expect(ticket.iroh).toEqual({
          node_id: vector.ticket.node_id,
          relay_url: vector.ticket.relay_url,
          direct_addrs: [],
        });
      } else {
        expect(ticket.iroh).toBeUndefined();
      }
    });
  }

  it("is case-insensitive and whitespace-tolerant", async () => {
    const vector = vectors[0]!;
    const noisy = `  ${vector.code.toUpperCase()}\n`;
    const ticket = await decodePairCode(noisy);
    expect(ticket.node_id).toBe(vector.ticket.node_id);
  });

  it("known relay indices resolve into RELAY_TABLE", async () => {
    const vector = vectors.find((v) => v.description.includes("known relay"))!;
    const ticket = await decodePairCode(vector.code);
    const relayUrl = ticket.iroh?.relay_url;
    expect(relayUrl).toBe(vector.ticket.relay_url ?? undefined);
    expect(RELAY_TABLE).toContain(relayUrl!);
  });
});

describe("decodePairCode — errors", () => {
  it("rejects a string with the wrong prefix", async () => {
    await expect(decodePairCode("notacode")).rejects.toThrow(PairCodeError);
    await expect(decodePairCode("notacode")).rejects.toThrow(/sleap-connect pairing code/);
  });

  it("rejects a truncated code", async () => {
    const short = "sleap1aeaqeayeaudaocajbi"; // valid prefix, far too short
    await expect(decodePairCode(short)).rejects.toThrow(PairCodeError);
    await expect(decodePairCode(short)).rejects.toThrow(/too short/);
  });

  it("rejects a mistyped code (bad checksum)", async () => {
    const vector = vectors[0]!;
    // Flip the last base32 character — corrupts the checksum without
    // changing the code's length.
    const lastChar = vector.code.at(-1)!;
    const flipped = lastChar === "a" ? "b" : "a";
    const mistyped = vector.code.slice(0, -1) + flipped;
    await expect(decodePairCode(mistyped)).rejects.toThrow(PairCodeError);
    await expect(decodePairCode(mistyped)).rejects.toThrow(/incomplete or mistyped/);
  });

  it("rejects an unsupported format version", async () => {
    const code = await buildMinimalCodeWithVersion(99);
    await expect(decodePairCode(code)).rejects.toThrow(PairCodeError);
    await expect(decodePairCode(code)).rejects.toThrow(/Unsupported pairing code version/);
  });
});

const TEST_BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** Local, test-only base32 encoder — `pairCode.ts` only ever decodes (this app never mints codes). */
function base32EncodeForTest(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += TEST_BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += TEST_BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * A minimal, well-formed (checksum-correct) pairing code — all-zero
 * node_id/secret/expires_at, no addrs, no relay — with `version` as its
 * format-version byte, for exercising the version check in isolation.
 */
async function buildMinimalCodeWithVersion(version: number): Promise<string> {
  const body = new Uint8Array(1 + 32 + 16 + 4 + 1 + 1);
  body[0] = version;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
  const full = new Uint8Array(body.length + 2);
  full.set(body, 0);
  full.set(digest.subarray(0, 2), body.length);
  return "sleap1" + base32EncodeForTest(full);
}
