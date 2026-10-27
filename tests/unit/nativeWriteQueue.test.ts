/**
 * The app has one native write handle, so writers using it (a streamed export,
 * a large save, an in-place save) must not overlap: two at once closed each
 * other's file mid-write ("write_at: no open write handle"). They queue.
 */
import { describe, it, expect } from "../bun-test";
import { withNativeWriteHandle } from "@/lib/nativeWrite";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("withNativeWriteHandle", () => {
  it("runs one writer at a time, in order", async () => {
    const events: string[] = [];
    let releaseFirst: () => void = () => {};
    const first = withNativeWriteHandle(async () => {
      events.push("first:start");
      await new Promise<void>((r) => (releaseFirst = r));
      events.push("first:end");
      return 1;
    });
    const second = withNativeWriteHandle(async () => {
      events.push("second:start");
      return 2;
    });
    await tick();
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    expect(await first).toBe(1);
    expect(await second).toBe(2);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("a failed writer doesn't block the next", async () => {
    const failed = withNativeWriteHandle(async () => {
      throw new Error("disk full");
    });
    await expect(failed).rejects.toThrow("disk full");
    expect(await withNativeWriteHandle(async () => "ok")).toBe("ok");
  });
});
