/**
 * `/management` end-to-end over real sockets: a real `ws` management client and
 * real relay clients against `createRelayServer` on port 0, real sqlite store.
 * Hold deadlines run on an injected millisecond clock and hand-fired expiry
 * timers, so nothing here sleeps for 20 seconds.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { connect as netConnect } from "node:net";
import { join } from "node:path";
import { Writable } from "node:stream";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { makeToken } from "../../src/relay/auth.js";
import { LineAssembler } from "../../src/relay/ndjson.js";
import { createRelayServer, HOLD_MS, type RelayServer } from "../../src/relay/server.js";
import { openStore, type Store } from "../../src/store/db.js";
import type { Config, ProfileConfig } from "../../src/config/schema.js";
import { bootSettings, delay, testConfig, testEvent, testProfile } from "../helpers/relay.js";

const MGMT_SECRET = "management-secret-0123456789abcdef-xyz";
const WORK = testProfile("work", { wakeUrl: "http://wake.invalid/work" });
const HOME = testProfile("home");
const START_MS = 1_790_870_400_000;

interface Fixture {
  server: RelayServer;
  store: Store;
  port: number;
  fetchMock: ReturnType<typeof vi.fn>;
  logs: string[];
  clock: { ms: number };
  timers: Array<{ fn: () => void; at: number; cancelled: boolean }>;
}

let fixture: Fixture;
let tempDir: string;
const sockets: Client[] = [];

/** NDJSON client for either route: collects frames and the close. */
class Client {
  readonly ws: WebSocket;
  readonly frames: Record<string, unknown>[] = [];
  closeInfo: { code: number; reason: string } | null = null;
  readonly #assembler = new LineAssembler();
  readonly #opened: Promise<void>;
  readonly #closed: Promise<{ code: number; reason: string }>;

  constructor(port: number, path: string, authorization: string | null) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      headers: authorization === null ? {} : { authorization },
    });
    this.#opened = new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", (err) => reject(err));
    });
    this.#closed = new Promise((resolve) => {
      this.ws.once("close", (code, reason) => {
        this.closeInfo = { code, reason: reason.toString("utf8") };
        resolve(this.closeInfo);
      });
    });
    this.ws.on("message", (data: Buffer) => {
      for (const line of this.#assembler.push(data.toString("utf8"))) {
        this.frames.push(JSON.parse(line) as Record<string, unknown>);
      }
    });
    this.ws.on("error", () => undefined);
    sockets.push(this);
  }

  opened(): Promise<void> {
    return this.#opened;
  }

  closed(): Promise<{ code: number; reason: string }> {
    return this.#closed;
  }

  send(frame: Record<string, unknown>): void {
    this.ws.send(`${JSON.stringify(frame)}\n`);
  }

  sendRaw(data: string | Buffer, binary = false): void {
    this.ws.send(data, { binary });
  }

  async waitFor(
    predicate: (frame: Record<string, unknown>) => boolean,
    timeoutMs = 2000
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.frames.find(predicate);
      if (found !== undefined) {
        return found;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for a frame; got ${JSON.stringify(this.frames)}`);
      }
      await delay(10);
    }
  }

  of(type: string): Record<string, unknown>[] {
    return this.frames.filter((f) => f.type === type);
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}

class Manager extends Client {
  constructor(port: number, secret: string | null = MGMT_SECRET) {
    super(port, "/management", secret === null ? null : `Bearer ${secret}`);
  }

  /** Sends a request and waits for its correlated result. */
  async request(frame: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.opened();
    this.send(frame);
    const reply = await this.waitFor((f) => f.type === "result" && f.requestId === frame.requestId);
    return reply.result as Record<string, unknown>;
  }

  subscribe(requestId: string, events: string[] = ["message_pending"]) {
    return this.request({ type: "subscribe", requestId, events });
  }

  closeProfile(requestId: string, profile: string) {
    return this.request({ type: "close_profile", requestId, profile });
  }

  releaseProfile(requestId: string, profile: string) {
    return this.request({ type: "release_profile", requestId, profile });
  }

  events(): Record<string, unknown>[] {
    return this.of("event");
  }
}

class Relay extends Client {
  constructor(port: number, profile: ProfileConfig) {
    super(port, "/relay", `Bearer ${makeToken(profile.gatewayId, profile.secret, 300)}`);
  }

  async hello(): Promise<void> {
    await this.opened();
    this.send({ type: "hello", platform: "whatsapp", botId: "34600000000" });
    await this.waitFor((f) => f.type === "descriptor");
  }
}

async function startServer(overrides: Partial<Config> = {}): Promise<Fixture> {
  const config = testConfig({
    profiles: [WORK, HOME],
    management: { secret: MGMT_SECRET },
    ...overrides,
  });
  const store = openStore(join(tempDir, "whatrouter.sqlite"), {
    mediaDir: join(tempDir, "media"),
    maxMediaBytes: config.media.maxBytes,
  });
  const logs: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb): void {
      logs.push(chunk.toString("utf8"));
      cb();
    },
  });
  const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
  const clock = { ms: START_MS };
  const timers: Fixture["timers"] = [];
  const server = createRelayServer({
    getConfig: () => config,
    ...bootSettings(config),
    store,
    log: pino({ level: "trace" }, sink),
    execute: async () => ({ success: true, message_id: "wa-out-1" }),
    health: () => ({ status: "ok" }),
    fetchImpl: fetchMock as unknown as typeof fetch,
    nowMs: () => clock.ms,
    scheduleHoldExpiry: (fn, delayMs) => {
      const timer = { fn, at: clock.ms + delayMs, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });
  const { port } = await server.listen();
  return { server, store, port, fetchMock, logs, clock, timers };
}

/** Moves the injected clock and fires every hold-expiry timer now due. */
function advanceTo(ms: number): void {
  fixture.clock.ms = ms;
  for (;;) {
    const due = fixture.timers.find((t) => !t.cancelled && t.at <= ms);
    if (due === undefined) {
      return;
    }
    due.cancelled = true;
    due.fn();
  }
}

async function health(): Promise<Record<string, Record<string, unknown>>> {
  const res = await fetch(`http://127.0.0.1:${fixture.port}/healthz`);
  return ((await res.json()) as { profiles: Record<string, Record<string, unknown>> }).profiles;
}

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "whatrouter-mgmt-"));
  fixture = await startServer();
});

afterEach(async () => {
  while (sockets.length > 0) {
    sockets.pop()?.close();
  }
  await fixture.server.close();
  fixture.store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

async function restart(overrides: Partial<Config>): Promise<void> {
  await fixture.server.close();
  fixture.store.close();
  rmSync(tempDir, { recursive: true, force: true });
  tempDir = mkdtempSync(join(tmpdir(), "whatrouter-mgmt-"));
  fixture = await startServer(overrides);
}

/**
 * Sends an upgrade request with a protocol-violating WebSocket frame (unmasked
 * client frame) in the same packet, so it lands in the upgrade `head`. Resolves
 * once the server has dropped the connection.
 */
function upgradeWithMalformedFrame(path: string, authorization: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(fixture.port, "127.0.0.1");
    let received = "";
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("latin1");
    });
    socket.on("error", () => undefined);
    socket.on("close", () => resolve(received));
    socket.on("connect", () => {
      const request = [
        `GET ${path} HTTP/1.1`,
        "Host: 127.0.0.1",
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
        `Authorization: ${authorization}`,
        "",
        "",
      ].join("\r\n");
      // FIN + text opcode, MASK bit clear: clients must mask, so ws errors.
      socket.write(
        Buffer.concat([Buffer.from(request, "latin1"), Buffer.from([0x81, 0x02, 0x68, 0x69])])
      );
    });
    setTimeout(() => reject(new Error("server never dropped the connection")), 5000).unref();
  });
}

describe("rejected upgrades survive a malformed first frame", () => {
  it.each([
    ["management with a bad secret", "/management", () => "Bearer wrong-secret"],
    [
      "relay with a bad token",
      "/relay",
      () => `Bearer ${makeToken(WORK.gatewayId, "x".repeat(40), 300)}`,
    ],
  ])("%s", async (_name, path, auth) => {
    const reply = await upgradeWithMalformedFrame(path, auth());
    expect(reply).toContain("101 Switching Protocols");
    expect((await health()).work).toBeDefined(); // still serving
  });

  it("a held relay reconnect", async () => {
    const manager = new Manager(fixture.port);
    await manager.closeProfile("c1", "work");
    await upgradeWithMalformedFrame(
      "/relay",
      `Bearer ${makeToken(WORK.gatewayId, WORK.secret, 300)}`
    );
    expect((await health()).work).toBeDefined();
  });

  it("a duplicate relay session", async () => {
    const relay = new Relay(fixture.port, WORK);
    await relay.hello();
    await upgradeWithMalformedFrame(
      "/relay",
      `Bearer ${makeToken(WORK.gatewayId, WORK.secret, 300)}`
    );
    expect(fixture.server.isConnected("work")).toBe(true);
  });

  it("a duplicate management session", async () => {
    const manager = new Manager(fixture.port);
    await manager.subscribe("s1");
    await upgradeWithMalformedFrame("/management", `Bearer ${MGMT_SECRET}`);
    expect(await manager.subscribe("s2")).toMatchObject({ success: true });
  });
});

describe("auth and route", () => {
  it("rejects /management like any unknown path when management is not configured", async () => {
    await restart({ management: null });
    const ws = new WebSocket(`ws://127.0.0.1:${fixture.port}/management`, {
      headers: { authorization: `Bearer ${MGMT_SECRET}` },
    });
    const err = await new Promise<Error>((resolve) => ws.once("error", resolve));
    expect(err.message).toMatch(/400/);
  });

  it("closes 4401 unauthorized for a missing or wrong secret, never logging it", async () => {
    const missing = new Manager(fixture.port, null);
    expect(await missing.closed()).toEqual({ code: 4401, reason: "unauthorized" });
    const wrong = new Manager(fixture.port, `${MGMT_SECRET}-nope`);
    expect(await wrong.closed()).toEqual({ code: 4401, reason: "unauthorized" });

    const ok = new Manager(fixture.port);
    expect(await ok.subscribe("s1")).toMatchObject({ success: true });
    expect(ok.closeInfo).toBeNull();

    const all = fixture.logs.join("");
    expect(all).toContain("management auth failure");
    expect(all).not.toContain(MGMT_SECRET);
  });

  it("does not throttle management failures or let them lock out relay agents", async () => {
    for (let i = 0; i < 12; i += 1) {
      const bad = new Manager(fixture.port, `wrong-${i}-${MGMT_SECRET}`);
      expect(await bad.closed()).toEqual({ code: 4401, reason: "unauthorized" });
    }
    // Same IP: relay reconnects are unaffected, and so is the right secret.
    const relay = new Relay(fixture.port, WORK);
    await relay.hello();
    expect(fixture.server.isConnected("work")).toBe(true);
    const good = new Manager(fixture.port);
    expect(await good.subscribe("s1")).toMatchObject({ success: true });
  });

  it("does not accept a profile's relay credentials", async () => {
    const asProfile = new Manager(fixture.port, WORK.secret);
    expect(await asProfile.closed()).toEqual({ code: 4401, reason: "unauthorized" });
    const asToken = new Manager(fixture.port, makeToken(WORK.gatewayId, WORK.secret, 300));
    expect(await asToken.closed()).toEqual({ code: 4401, reason: "unauthorized" });
  });

  it("allows one management client; a second gets 1008", async () => {
    const first = new Manager(fixture.port);
    await first.subscribe("s1");
    const second = new Manager(fixture.port);
    expect(await second.closed()).toEqual({ code: 1008, reason: "duplicate management session" });
    expect(await first.subscribe("s2", [])).toMatchObject({ success: true });

    // Once the first is gone, a new one is welcome.
    first.close();
    await first.closed();
    const third = new Manager(fixture.port);
    expect(await third.subscribe("s3")).toMatchObject({ success: true });
  });

  it("coexists with relay sessions without counting as one", async () => {
    const relay = new Relay(fixture.port, WORK);
    await relay.hello();
    const manager = new Manager(fixture.port);
    await manager.subscribe("s1");
    expect(fixture.server.isConnected("work")).toBe(true);
    expect(fixture.server.isConnected("home")).toBe(false);
    expect(fixture.server.deliver("work", testEvent("hi"))).toBe("live");
    await relay.waitFor((f) => f.type === "inbound");
  });
});

describe("framing", () => {
  it("assembles split frames and handles coalesced ones", async () => {
    const manager = new Manager(fixture.port);
    await manager.opened();
    manager.sendRaw('{"type":"subscribe","reque');
    await delay(30);
    expect(manager.frames).toEqual([]);
    manager.sendRaw(
      'stId":"a","events":[]}\n{"type":"close_profile","requestId":"b","profile":"nobody"}\n'
    );
    await manager.waitFor((f) => f.requestId === "b");
    expect(manager.frames).toEqual([
      { type: "result", requestId: "a", result: { success: true, events: [], pending: [] } },
      {
        type: "result",
        requestId: "b",
        result: { success: false, error: "unknown profile" },
      },
    ]);
  });

  it("answers an unsupported type under its requestId and stays open", async () => {
    const manager = new Manager(fixture.port);
    expect(await manager.request({ type: "reboot", requestId: "r1" })).toEqual({
      success: false,
      error: "unsupported request type",
    });
    expect(manager.closeInfo).toBeNull();
  });

  it.each([
    ["malformed json", "{nope\n"],
    ["non-object json", "[1,2]\n"],
    ["missing requestId", '{"type":"subscribe","events":[]}\n'],
    ["empty requestId", '{"type":"subscribe","requestId":"","events":[]}\n'],
    ["oversized requestId", `{"type":"subscribe","requestId":"${"x".repeat(129)}","events":[]}\n`],
  ])("closes 1008 on %s", async (_name, text) => {
    const manager = new Manager(fixture.port);
    await manager.opened();
    manager.sendRaw(text);
    expect(await manager.closed()).toEqual({ code: 1008, reason: "invalid management frame" });
    expect(fixture.logs.join("")).not.toContain("xxxxxxxxxx");
  });

  it("closes 1003 on a binary message", async () => {
    const manager = new Manager(fixture.port);
    await manager.opened();
    manager.sendRaw(Buffer.from('{"type":"subscribe","requestId":"b","events":[]}\n'), true);
    expect(await manager.closed()).toEqual({ code: 1003, reason: "text frames only" });
  });

  it("limits each frame, not the sum of coalesced frames", async () => {
    const manager = new Manager(fixture.port);
    await manager.opened();
    const frame = (id: string): string =>
      `${JSON.stringify({ type: "close_profile", requestId: id, profile: "p".repeat(40_000) })}\n`;
    manager.sendRaw(frame("big-1") + frame("big-2")); // ~80 KB in one message
    await manager.waitFor((f) => f.requestId === "big-2");
    expect(manager.of("result").map((f) => f.result)).toEqual([
      { success: false, error: "unknown profile" },
      { success: false, error: "unknown profile" },
    ]);
    expect(manager.closeInfo).toBeNull();
  });

  it("closes 1009 on a single frame over 64 KiB of UTF-8", async () => {
    const manager = new Manager(fixture.port);
    await manager.opened();
    // 40k chars but 80 KB: the limit is bytes, not UTF-16 units.
    manager.sendRaw(`{"type":"subscribe","requestId":"r","x":"${"é".repeat(40_000)}"}\n`);
    expect(await manager.closed()).toEqual({ code: 1009, reason: "management frame too large" });
  });

  it("closes 1009 on a websocket message over 1 MiB", async () => {
    const manager = new Manager(fixture.port);
    await manager.opened();
    manager.sendRaw("\n".repeat(1024 * 1024 + 1));
    expect((await manager.closed()).code).toBe(1009);
  });
});

describe("subscribe and events", () => {
  it("sends no events before a subscription", async () => {
    const manager = new Manager(fixture.port);
    await manager.opened();
    fixture.server.deliver("home", testEvent("early"));
    await delay(50);
    expect(manager.frames).toEqual([]);
  });

  it("replaces, repeats idempotently, unsubscribes, and keeps the old one on a bad request", async () => {
    const manager = new Manager(fixture.port);
    expect(await manager.subscribe("s1")).toEqual({
      success: true,
      events: ["message_pending"],
      pending: [],
    });
    expect(await manager.subscribe("s2")).toMatchObject({ success: true });
    fixture.server.deliver("home", testEvent("one"));
    await manager.waitFor((f) => f.type === "event");
    expect(manager.events()).toHaveLength(1);

    // An unsupported event fails atomically: the subscription survives.
    expect(await manager.subscribe("s3", ["message_pending", "everything"])).toEqual({
      success: false,
      error: "unsupported event",
    });
    fixture.server.deliver("home", testEvent("two"));
    await manager.waitFor((f) => f.type === "event" && manager.events().length === 2);

    expect(await manager.subscribe("s4", [])).toEqual({
      success: true,
      events: [],
      pending: [{ profile: "home", gatewayId: "gw-home", bufferedCount: 2 }],
    });
    fixture.server.deliver("home", testEvent("three"));
    await delay(50);
    expect(manager.events()).toHaveLength(2);
  });

  it("puts the subscribe result before any event", async () => {
    const manager = new Manager(fixture.port);
    await manager.opened();
    manager.send({ type: "subscribe", requestId: "s1", events: ["message_pending"] });
    // Deliveries race the subscription; whichever lands after it is published.
    for (let i = 0; i < 20; i += 1) {
      fixture.server.deliver("home", testEvent(`m${i}`));
      await delay(1);
    }
    await manager.waitFor((f) => f.type === "result");
    expect(manager.frames[0]?.type).toBe("result");
  });

  it("snapshots every profile whose durable buffer is non-empty", async () => {
    fixture.server.deliver("work", testEvent("a"));
    fixture.server.deliver("work", testEvent("b"));
    fixture.server.deliver("work", testEvent("c"));
    const manager = new Manager(fixture.port);
    expect(await manager.subscribe("s1")).toEqual({
      success: true,
      events: ["message_pending"],
      pending: [{ profile: "work", gatewayId: "gw-work", bufferedCount: 3 }],
    });
    fixture.server.deliver("home", testEvent("d"));
    expect((await manager.subscribe("s2")).pending).toEqual([
      { profile: "work", gatewayId: "gw-work", bufferedCount: 3 },
      { profile: "home", gatewayId: "gw-home", bufferedCount: 1 },
    ]);
  });

  it("publishes exact live and buffered events, nothing for unknown profiles or replays", async () => {
    const manager = new Manager(fixture.port);
    await manager.subscribe("s1");
    const relay = new Relay(fixture.port, WORK);
    await relay.hello();

    expect(fixture.server.deliver("work", testEvent("live"))).toBe("live");
    expect(fixture.server.deliver("home", testEvent("away"))).toBe("buffered");
    expect(fixture.server.deliver("ghost", testEvent("lost"))).toBe("unknown_profile");
    await manager.waitFor(() => manager.events().length === 2);
    expect(manager.events()).toEqual([
      {
        type: "event",
        event: "message_pending",
        data: { profile: "work", gatewayId: "gw-work", messageId: "wa-live", delivery: "live" },
      },
      {
        type: "event",
        event: "message_pending",
        data: { profile: "home", gatewayId: "gw-home", messageId: "wa-away", delivery: "buffered" },
      },
    ]);

    // A connected but idle-flipped session buffers: still one event, "buffered".
    relay.send({ type: "going_idle" });
    await relay.waitFor((f) => f.type === "going_idle_ack");
    expect(fixture.server.deliver("work", testEvent("idle"))).toBe("buffered");
    await manager.waitFor(() => manager.events().length === 3);
    expect(manager.events()[2]?.data).toEqual({
      profile: "work",
      gatewayId: "gw-work",
      messageId: "wa-idle",
      delivery: "buffered",
    });

    // Replaying the buffer on reconnect is not a new message.
    const home = new Relay(fixture.port, HOME);
    await home.hello();
    const replay = await home.waitFor((f) => f.type === "inbound");
    expect(typeof replay.bufferId).toBe("string");
    home.send({ type: "inbound_ack", bufferId: replay.bufferId as string });
    await delay(50);
    expect(manager.events()).toHaveLength(3);
    expect(JSON.stringify(manager.events())).not.toContain("Tester");
  });

  it("does not let a vanished management client affect relay delivery", async () => {
    const manager = new Manager(fixture.port);
    await manager.subscribe("s1");
    const relay = new Relay(fixture.port, WORK);
    await relay.hello();
    manager.ws.terminate();
    for (let i = 0; i < 50; i += 1) {
      expect(fixture.server.deliver("work", testEvent(`m${i}`))).toBe("live");
    }
    await relay.waitFor(() => relay.of("inbound").length === 50);
    expect(fixture.server.deliver("home", testEvent("away"))).toBe("buffered");
    expect(fixture.server.bufferedCount("home")).toBe(1);
  });
});

describe("close_profile", () => {
  it("detaches a live session at once and the relay sees 1001 closed by management", async () => {
    const relay = new Relay(fixture.port, WORK);
    await relay.hello();
    const relayClosed = relay.closed();
    const manager = new Manager(fixture.port);

    const result = await manager.closeProfile("c1", "work");
    expect(result).toEqual({
      success: true,
      profile: "work",
      wasConnected: true,
      blockedUntilMs: START_MS + 20_000,
      retryAfterMs: 20_000,
    });
    // Synchronously disabled: the very next inbound buffers.
    expect(fixture.server.isConnected("work")).toBe(false);
    expect(fixture.server.deliver("work", testEvent("after close"))).toBe("buffered");
    expect(fixture.server.bufferedCount("work")).toBe(1);
    expect(await health()).toMatchObject({
      work: { connected: false, buffered: 1, blockedUntilMs: START_MS + 20_000 },
    });

    expect(await relayClosed).toEqual({ code: 1001, reason: "closed by management" });
    expect(relay.of("inbound")).toHaveLength(0);
  });

  it("succeeds for a disconnected known profile and fails for an unknown one", async () => {
    const manager = new Manager(fixture.port);
    expect(await manager.closeProfile("c1", "home")).toEqual({
      success: true,
      profile: "home",
      wasConnected: false,
      blockedUntilMs: START_MS + HOLD_MS,
      retryAfterMs: HOLD_MS,
    });
    expect(await manager.closeProfile("c2", "nobody")).toEqual({
      success: false,
      error: "unknown profile",
    });
    const reconnect = new Relay(fixture.port, HOME);
    expect(await reconnect.closed()).toEqual({
      code: 1013,
      reason: "profile temporarily suspended",
    });
  });

  it("refuses reconnects with 1013 until the exact deadline, then allows them", async () => {
    const manager = new Manager(fixture.port);
    await manager.closeProfile("c1", "work");

    advanceTo(START_MS + HOLD_MS - 1);
    const early = new Relay(fixture.port, WORK);
    expect(await early.closed()).toEqual({ code: 1013, reason: "profile temporarily suspended" });
    expect(early.frames).toEqual([]);
    expect(fixture.server.isConnected("work")).toBe(false);

    advanceTo(START_MS + HOLD_MS);
    const onTime = new Relay(fixture.port, WORK);
    await onTime.hello();
    expect(fixture.server.isConnected("work")).toBe(true);
    expect((await health()).work).toEqual({ connected: true, buffered: 0 });
  });

  it("resets the full hold on a repeated close and leaves other profiles alone", async () => {
    const home = new Relay(fixture.port, HOME);
    await home.hello();
    const manager = new Manager(fixture.port);
    await manager.closeProfile("c1", "work");

    advanceTo(START_MS + 15_000);
    expect(await manager.closeProfile("c2", "work")).toMatchObject({
      blockedUntilMs: START_MS + 35_000,
      wasConnected: false,
    });
    advanceTo(START_MS + 25_000);
    const stillHeld = new Relay(fixture.port, WORK);
    expect((await stillHeld.closed()).code).toBe(1013);

    expect(fixture.server.isConnected("home")).toBe(true);
    expect(fixture.server.deliver("home", testEvent("unaffected"))).toBe("live");
    await home.waitFor((f) => f.type === "inbound");
    expect(home.closeInfo).toBeNull();

    advanceTo(START_MS + 35_000);
    const allowed = new Relay(fixture.port, WORK);
    await allowed.hello();
    expect(fixture.server.isConnected("work")).toBe(true);
  });

  it("an old socket's close cannot remove a post-expiry session", async () => {
    const old = new Relay(fixture.port, WORK);
    await old.hello();
    // Keep the old socket from completing its close handshake for now.
    const rawSocket = (old.ws as unknown as { _socket: { pause(): void; resume(): void } })._socket;
    rawSocket.pause();
    const manager = new Manager(fixture.port);
    await manager.closeProfile("c1", "work");

    advanceTo(START_MS + HOLD_MS);
    const fresh = new Relay(fixture.port, WORK);
    await fresh.hello();
    expect(fixture.server.isConnected("work")).toBe(true);
    expect(old.closeInfo).toBeNull(); // the old close is still outstanding

    rawSocket.resume();
    expect(await old.closed()).toEqual({ code: 1001, reason: "closed by management" });
    await delay(50);
    expect(fixture.server.isConnected("work")).toBe(true);
    expect(fixture.server.deliver("work", testEvent("to fresh"))).toBe("live");
    await fresh.waitFor((f) => f.type === "inbound");
  });

  it("keeps unacked buffered work durable and replays it after a permitted reconnect", async () => {
    const relay = new Relay(fixture.port, WORK);
    await relay.hello();
    relay.send({ type: "going_idle" });
    await relay.waitFor((f) => f.type === "going_idle_ack");
    fixture.server.deliver("work", testEvent("one"));
    const manager = new Manager(fixture.port);
    await manager.closeProfile("c1", "work");
    await relay.closed();
    fixture.server.deliver("work", testEvent("two"));
    expect(fixture.server.bufferedCount("work")).toBe(2);

    advanceTo(START_MS + HOLD_MS);
    const back = new Relay(fixture.port, WORK);
    await back.hello();
    const first = await back.waitFor((f) => f.type === "inbound");
    expect((first.event as { text: string }).text).toBe("one");
    back.send({ type: "inbound_ack", bufferId: first.bufferId as string });
    const second = await back.waitFor((f) => f.type === "inbound" && f !== first);
    expect((second.event as { text: string }).text).toBe("two");
    back.send({ type: "inbound_ack", bufferId: second.bufferId as string });
    await delay(50);
    expect(fixture.server.bufferedCount("work")).toBe(0);
  });
});

describe("release_profile", () => {
  it("cancels an active hold and permits an immediate reconnect without waking", async () => {
    const relay = new Relay(fixture.port, WORK);
    await relay.hello();
    const manager = new Manager(fixture.port);
    await manager.closeProfile("c1", "work");
    await relay.closed();
    fixture.server.deliver("work", testEvent("release me"));

    expect(await manager.releaseProfile("r1", "work")).toEqual({
      success: true,
      profile: "work",
      wasHeld: true,
    });
    expect((await health()).work).toEqual({ connected: false, buffered: 1 });
    expect(fixture.fetchMock).not.toHaveBeenCalled();
    expect(fixture.timers.every((timer) => timer.cancelled)).toBe(true);

    const fresh = new Relay(fixture.port, WORK);
    await fresh.hello();
    const replay = await fresh.waitFor((frame) => frame.type === "inbound");
    expect((replay.event as { text: string }).text).toBe("release me");
    fresh.send({ type: "inbound_ack", bufferId: replay.bufferId as string });
    advanceTo(START_MS + HOLD_MS);
    await delay(20);
    expect(fixture.fetchMock).not.toHaveBeenCalled();
  });

  it("is idempotent and rejects only unknown profiles", async () => {
    const manager = new Manager(fixture.port);
    expect(await manager.releaseProfile("r1", "home")).toEqual({
      success: true,
      profile: "home",
      wasHeld: false,
    });
    await manager.closeProfile("c1", "home");
    expect(await manager.releaseProfile("r2", "home")).toMatchObject({ wasHeld: true });
    expect(await manager.releaseProfile("r3", "home")).toEqual({
      success: true,
      profile: "home",
      wasHeld: false,
    });
    expect(await manager.releaseProfile("r4", "nobody")).toEqual({
      success: false,
      error: "unknown profile",
    });
  });

  it("does not let the detached old socket remove the released replacement", async () => {
    const old = new Relay(fixture.port, WORK);
    await old.hello();
    const rawSocket = (old.ws as unknown as { _socket: { pause(): void; resume(): void } })._socket;
    rawSocket.pause();
    const manager = new Manager(fixture.port);
    await manager.closeProfile("c1", "work");
    await manager.releaseProfile("r1", "work");

    const fresh = new Relay(fixture.port, WORK);
    await fresh.hello();
    rawSocket.resume();
    await old.closed();
    await delay(50);
    expect(fixture.server.isConnected("work")).toBe(true);
    expect(fixture.server.deliver("work", testEvent("fresh"))).toBe("live");
    await fresh.waitFor((frame) => frame.type === "inbound");
  });

  it("does not wake on release, but a later first buffered message wakes normally", async () => {
    const manager = new Manager(fixture.port);
    await manager.closeProfile("c1", "work");
    await manager.releaseProfile("r1", "work");
    await delay(20);
    expect(fixture.fetchMock).not.toHaveBeenCalled();

    fixture.server.deliver("work", testEvent("after release"));
    await delay(20);
    expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("wake during a hold", () => {
  it("suppresses the poke, then makes one eligible attempt at expiry", async () => {
    const manager = new Manager(fixture.port);
    await manager.closeProfile("c1", "work");

    fixture.server.deliver("work", testEvent("while held"));
    fixture.server.deliver("work", testEvent("again"));
    await delay(20);
    expect(fixture.fetchMock).not.toHaveBeenCalled();

    advanceTo(START_MS + HOLD_MS);
    await delay(20);
    expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
    expect(fixture.fetchMock.mock.calls[0]?.[0]).toBe("http://wake.invalid/work");
  });

  it("does not wake at expiry when nothing is buffered or the profile reconnected", async () => {
    const manager = new Manager(fixture.port);
    await manager.closeProfile("c1", "work");
    advanceTo(START_MS + HOLD_MS);
    await delay(20);
    expect(fixture.fetchMock).not.toHaveBeenCalled();

    await manager.closeProfile("c2", "work");
    fixture.server.deliver("work", testEvent("held"));
    fixture.clock.ms = START_MS + 2 * HOLD_MS; // hold lapses, timer not fired yet
    const relay = new Relay(fixture.port, WORK);
    await relay.hello();
    advanceTo(START_MS + 2 * HOLD_MS);
    await delay(20);
    expect(fixture.fetchMock).not.toHaveBeenCalled();
  });

  it("only the newest hold's timer acts", async () => {
    const manager = new Manager(fixture.port);
    await manager.closeProfile("c1", "work");
    fixture.server.deliver("work", testEvent("held"));
    fixture.clock.ms = START_MS + 10_000;
    await manager.closeProfile("c2", "work");
    expect(fixture.timers.filter((t) => !t.cancelled)).toHaveLength(1);
    advanceTo(START_MS + HOLD_MS);
    await delay(20);
    expect(fixture.fetchMock).not.toHaveBeenCalled();
    advanceTo(START_MS + 10_000 + HOLD_MS);
    await delay(20);
    expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("shutdown", () => {
  it("closes management 1001, terminates detached relay sockets and cancels hold timers", async () => {
    const relay = new Relay(fixture.port, WORK);
    await relay.hello();
    const rawSocket = (relay.ws as unknown as { _socket: { pause(): void } })._socket;
    rawSocket.pause(); // never answers the management close
    const manager = new Manager(fixture.port);
    await manager.closeProfile("c1", "work");
    const managerClosed = manager.closed();

    const started = Date.now();
    await fixture.server.close();
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(await managerClosed).toEqual({ code: 1001, reason: "going away" });
    expect(fixture.timers.every((t) => t.cancelled)).toBe(true);
  });
});
