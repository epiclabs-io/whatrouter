/**
 * `runServe`/`startServe` end to end: the fake WhatsApp port, the real router,
 * the real relay server on a real socket, two real `ws` clients speaking NDJSON.
 *
 * Everything a Hermes operator can get wrong is in here: cross-talk between
 * profiles, unrouted chats, mention gating, media scoping and the tenant check.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { makeToken } from "../../src/relay/auth.js";
import { LineAssembler } from "../../src/relay/ndjson.js";
import { startServe, inboundFromDebugBody, type ServeHandle } from "../../src/serve.js";
import { mediaIdFromUrl } from "../../src/router/router.js";
import type { Config, ProfileConfig } from "../../src/config/schema.js";
import type { RelayEvent } from "../../src/relay/frames.js";
import { delay, silentLogger, testConfig } from "../helpers/relay.js";
import { ALICE, BOB, CAROL, GROUP, dmRoute, groupRoute, profileWith } from "../helpers/router.js";

const OPEN_GROUP = "120363000000000002@g.us";
const VIP_GROUP = "120363000000000003@g.us";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08]);

const io = { out: (): void => undefined, err: (): void => undefined };

function serveConfig(dataDir: string, overrides: Partial<Config> = {}): Config {
  return testConfig({
    listen: { host: "127.0.0.1", port: 0 },
    dataDir,
    groups: Object.fromEntries(
      [GROUP, OPEN_GROUP, VIP_GROUP].map((id) => [
        id,
        { displayName: null, adminsSeen: null, listenSource: "explicit", listen: ["*"] },
      ])
    ),
    profiles: [
      profileWith("a", [
        dmRoute(ALICE),
        groupRoute(GROUP),
        groupRoute(OPEN_GROUP, { requireMention: false }),
        groupRoute(VIP_GROUP, { requireMention: false, allowedSenders: [BOB] }),
      ]),
      profileWith("b", [dmRoute(BOB)]),
    ],
    ...overrides,
  });
}

/** A gateway-shaped NDJSON client: hello, collect inbound, ack replays. */
class Gateway {
  readonly frames: Record<string, unknown>[] = [];
  readonly #ws: WebSocket;
  readonly #assembler = new LineAssembler();
  readonly #open: Promise<void>;

  constructor(port: number, profile: ProfileConfig) {
    this.#ws = new WebSocket(`ws://127.0.0.1:${port}/relay`, {
      headers: { authorization: `Bearer ${makeToken(profile.gatewayId, profile.secret, 300)}` },
    });
    this.#open = new Promise((resolve, reject) => {
      this.#ws.once("open", () => resolve());
      this.#ws.once("error", reject);
    });
    this.#ws.on("message", (data: Buffer) => {
      for (const line of this.#assembler.push(data.toString("utf8"))) {
        const frame = JSON.parse(line) as Record<string, unknown>;
        this.frames.push(frame);
        // The real gateway acks every replayed event; without it a buffered
        // delivery would stall the next one.
        if (frame["type"] === "inbound" && typeof frame["bufferId"] === "string") {
          this.send({ type: "inbound_ack", bufferId: frame["bufferId"] });
        }
      }
    });
    this.#ws.on("error", () => undefined);
  }

  send(frame: Record<string, unknown>): void {
    this.#ws.send(`${JSON.stringify(frame)}\n`);
  }

  async hello(): Promise<void> {
    await this.#open;
    this.send({ type: "hello", platform: "whatsapp", botId: "" });
    await this.waitFor((f) => f["type"] === "descriptor");
  }

  async waitFor(
    predicate: (f: Record<string, unknown>) => boolean,
    timeoutMs = 2000
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.frames.find(predicate);
      if (found !== undefined) {
        return found;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out; frames so far: ${JSON.stringify(this.frames)}`);
      }
      await delay(10);
    }
  }

  events(): RelayEvent[] {
    return this.frames.filter((f) => f["type"] === "inbound").map((f) => f["event"] as RelayEvent);
  }

  /** One outbound action, answered by its `outbound_result`. */
  async outbound(action: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requestId = `req-${this.frames.length}-${Math.random().toString(16).slice(2)}`;
    this.send({ type: "outbound", requestId, action });
    const frame = await this.waitFor(
      (f) => f["type"] === "outbound_result" && f["requestId"] === requestId
    );
    return frame["result"] as Record<string, unknown>;
  }

  close(): void {
    try {
      this.#ws.close();
    } catch {
      /* already gone */
    }
  }
}

describe("serve: routing, gating and isolation", () => {
  let handle: ServeHandle;
  let dataDir: string;
  let port: number;
  let a: Gateway;
  let b: Gateway;
  let config: Config;

  const base = (): string => `http://127.0.0.1:${port}`;

  const inject = async (body: Record<string, unknown>): Promise<Response> =>
    fetch(`${base()}/debug/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const profile = (name: string): ProfileConfig => {
    const found = config.profiles.find((p) => p.name === name);
    if (found === undefined) {
      throw new Error(`no profile ${name}`);
    }
    return found;
  };

  const bearer = (name: string): string =>
    `Bearer ${makeToken(profile(name).gatewayId, profile(name).secret, 300)}`;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "whatrouter-serve-"));
    config = serveConfig(dataDir);
    const started = await startServe({
      config,
      log: silentLogger(),
      io,
      fake: true,
      signals: false,
    });
    if (!started.ok) {
      throw new Error(`startServe failed with code ${started.code}`);
    }
    handle = started.handle;
    port = handle.address.port;
    a = new Gateway(port, profile("a"));
    b = new Gateway(port, profile("b"));
    await a.hello();
    await b.hello();
  });

  afterAll(async () => {
    a?.close();
    b?.close();
    await handle?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("binds a real port and reports a healthy WhatsApp connection", async () => {
    expect(port).toBeGreaterThan(0);
    const health = (await (await fetch(`${base()}/healthz`)).json()) as Record<string, unknown>;
    expect(health["status"]).toBe("ok");
    expect(health["whatsapp"]).toBe("connected");
    expect(health["profiles"]).toMatchObject({
      a: { connected: true, buffered: 0 },
      b: { connected: true, buffered: 0 },
    });
  });

  it("delivers a routed DM to its profile and to nobody else", async () => {
    const res = await inject({ chatId: ALICE, text: "hola", senderName: "Alice", messageId: "m1" });
    expect(res.status).toBe(200);
    const frame = await a.waitFor(
      (f) => f["type"] === "inbound" && (f["event"] as RelayEvent).message_id === "m1"
    );
    const event = frame["event"] as RelayEvent;
    expect(event.text).toBe("hola");
    expect(event.message_type).toBe("text");
    expect(event.source).toMatchObject({
      platform: "whatsapp",
      chat_id: ALICE,
      chat_type: "dm",
      user_id: ALICE,
      user_name: "Alice",
      message_id: "m1",
    });
    await delay(150);
    expect(b.events()).toHaveLength(0);
  });

  it("marks a slash command as a command", async () => {
    await inject({ chatId: ALICE, text: "/help", messageId: "m2" });
    const frame = await a.waitFor(
      (f) => f["type"] === "inbound" && (f["event"] as RelayEvent).message_id === "m2"
    );
    expect((frame["event"] as RelayEvent).message_type).toBe("command");
  });

  it("drops an unrouted DM everywhere, and buffers nothing", async () => {
    const before = a.events().length;
    await inject({ chatId: CAROL, text: "who are you", messageId: "m3" });
    await delay(150);
    expect(a.events()).toHaveLength(before);
    expect(b.events()).toHaveLength(0);
    const health = (await (await fetch(`${base()}/healthz`)).json()) as {
      profiles: Record<string, { buffered: number }>;
    };
    expect(health.profiles["a"]?.buffered).toBe(0);
    expect(health.profiles["b"]?.buffered).toBe(0);
  });

  it("gates a group on addressing the bot", async () => {
    const before = a.events().length;
    await inject({
      chatId: GROUP,
      chatType: "group",
      senderId: ALICE,
      text: "chatter",
      messageId: "g1",
    });
    await delay(150);
    expect(a.events()).toHaveLength(before);

    await inject({
      chatId: GROUP,
      chatType: "group",
      senderId: ALICE,
      text: "@bot hello",
      mentionsBot: true,
      messageId: "g2",
    });
    await a.waitFor((f) => (f["event"] as RelayEvent | undefined)?.message_id === "g2");

    await inject({
      chatId: GROUP,
      chatType: "group",
      senderId: ALICE,
      text: "/cmd",
      messageId: "g3",
    });
    const frame = await a.waitFor(
      (f) => (f["event"] as RelayEvent | undefined)?.message_id === "g3"
    );
    expect((frame["event"] as RelayEvent).message_type).toBe("command");
    expect((frame["event"] as RelayEvent).source.chat_type).toBe("group");
  });

  it("delivers everything in a group with require_mention: false", async () => {
    await inject({
      chatId: OPEN_GROUP,
      chatType: "group",
      senderId: ALICE,
      text: "no mention needed",
      messageId: "g4",
    });
    await a.waitFor((f) => (f["event"] as RelayEvent | undefined)?.message_id === "g4");
  });

  it("enforces allowed_senders", async () => {
    const before = a.events().length;
    await inject({
      chatId: VIP_GROUP,
      chatType: "group",
      senderId: ALICE,
      text: "let me in",
      messageId: "g5",
    });
    await delay(150);
    expect(a.events()).toHaveLength(before);

    await inject({
      chatId: VIP_GROUP,
      chatType: "group",
      senderId: BOB,
      text: "I am on the list",
      messageId: "g6",
    });
    await a.waitFor((f) => (f["event"] as RelayEvent | undefined)?.message_id === "g6");
  });

  it("refuses an outbound action for a chat the profile does not own", async () => {
    expect(await b.outbound({ op: "send", chat_id: ALICE, content: "hijack" })).toEqual({
      success: false,
      error: "chat not routed to this profile",
    });
    expect(await a.outbound({ op: "send", chat_id: BOB, content: "hijack" })).toEqual({
      success: false,
      error: "chat not routed to this profile",
    });
    expect(handle.fake?.sent.filter((s) => s.kind === "text")).toHaveLength(0);
  });

  it("sends for the owning profile", async () => {
    const result = await a.outbound({ op: "send", chat_id: ALICE, content: "hello back" });
    expect(result["success"]).toBe(true);
    expect(result["message_id"]).toBeTruthy();
    const sent = handle.fake?.sent.filter((s) => s.kind === "text") ?? [];
    expect(sent.at(-1)).toMatchObject({ chat: ALICE, text: "hello back" });
  });

  it("re-hosts inbound media, scoped to the receiving profile", async () => {
    await inject({
      chatId: ALICE,
      text: "a photo",
      kind: "image",
      mediaBase64: JPEG.toString("base64"),
      mediaMime: "image/jpeg",
      mediaFilename: "cat.jpg",
      messageId: "m4",
    });
    const frame = await a.waitFor(
      (f) => (f["event"] as RelayEvent | undefined)?.message_id === "m4"
    );
    const event = frame["event"] as RelayEvent;
    expect(event.message_type).toBe("photo");
    const url = event.media_urls?.[0] ?? "";
    const id = mediaIdFromUrl(url) ?? "";
    expect(url).toBe(`http://localhost:${port}/relay/media/${id}`);
    expect(event.media?.[0]).toMatchObject({ url, mime: "image/jpeg", kind: "image" });

    // `localhost` may resolve to ::1 in this process; the bytes live on 127.0.0.1.
    const mine = await fetch(`${base()}/relay/media/${id}`, {
      headers: { authorization: bearer("a") },
    });
    expect(mine.status).toBe(200);
    expect(mine.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await mine.arrayBuffer()).equals(JPEG)).toBe(true);

    const theirs = await fetch(`${base()}/relay/media/${id}`, {
      headers: { authorization: bearer("b") },
    });
    expect(theirs.status).toBe(404);

    const result = await a.outbound({
      op: "send_media",
      chat_id: ALICE,
      media_kind: "image",
      source_url: url,
      content: "here it is",
    });
    expect(result["success"]).toBe(true);
    const media = (handle.fake?.sent ?? []).filter((s) => s.kind === "media");
    expect(media).toHaveLength(1);
    const first = media[0];
    expect(first?.kind === "media" ? first.media : null).toMatchObject({
      kind: "image",
      mime: "image/jpeg",
      caption: "here it is",
    });
  });

  // Last: the stored policy outlives the test that sets it.
  it("lets a gateway policy lift the mention gate for its own profile", async () => {
    const res = await fetch(`${base()}/relay/policy`, {
      method: "POST",
      headers: { authorization: bearer("a"), "content-type": "application/json" },
      body: JSON.stringify({ platform: "whatsapp", requireAddress: false }),
    });
    expect(res.status).toBe(200);
    await inject({
      chatId: GROUP,
      chatType: "group",
      senderId: ALICE,
      text: "still chatter",
      messageId: "g7",
    });
    await a.waitFor((f) => (f["event"] as RelayEvent | undefined)?.message_id === "g7");
  });
});

describe("serve: default_profile", () => {
  let handle: ServeHandle;
  let dataDir: string;

  afterAll(async () => {
    await handle?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("delivers an otherwise unrouted DM to the default profile", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "whatrouter-serve-default-"));
    const config = serveConfig(dataDir, { defaultProfile: "b" });
    const started = await startServe({
      config,
      log: silentLogger(),
      io,
      fake: true,
      signals: false,
    });
    if (!started.ok) {
      throw new Error(`startServe failed with code ${started.code}`);
    }
    handle = started.handle;
    const { port } = handle.address;
    const profileB = config.profiles.find((p) => p.name === "b");
    const profileA = config.profiles.find((p) => p.name === "a");
    if (profileA === undefined || profileB === undefined) {
      throw new Error("missing profiles");
    }
    const a = new Gateway(port, profileA);
    const b = new Gateway(port, profileB);
    await a.hello();
    await b.hello();

    await fetch(`http://127.0.0.1:${port}/debug/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatId: CAROL, text: "anybody there", messageId: "d1" }),
    });
    const frame = await b.waitFor(
      (f) => (f["event"] as RelayEvent | undefined)?.message_id === "d1"
    );
    expect((frame["event"] as RelayEvent).source.chat_id).toBe(CAROL);
    expect(a.events()).toHaveLength(0);

    // The reply must pass the tenant check even though there is no route.
    expect(await b.outbound({ op: "send", chat_id: CAROL, content: "hi" })).toMatchObject({
      success: true,
    });
    expect(await a.outbound({ op: "send", chat_id: CAROL, content: "hi" })).toEqual({
      success: false,
      error: "chat not routed to this profile",
    });
    a.close();
    b.close();
  });
});

describe("inboundFromDebugBody", () => {
  it("fills every field from a two-key body", () => {
    const m = inboundFromDebugBody({ chatId: ALICE, text: "hola" });
    expect(m).toMatchObject({
      chatId: ALICE,
      chatIdRaw: ALICE,
      chatType: "dm",
      senderId: ALICE,
      senderIdAlt: null,
      senderName: "34600000001",
      chatName: "34600000001",
      text: "hola",
      kind: "text",
      mentionsBot: false,
      mentionedIds: [],
      quoted: null,
      media: null,
      downloadFailed: false,
    });
    expect(m.messageId).toMatch(/^debug-\d+$/);
    expect(m.timestamp).toBeGreaterThan(1_700_000_000);
  });

  it("infers a group chat from the jid and keeps an explicit sender", () => {
    const m = inboundFromDebugBody({ chatId: GROUP, senderId: BOB, text: "hi" });
    expect(m).toMatchObject({ chatType: "group", senderId: BOB, chatName: "120363000000000001" });
  });

  it("decodes media and derives the kind from the mime type", () => {
    const m = inboundFromDebugBody({
      chatId: ALICE,
      mediaBase64: JPEG.toString("base64"),
      mediaMime: "image/jpeg",
      mediaFilename: "cat.jpg",
      mediaCaption: "a cat",
    });
    expect(m.kind).toBe("image");
    expect(m.media).toMatchObject({
      kind: "image",
      mime: "image/jpeg",
      size: JPEG.byteLength,
      filename: "cat.jpg",
      caption: "a cat",
    });
    expect(Buffer.from(m.media?.bytes ?? new Uint8Array()).equals(JPEG)).toBe(true);
  });

  it("maps a quote and mentions", () => {
    const m = inboundFromDebugBody({
      chatId: GROUP,
      chatType: "group",
      senderId: ALICE,
      text: "yes",
      mentionsBot: true,
      mentionedIds: ["1000@s.whatsapp.net"],
      quoted: {
        messageId: "q1",
        text: "question?",
        senderId: "1000@s.whatsapp.net",
        isFromBot: true,
      },
    });
    expect(m.quoted).toEqual({
      messageId: "q1",
      text: "question?",
      senderId: "1000@s.whatsapp.net",
      isFromBot: true,
    });
    expect(m.mentionsBot).toBe(true);
    expect(m.mentionedIds).toEqual(["1000@s.whatsapp.net"]);
  });

  it("rejects a body with no chat", () => {
    expect(() => inboundFromDebugBody({})).toThrow(/chatId is required/);
    expect(() => inboundFromDebugBody(null)).toThrow(/chatId is required/);
  });
});
