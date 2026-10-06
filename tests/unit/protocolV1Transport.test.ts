import { describe, it, expect } from "../bun-test";
import {
  parseTicketIroh,
  toIrohDialTarget,
  transportLabel,
} from "@/lib/protocolV1/transport";

describe("parseTicketIroh", () => {
  it("reads the snake_case wire keys", () => {
    expect(
      parseTicketIroh({ node_id: "n", relay_url: "https://r", direct_addrs: ["1.2.3.4:5"] }),
    ).toEqual({ nodeId: "n", relayUrl: "https://r", directAddrs: ["1.2.3.4:5"] });
  });

  it.each([undefined, null, "str", 3, true])("returns undefined for a non-object (%p)", (raw) => {
    expect(parseTicketIroh(raw)).toBeUndefined();
  });

  it("tolerates wrong-typed and empty fields", () => {
    expect(
      parseTicketIroh({ node_id: 5, relay_url: "", direct_addrs: ["a", 3, "", null] }),
    ).toEqual({ nodeId: undefined, relayUrl: undefined, directAddrs: ["a"] });
    expect(parseTicketIroh({ direct_addrs: "nope" })?.directAddrs).toBeUndefined();
    expect(parseTicketIroh({ direct_addrs: [] })?.directAddrs).toBeUndefined();
  });
});

describe("toIrohDialTarget / transportLabel", () => {
  it("prefers the iroh section's node_id, falling back to the protocol one", () => {
    expect(toIrohDialTarget({ nodeId: "a" }, "b").nodeId).toBe("a");
    expect(toIrohDialTarget({}, "b").nodeId).toBe("b");
  });

  it("labels both transports", () => {
    expect(transportLabel("ws")).toBe("WebSocket");
    expect(transportLabel("iroh")).toBe("iroh (direct)");
  });
});
