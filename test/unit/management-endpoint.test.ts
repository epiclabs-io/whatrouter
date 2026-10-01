/**
 * ManagementEndpoint against a fake socket: the cases a real `ws` pair cannot
 * produce on demand (a client that stops reading, a send that throws).
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { ManagementEndpoint } from "../../src/management/endpoint.js";
import { silentLogger } from "../helpers/relay.js";

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  closedWith: { code: number; reason: string } | null = null;
  terminated = false;
  sendThrows = false;

  send(data: string): void {
    if (this.sendThrows) {
      throw new Error("boom");
    }
    this.sent.push(data);
  }

  close(code: number, reason: string): void {
    this.closedWith = { code, reason };
    this.readyState = 2;
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
  }

  ping(): void {}

  input(text: string): void {
    this.emit("message", Buffer.from(text, "utf8"), false);
  }

  frames(): Record<string, unknown>[] {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

function setup(maxBufferedBytes?: number): { endpoint: ManagementEndpoint; ws: FakeSocket } {
  const endpoint = new ManagementEndpoint({
    log: silentLogger(),
    pending: () => [],
    closeProfile: () => ({ success: false, error: "unknown profile" }),
    ...(maxBufferedBytes === undefined ? {} : { maxBufferedBytes }),
  });
  const ws = new FakeSocket();
  endpoint.attach(ws as unknown as WebSocket, "127.0.0.1");
  return { endpoint, ws };
}

const DATA = {
  profile: "work",
  gatewayId: "gw-work",
  messageId: "WA1",
  delivery: "live" as const,
};

describe("ManagementEndpoint", () => {
  it("closes a client that stops reading with 1013 instead of buffering", () => {
    const { endpoint, ws } = setup(1024);
    ws.input('{"type":"subscribe","requestId":"s","events":["message_pending"]}\n');
    endpoint.publish(DATA);
    expect(ws.frames().filter((f) => f.type === "event")).toHaveLength(1);

    ws.bufferedAmount = 4096;
    endpoint.publish(DATA);
    expect(ws.closedWith).toEqual({ code: 1013, reason: "management client too slow" });
    expect(ws.frames().filter((f) => f.type === "event")).toHaveLength(1);

    // Nothing further is written once the decision to close is made.
    ws.bufferedAmount = 0;
    endpoint.publish(DATA);
    expect(ws.frames().filter((f) => f.type === "event")).toHaveLength(1);
  });

  it("refuses a frame that would take queued output past the bound", () => {
    const { endpoint, ws } = setup(400);
    ws.input('{"type":"subscribe","requestId":"s","events":["message_pending"]}\n');
    ws.bufferedAmount = 350; // below the limit, but the next event does not fit
    endpoint.publish(DATA);
    expect(ws.closedWith).toEqual({ code: 1013, reason: "management client too slow" });
    expect(ws.frames().filter((f) => f.type === "event")).toHaveLength(0);
  });

  it("refuses a subscribe snapshot larger than the bound", () => {
    const endpoint = new ManagementEndpoint({
      log: silentLogger(),
      pending: () =>
        Array.from({ length: 50 }, (_, i) => ({
          profile: `p${i}`,
          gatewayId: `gw-${i}`,
          bufferedCount: 1,
        })),
      closeProfile: () => ({ success: false, error: "unknown profile" }),
      maxBufferedBytes: 1024,
    });
    const ws = new FakeSocket();
    endpoint.attach(ws as unknown as WebSocket, "127.0.0.1");
    ws.input('{"type":"subscribe","requestId":"s","events":["message_pending"]}\n');
    expect(ws.sent).toEqual([]);
    expect(ws.closedWith).toEqual({ code: 1013, reason: "management client too slow" });
  });

  it("never lets a throwing send escape publish", () => {
    const { endpoint, ws } = setup();
    ws.input('{"type":"subscribe","requestId":"s","events":["message_pending"]}\n');
    ws.sendThrows = true;
    expect(() => endpoint.publish(DATA)).not.toThrow();
    expect(ws.terminated).toBe(true);
  });

  it("does not publish to an unsubscribed client", () => {
    const { endpoint, ws } = setup();
    endpoint.publish(DATA);
    expect(ws.sent).toEqual([]);
  });

  it("frees the singleton slot when the client closes", () => {
    const { endpoint, ws } = setup();
    expect(endpoint.connected).toBe(true);
    ws.emit("close", 1000, Buffer.from(""));
    expect(endpoint.connected).toBe(false);
    const next = new FakeSocket();
    endpoint.attach(next as unknown as WebSocket, "127.0.0.1");
    expect(next.closedWith).toBeNull();
    expect(endpoint.connected).toBe(true);
  });

  it("closes the client with 1001 on shutdown and refuses later attaches", () => {
    const { endpoint, ws } = setup();
    endpoint.close();
    expect(ws.closedWith).toEqual({ code: 1001, reason: "going away" });
    ws.emit("close", 1001, Buffer.from("going away"));
    const late = new FakeSocket();
    endpoint.attach(late as unknown as WebSocket, "127.0.0.1");
    expect(late.closedWith).toEqual({ code: 1001, reason: "going away" });
  });

  it("measures an unterminated line in UTF-8 bytes", () => {
    const { ws } = setup();
    ws.input(`{"type":"subscribe","requestId":"${"é".repeat(33_000)}`); // 33k chars, 66 KB
    expect(ws.closedWith).toEqual({ code: 1009, reason: "management frame too large" });
  });

  it("counts whitespace around a completed frame toward the byte limit", () => {
    const { ws } = setup();
    ws.input(`${" ".repeat(64 * 1024)}{"type":"subscribe","requestId":"s","events":[]}\n`);
    expect(ws.closedWith).toEqual({ code: 1009, reason: "management frame too large" });
  });

  it("bounds a line that never terminates", () => {
    const { ws } = setup();
    ws.input(`{"type":"subscribe","requestId":"${"x".repeat(40_000)}`);
    expect(ws.closedWith).toBeNull();
    ws.input("y".repeat(40_000));
    expect(ws.closedWith).toEqual({ code: 1009, reason: "management frame too large" });
  });
});
