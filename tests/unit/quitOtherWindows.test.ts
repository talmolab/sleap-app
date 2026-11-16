/**
 * Quit exits the whole desktop process, but each window holds its own project.
 * `confirmOtherWindows` walks the other windows so each one with unsaved work
 * gets its own prompt, instead of Quit from a clean window silently discarding
 * a dirty one.
 */
import { describe, it, expect } from "../bun-test";
import { confirmOtherWindows, type QuitPeers } from "@/lib/quit";

type Reply = { dirty: boolean; decision?: boolean } | null;

function fakePeers(replies: Record<string, Reply>): QuitPeers & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async otherWindows() {
      return Object.keys(replies);
    },
    async ask(label) {
      asked.push(label);
      const r = replies[label];
      if (!r) return null;
      return { dirty: r.dirty, decision: Promise.resolve(r.decision ?? true) };
    },
  };
}

describe("confirmOtherWindows", () => {
  it("quits when no other window has unsaved work", async () => {
    const peers = fakePeers({ b: { dirty: false }, c: { dirty: false } });
    expect(await confirmOtherWindows(peers)).toBe(true);
    expect(peers.asked).toEqual(["b", "c"]);
  });

  it("quits once every dirty window's user agrees", async () => {
    const peers = fakePeers({ b: { dirty: true, decision: true }, c: { dirty: false } });
    expect(await confirmOtherWindows(peers)).toBe(true);
  });

  it("stops at the first window whose user cancels, without asking the rest", async () => {
    const peers = fakePeers({
      b: { dirty: true, decision: false },
      c: { dirty: true, decision: true },
    });
    expect(await confirmOtherWindows(peers)).toBe(false);
    expect(peers.asked).toEqual(["b"]);
  });

  it("treats a window that never answers as having nothing to lose", async () => {
    const peers = fakePeers({ booting: null, c: { dirty: false } });
    expect(await confirmOtherWindows(peers)).toBe(true);
  });

  it("is a no-op with a single window", async () => {
    expect(await confirmOtherWindows(fakePeers({}))).toBe(true);
  });
});
