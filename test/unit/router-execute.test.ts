/**
 * The router against the in-memory WhatsApp port and a real (temp-dir) store:
 * every op's result shape, the tenant check in both directions, and the three
 * ways `send_media` can resolve bytes.
 */
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRouter, mediaIdFromUrl, type Router } from "../../src/router/router.js";
import { createFakeWhatsAppPort, type FakeWhatsAppPort } from "../../src/whatsapp/fake.js";
import type { Config, ProfileConfig } from "../../src/config/schema.js";
import type { OutboundAction, RelayEvent } from "../../src/relay/frames.js";
import type { Store } from "../../src/store/db.js";
import type { WhatsAppPort } from "../../src/whatsapp/port.js";
import { silentLogger } from "../helpers/relay.js";
import { ALICE, BOB, CAROL, GROUP, inbound, routerConfig, tempStore } from "../helpers/router.js";

const MEDIA_BASE = "https://wr.example.com";

interface Harness {
  router: Router;
  wa: FakeWhatsAppPort;
  store: Store;
  config: Config;
  delivered: Array<{ profile: string; event: RelayEvent }>;
  a: ProfileConfig;
  b: ProfileConfig;
}

let dir: string;
let h: Harness;

function build(
  config: Config = routerConfig(),
  overrides: { whatsapp?: WhatsAppPort; fetchImpl?: typeof fetch } = {}
): Harness {
  const created = tempStore();
  dir = created.dir;
  const wa = createFakeWhatsAppPort();
  const delivered: Array<{ profile: string; event: RelayEvent }> = [];
  const router = createRouter({
    config,
    store: created.store,
    log: silentLogger(),
    whatsapp: overrides.whatsapp ?? wa,
    relay: {
      deliver(profile, event) {
        delivered.push({ profile, event });
        return "live";
      },
    },
    mediaUrlFor: (id) => `${MEDIA_BASE}/relay/media/${id}`,
    ...(overrides.fetchImpl === undefined ? {} : { fetchImpl: overrides.fetchImpl }),
  });
  const a = config.profiles.find((p) => p.name === "a");
  const b = config.profiles.find((p) => p.name === "b");
  if (a === undefined || b === undefined) {
    throw new Error("fixture needs profiles a and b");
  }
  return { router, wa, store: created.store, config, delivered, a, b };
}

const run = (profile: ProfileConfig, action: OutboundAction): ReturnType<Router["execute"]> =>
  h.router.execute(profile, action);

beforeEach(() => {
  h = build();
});

afterEach(() => {
  h.store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("execute: dispatch", () => {
  it("send returns the last message id and passes reply_to through", async () => {
    const result = await run(h.a, {
      op: "send",
      chat_id: ALICE,
      content: "hola",
      reply_to: "wa-1",
    });
    expect(result).toEqual({ success: true, message_id: "fake-1" });
    expect(h.wa.sent).toEqual([
      { kind: "text", chat: ALICE, text: "hola", replyTo: "wa-1", messageId: "fake-1" },
    ]);
  });

  it("refuses an empty send instead of poking WhatsApp", async () => {
    expect(await run(h.a, { op: "send", chat_id: ALICE, content: "" })).toEqual({
      success: false,
      error: "empty content",
    });
    expect(h.wa.sent).toEqual([]);
  });

  it("edit, delete and get_chat_info answer their documented shapes", async () => {
    expect(
      await run(h.a, { op: "edit", chat_id: ALICE, message_id: "wa-1", content: "fixed" })
    ).toEqual({ success: true });
    expect(await run(h.a, { op: "delete", chat_id: ALICE, message_id: "wa-1" })).toEqual({
      success: true,
    });
    h.wa.setChatName(ALICE, "Alice");
    expect(await run(h.a, { op: "get_chat_info", chat_id: ALICE })).toEqual({
      success: true,
      chat_info: { name: "Alice", type: "dm" },
    });
    expect(h.wa.sent.map((s) => s.kind)).toEqual(["edit", "delete", "chatInfo"]);
  });

  it('typing maps content:"" to paused and anything else to composing', async () => {
    expect(await run(h.a, { op: "typing", chat_id: ALICE })).toEqual({ success: true });
    await run(h.a, { op: "typing", chat_id: ALICE, content: "thinking" });
    await run(h.a, { op: "typing", chat_id: ALICE, content: "" });
    expect(h.wa.sent).toEqual([
      { kind: "typing", chat: ALICE, on: true },
      { kind: "typing", chat: ALICE, on: true },
      { kind: "typing", chat: ALICE, on: false },
    ]);
  });

  it("react sends the emoji, and an empty string to remove it", async () => {
    expect(
      await run(h.a, { op: "react", chat_id: ALICE, message_id: "wa-1", emoji: "👍" })
    ).toEqual({ success: true });
    await run(h.a, { op: "react", chat_id: ALICE, message_id: "wa-1", emoji: "👍", remove: true });
    expect(h.wa.sent).toEqual([
      { kind: "react", chat: ALICE, messageId: "wa-1", emoji: "👍" },
      { kind: "react", chat: ALICE, messageId: "wa-1", emoji: "" },
    ]);
  });

  it("requires the ids an op cannot work without", async () => {
    expect(await run(h.a, { op: "send", chat_id: "", content: "x" })).toEqual({
      success: false,
      error: "missing chat_id",
    });
    expect(await run(h.a, { op: "edit", chat_id: ALICE, message_id: "", content: "x" })).toEqual({
      success: false,
      error: "missing message_id",
    });
  });

  it("answers an op we do not implement without touching the route table", async () => {
    expect(await run(h.a, { op: "thread_create", chat_id: "whatever" })).toEqual({
      success: false,
      error: "unsupported op: thread_create",
    });
    expect(await run(h.a, { op: "" } as unknown as OutboundAction)).toEqual({
      success: false,
      error: "unsupported op: ",
    });
  });

  it("turns an adapter that throws into a structured failure", async () => {
    h.store.close();
    rmSync(dir, { recursive: true, force: true });
    const exploding: WhatsAppPort = {
      ...createFakeWhatsAppPort(),
      async sendText(): Promise<{ messageId: string }> {
        throw new Error("socket exploded");
      },
    };
    h = build(routerConfig(), { whatsapp: exploding });
    expect(await run(h.a, { op: "send", chat_id: ALICE, content: "hola" })).toEqual({
      success: false,
      error: "socket exploded",
    });
  });
});

describe("execute: tenant check", () => {
  it("refuses a chat routed to another profile, in both directions", async () => {
    expect(await run(h.b, { op: "send", chat_id: ALICE, content: "hola" })).toEqual({
      success: false,
      error: "chat not routed to this profile",
    });
    expect(await run(h.a, { op: "send", chat_id: BOB, content: "hola" })).toEqual({
      success: false,
      error: "chat not routed to this profile",
    });
    expect(h.wa.sent).toEqual([]);
  });

  it("refuses a chat nobody is routed to", async () => {
    expect(await run(h.a, { op: "typing", chat_id: CAROL })).toEqual({
      success: false,
      error: "chat not routed to this profile",
    });
  });

  it("accepts a chat the profile actually received (default_profile)", async () => {
    h.store.close();
    rmSync(dir, { recursive: true, force: true });
    h = build(routerConfig({ defaultProfile: "b" }));
    await h.router.onInbound(inbound({ chatId: CAROL, senderId: CAROL }));
    expect(h.delivered[0]?.profile).toBe("b");
    expect(await run(h.b, { op: "send", chat_id: CAROL, content: "hola" })).toMatchObject({
      success: true,
    });
    expect(await run(h.a, { op: "send", chat_id: CAROL, content: "hola" })).toEqual({
      success: false,
      error: "chat not routed to this profile",
    });
  });

  it("allow_unrouted_outbound lifts the check", async () => {
    h.store.close();
    rmSync(dir, { recursive: true, force: true });
    h = build(routerConfig({ allowUnroutedOutbound: true }));
    expect(await run(h.b, { op: "send", chat_id: ALICE, content: "hola" })).toMatchObject({
      success: true,
    });
  });
});

describe("execute: send_media", () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xdb]);

  it("resolves bytes from our own media store", async () => {
    const { id } = h.store.media.put("a", bytes, "image/jpeg", "photo.jpg");
    const result = await run(h.a, {
      op: "send_media",
      chat_id: ALICE,
      media_kind: "image",
      source_url: `${MEDIA_BASE}/relay/media/${id}`,
      content: "here you go",
    });
    expect(result).toEqual({ success: true, message_id: "fake-1" });
    const sent = h.wa.sent[0];
    expect(sent).toMatchObject({ kind: "media", chat: ALICE });
    expect(sent?.kind === "media" ? sent.media : null).toMatchObject({
      kind: "image",
      mime: "image/jpeg",
      filename: "photo.jpg",
      caption: "here you go",
    });
  });

  it('hides another profile\'s media behind "media not found"', async () => {
    const { id } = h.store.media.put("b", bytes, "image/jpeg", "photo.jpg");
    expect(
      await run(h.a, {
        op: "send_media",
        chat_id: ALICE,
        media_kind: "image",
        source_url: `${MEDIA_BASE}/relay/media/${id}`,
      })
    ).toEqual({ success: false, error: "media not found" });
    expect(
      await run(h.a, {
        op: "send_media",
        chat_id: ALICE,
        media_kind: "image",
        source_url: `${MEDIA_BASE}/relay/media/0123456789abcdef0123456789abcdef`,
      })
    ).toEqual({ success: false, error: "media not found" });
    expect(h.wa.sent).toEqual([]);
  });

  it("fetches a foreign URL and takes the mime from the response", async () => {
    h.store.close();
    rmSync(dir, { recursive: true, force: true });
    const fetchImpl = vi.fn(
      async () =>
        new Response(bytes, {
          headers: { "content-type": "image/png; charset=binary", "content-length": "4" },
        })
    );
    h = build(routerConfig(), { fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await run(h.a, {
      op: "send_media",
      chat_id: ALICE,
      media_kind: "image",
      source_url: "https://cdn.example.com/cat.png",
      filename: "cat.png",
    });
    expect(result).toEqual({ success: true, message_id: "fake-1" });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const sent = h.wa.sent[0];
    expect(sent?.kind === "media" ? sent.media : null).toMatchObject({
      mime: "image/png",
      filename: "cat.png",
    });
  });

  it("refuses a fetch that fails, is too large, or declares itself too large", async () => {
    h.store.close();
    rmSync(dir, { recursive: true, force: true });
    const responses = [
      new Response("nope", { status: 404 }),
      new Response(new Uint8Array(64), { headers: { "content-length": "64" } }),
      new Response(new Uint8Array(64)),
    ];
    const fetchImpl = vi.fn(async () => responses.shift() ?? new Response(null, { status: 500 }));
    const config = routerConfig();
    config.media.maxBytes = 16;
    h = build(config, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const send = async (): ReturnType<Router["execute"]> =>
      run(h.a, {
        op: "send_media",
        chat_id: ALICE,
        media_kind: "image",
        source_url: "https://cdn.example.com/big.png",
      });
    expect(await send()).toEqual({ success: false, error: "could not fetch media: HTTP 404" });
    expect(await send()).toEqual({ success: false, error: "media is larger than 16 bytes" });
    expect(await send()).toEqual({ success: false, error: "media is larger than 16 bytes" });
    expect(h.wa.sent).toEqual([]);
  });

  it("validates media_kind and source_url", async () => {
    expect(
      await run(h.a, {
        op: "send_media",
        chat_id: ALICE,
        media_kind: "hologram",
        source_url: "https://x/y",
      } as unknown as OutboundAction)
    ).toEqual({ success: false, error: "unsupported media_kind: hologram" });
    expect(
      await run(h.a, {
        op: "send_media",
        chat_id: ALICE,
        media_kind: "image",
        source_url: "",
      })
    ).toEqual({ success: false, error: "missing source_url" });
  });

  it("is tenant-checked like every other op", async () => {
    const { id } = h.store.media.put("b", bytes, "image/jpeg", null);
    expect(
      await run(h.b, {
        op: "send_media",
        chat_id: ALICE,
        media_kind: "image",
        source_url: `${MEDIA_BASE}/relay/media/${id}`,
      })
    ).toEqual({ success: false, error: "chat not routed to this profile" });
  });
});

describe("mediaIdFromUrl", () => {
  it("extracts the id from our own URLs only", () => {
    expect(mediaIdFromUrl("https://wr.example.com/relay/media/abc")).toBe("abc");
    expect(mediaIdFromUrl("http://localhost:8466/relay/media/abc?x=1#y")).toBe("abc");
    expect(mediaIdFromUrl("https://cdn.example.com/cat.png")).toBeNull();
    expect(mediaIdFromUrl("https://wr.example.com/relay/media/")).toBeNull();
  });
});

describe("onInbound", () => {
  it("delivers a routed DM and remembers the chat", async () => {
    await h.router.onInbound(inbound());
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]?.profile).toBe("a");
    expect(h.delivered[0]?.event.text).toBe("hola");
    expect(h.router.table.rememberedProfile(ALICE)).toBe("a");
  });

  it("drops an unrouted chat without throwing", async () => {
    await h.router.onInbound(inbound({ chatId: CAROL, senderId: CAROL }));
    expect(h.delivered).toEqual([]);
  });

  it("applies the relevance gate before delivering", async () => {
    await h.router.onInbound(
      inbound({ chatId: GROUP, chatIdRaw: GROUP, chatType: "group", text: "chatter" })
    );
    expect(h.delivered).toEqual([]);
    await h.router.onInbound(
      inbound({
        chatId: GROUP,
        chatIdRaw: GROUP,
        chatType: "group",
        text: "@bot hi",
        mentionsBot: true,
      })
    );
    expect(h.delivered).toHaveLength(1);
  });

  it("honours a gateway policy that turns addressing off", async () => {
    h.store.policy.set("a", { platform: "whatsapp", requireAddress: false });
    await h.router.onInbound(
      inbound({ chatId: GROUP, chatIdRaw: GROUP, chatType: "group", text: "chatter" })
    );
    expect(h.delivered).toHaveLength(1);
  });

  it("re-hosts inbound media and puts the URL in the event", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    await h.router.onInbound(
      inbound({
        kind: "image",
        text: "a cat",
        media: {
          kind: "image",
          mime: "image/jpeg",
          bytes,
          size: 3,
          filename: "cat.jpg",
          caption: "a cat",
        },
      })
    );
    const event = h.delivered[0]?.event;
    expect(event?.message_type).toBe("photo");
    const url = event?.media_urls?.[0] ?? "";
    expect(url.startsWith(`${MEDIA_BASE}/relay/media/`)).toBe(true);
    expect(event?.media?.[0]).toMatchObject({ url, mime: "image/jpeg", size: 3, kind: "image" });
    const id = mediaIdFromUrl(url) ?? "";
    expect(h.store.media.getMeta(id)?.profile).toBe("a");
    expect(h.store.media.get(id)?.bytes.equals(Buffer.from(bytes))).toBe(true);
  });

  it("still delivers the message when the media cannot be stored", async () => {
    const created = tempStore();
    // A full disk (or a too-large attachment) degrades the message, never drops it.
    vi.spyOn(created.store.media, "put").mockImplementation(() => {
      throw new Error("disk full");
    });
    const delivered: RelayEvent[] = [];
    const router = createRouter({
      config: h.config,
      store: created.store,
      log: silentLogger(),
      whatsapp: createFakeWhatsAppPort(),
      relay: {
        deliver(_profile, event) {
          delivered.push(event);
          return "live";
        },
      },
      mediaUrlFor: (id) => `${MEDIA_BASE}/relay/media/${id}`,
    });
    await router.onInbound(
      inbound({
        kind: "image",
        text: "a cat",
        media: { kind: "image", mime: "image/jpeg", bytes: new Uint8Array(2), size: 2 },
      })
    );
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.message_type).toBe("photo");
    expect(delivered[0]).not.toHaveProperty("media_urls");
    created.store.close();
    rmSync(created.dir, { recursive: true, force: true });
  });

  it("never throws when the relay does", async () => {
    const created = tempStore();
    const router = createRouter({
      config: h.config,
      store: created.store,
      log: silentLogger(),
      whatsapp: createFakeWhatsAppPort(),
      relay: {
        deliver() {
          throw new Error("relay is on fire");
        },
      },
      mediaUrlFor: (id) => `${MEDIA_BASE}/relay/media/${id}`,
    });
    await expect(router.onInbound(inbound())).resolves.toBeUndefined();
    created.store.close();
    rmSync(created.dir, { recursive: true, force: true });
  });
});
