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
import type { PublicFetchOptions, PublicFetchResult } from "../../src/util/public-fetch.js";
import { MediaTooLargeError } from "../../src/store/media.js";
import type { GroupMetadata, InboundMessage, WhatsAppPort } from "../../src/whatsapp/port.js";
import { silentLogger } from "../helpers/relay.js";
import {
  ALICE,
  BOB,
  CAROL,
  GROUP,
  ROGUE,
  dmRoute,
  inbound,
  inboundMedia,
  profileWith,
  routerConfig,
  tempStore,
} from "../helpers/router.js";

const MEDIA_BASE = "https://wr.example.com";

/** The registered group, addressed to the bot, with no adapter-supplied name. */
const groupMention = (): InboundMessage =>
  inbound({ chatId: GROUP, chatIdRaw: GROUP, chatType: "group", mentionsBot: true, chatName: "" });

/** Just enough `GroupMetadata` for a `getGroupMetadata` stub. */
function groupMeta(id: string, subject: string): GroupMetadata {
  return {
    id,
    subject,
    description: null,
    owner: null,
    participants: [],
    size: 0,
    inviteCode: null,
    announcement: false,
    restrict: false,
    ephemeralDuration: 0,
    memberAddMode: "all",
    joinApprovalMode: false,
  };
}

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
  overrides: {
    whatsapp?: WhatsAppPort;
    fetchMedia?: (url: string, opts: PublicFetchOptions) => Promise<PublicFetchResult>;
    getConfig?: () => Config;
  } = {}
): Harness {
  // The store's cap is a boot-time value, so it has to come from the config the
  // router is being built with.
  const created = tempStore(config.media.maxBytes);
  dir = created.dir;
  const wa = createFakeWhatsAppPort();
  const delivered: Array<{ profile: string; event: RelayEvent }> = [];
  const router = createRouter({
    getConfig: overrides.getConfig ?? ((): Config => config),
    maxMediaBytes: config.media.maxBytes,
    allowUnroutedOutbound: config.allowUnroutedOutbound,
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
    ...(overrides.fetchMedia === undefined ? {} : { fetchMedia: overrides.fetchMedia }),
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

  it("never allows outbound to an unregistered group, even with a route or override", async () => {
    h.store.close();
    rmSync(dir, { recursive: true, force: true });
    h = build(routerConfig({ groups: {}, allowUnroutedOutbound: true }));
    expect(await run(h.a, { op: "send", chat_id: GROUP, content: "hola" })).toEqual({
      success: false,
      error: "group is not registered",
    });
    expect(h.wa.sent).toEqual([]);
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
    const fetchMedia = vi.fn(async (): Promise<PublicFetchResult> => ({
      ok: true,
      bytes,
      mime: "image/png",
    }));
    h = build(routerConfig(), { fetchMedia });
    const result = await run(h.a, {
      op: "send_media",
      chat_id: ALICE,
      media_kind: "image",
      source_url: "https://cdn.example.com/cat.png",
      filename: "cat.png",
    });
    expect(result).toEqual({ success: true, message_id: "fake-1" });
    // The cap and the timeout are the router's to set, and it passes them on.
    expect(fetchMedia).toHaveBeenCalledOnce();
    expect(fetchMedia.mock.calls[0]).toEqual([
      "https://cdn.example.com/cat.png",
      { maxBytes: routerConfig().media.maxBytes, timeoutMs: 30_000 },
    ]);
    const sent = h.wa.sent[0];
    expect(sent?.kind === "media" ? sent.media : null).toMatchObject({
      mime: "image/png",
      filename: "cat.png",
    });
  });

  it("passes a fetch failure straight back to the agent", async () => {
    h.store.close();
    rmSync(dir, { recursive: true, force: true });
    const errors = [
      "could not fetch media: HTTP 404",
      "media is larger than 16 bytes",
      "source_url not allowed",
    ];
    const config = routerConfig();
    config.media.maxBytes = 16;
    const fetchMedia = vi.fn(async (): Promise<PublicFetchResult> => ({
      ok: false,
      error: errors.shift() ?? "gone",
    }));
    h = build(config, { fetchMedia });
    const send = async (): ReturnType<Router["execute"]> =>
      run(h.a, {
        op: "send_media",
        chat_id: ALICE,
        media_kind: "image",
        source_url: "https://cdn.example.com/big.png",
      });
    expect(await send()).toEqual({ success: false, error: "could not fetch media: HTTP 404" });
    expect(await send()).toEqual({ success: false, error: "media is larger than 16 bytes" });
    expect(await send()).toEqual({ success: false, error: "source_url not allowed" });
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

  it("refuses a source_url that resolves to a private or metadata address", async () => {
    // No fetchMedia seam: this goes through the real fetchPublic, which must
    // refuse the address before dialling it (D1).
    for (const source_url of [
      "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
      "http://127.0.0.1:8466/healthz",
      "http://10.0.0.5/internal.png",
      "http://192.168.1.10/camera.jpg",
      "http://[::1]:9000/x.png",
      "file:///etc/passwd",
    ]) {
      expect(
        await run(h.a, { op: "send_media", chat_id: ALICE, media_kind: "image", source_url })
      ).toEqual({ success: false, error: "source_url not allowed" });
    }
    expect(h.wa.sent).toEqual([]);
  });

  it("still sends a WhatRouter media url without touching the network", async () => {
    const { id } = h.store.media.put("a", bytes, "image/jpeg", null);
    const result = await run(h.a, {
      op: "send_media",
      chat_id: ALICE,
      media_kind: "image",
      source_url: `${MEDIA_BASE}/relay/media/${id}`,
    });
    expect(result).toEqual({ success: true, message_id: "fake-1" });
    const sent = h.wa.sent[0];
    expect(sent?.kind === "media" ? Buffer.from(sent.media.bytes) : null).toEqual(
      Buffer.from(bytes)
    );
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

  it("drops a routed group that is not registered", async () => {
    h.store.close();
    rmSync(dir, { recursive: true, force: true });
    h = build(routerConfig({ groups: {} }));
    await h.router.onInbound(
      inbound({ chatId: GROUP, chatType: "group", mentionsBot: true, media: null })
    );
    expect(h.delivered).toEqual([]);
  });

  it("drops a registered group that has no route", async () => {
    h.store.close();
    rmSync(dir, { recursive: true, force: true });
    const config = routerConfig();
    config.profiles[0] = profileWith("a", [dmRoute(ALICE)]);
    h = build(config);
    await h.router.onInbound(
      inbound({ chatId: GROUP, chatType: "group", mentionsBot: true, media: null })
    );
    expect(h.delivered).toEqual([]);
  });

  it("applies wildcard, empty, and explicit group listen lists before relevance", async () => {
    const message = inbound({
      chatId: GROUP,
      chatType: "group",
      senderId: ALICE,
      mentionsBot: true,
    });
    await h.router.onInbound(message);
    expect(h.delivered).toHaveLength(1);

    h.config.groups[GROUP]!.listen = [];
    await h.router.onInbound(message);
    expect(h.delivered).toHaveLength(1);

    h.config.groups[GROUP]!.listen = [BOB];
    await h.router.onInbound(message);
    expect(h.delivered).toHaveLength(1);

    h.config.groups[GROUP]!.listen = [ALICE];
    await h.router.onInbound(message);
    expect(h.delivered).toHaveLength(2);
  });

  it("canonicalizes the inbound group id before checking registration", async () => {
    await h.router.onInbound(
      inbound({ chatId: GROUP.replace("@g.us", "@G.US"), chatType: "group", mentionsBot: true })
    );
    expect(h.delivered).toHaveLength(1);
  });

  it("matches explicit group listeners through PN, LID, and alternate ids", async () => {
    const group = h.config.groups[GROUP]!;
    group.listen = [ALICE];
    await h.router.onInbound(
      inbound({ chatId: GROUP, chatType: "group", senderId: ALICE, mentionsBot: true })
    );
    await h.router.onInbound(
      inbound({
        chatId: GROUP,
        chatType: "group",
        senderId: "777888999@lid",
        senderIdAlt: ALICE,
        mentionsBot: true,
      })
    );
    group.listen = ["777888999@lid"];
    await h.router.onInbound(
      inbound({
        chatId: GROUP,
        chatType: "group",
        senderId: ALICE,
        senderIdAlt: "777888999@lid",
        mentionsBot: true,
      })
    );
    expect(h.delivered).toHaveLength(3);
  });

  it("uses a replacement config for inbound, outbound, and table exposure", async () => {
    h.store.close();
    rmSync(dir, { recursive: true, force: true });
    let liveConfig = routerConfig();
    h = build(liveConfig, { getConfig: () => liveConfig });
    const oldTable = h.router.table;
    oldTable.remember(CAROL, "a");

    liveConfig = routerConfig({
      profiles: [profileWith("a", [dmRoute(CAROL)]), profileWith("b", [dmRoute(BOB)])],
    });

    expect(h.router.table).not.toBe(oldTable);
    expect(h.router.table.has(ALICE)).toBe(false);
    expect(h.router.table.has(CAROL)).toBe(true);
    expect(await run(h.a, { op: "send", chat_id: ALICE, content: "old" })).toEqual({
      success: false,
      error: "chat not routed to this profile",
    });
    expect(await run(h.a, { op: "send", chat_id: CAROL, content: "new" })).toMatchObject({
      success: true,
    });
    await h.router.onInbound(inbound({ chatId: ALICE, senderId: ALICE }));
    await h.router.onInbound(inbound({ chatId: CAROL, senderId: CAROL }));
    expect(h.delivered.map((delivery) => delivery.event.source.chat_id)).toEqual([CAROL]);
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
          declaredSize: bytes.byteLength,
          download: async () => bytes,
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
      getConfig: (): Config => h.config,
      maxMediaBytes: h.config.media.maxBytes,
      allowUnroutedOutbound: h.config.allowUnroutedOutbound,
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
        media: {
          kind: "image",
          mime: "image/jpeg",
          declaredSize: 2,
          download: async () => new Uint8Array(2),
        },
      })
    );
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.message_type).toBe("photo");
    expect(delivered[0]).not.toHaveProperty("media_urls");
    created.store.close();
    rmSync(created.dir, { recursive: true, force: true });
  });

  it("never downloads media and never asks WhatsApp for a subject before the gates pass", async () => {
    const wa = createFakeWhatsAppPort();
    const metadata = vi.spyOn(wa, "getGroupMetadata");
    h.store.close();
    rmSync(dir, { recursive: true, force: true });
    h = build(routerConfig(), { whatsapp: wa });

    // A rogue group: one that is not in the registry at all, so the gate drops it
    // before routing, media or buffering.
    const rogue = inboundMedia();
    await h.router.onInbound(
      inbound({
        chatId: ROGUE,
        chatIdRaw: ROGUE,
        chatType: "group",
        mentionsBot: true,
        kind: "image",
        media: rogue.media,
      })
    );
    // An unrouted DM.
    const unrouted = inboundMedia();
    await h.router.onInbound(
      inbound({ chatId: CAROL, senderId: CAROL, kind: "image", media: unrouted.media })
    );
    // A registered group whose message is not addressed to the bot.
    const chatter = inboundMedia();
    await h.router.onInbound(
      inbound({
        chatId: GROUP,
        chatIdRaw: GROUP,
        chatType: "group",
        text: "chatter",
        kind: "image",
        media: chatter.media,
      })
    );
    // A registered group the sender is not allowed to speak for.
    h.config.groups[GROUP]!.listen = [BOB];
    const muted = inboundMedia();
    await h.router.onInbound(
      inbound({
        chatId: GROUP,
        chatIdRaw: GROUP,
        chatType: "group",
        senderId: ALICE,
        mentionsBot: true,
        kind: "image",
        media: muted.media,
      })
    );

    expect(h.delivered).toEqual([]);
    expect(rogue.calls).toEqual([]);
    expect(unrouted.calls).toEqual([]);
    expect(chatter.calls).toEqual([]);
    expect(muted.calls).toEqual([]);
    expect(metadata).not.toHaveBeenCalled();
  });

  it("takes a group's name from the registry without asking WhatsApp", async () => {
    const wa = createFakeWhatsAppPort();
    const metadata = vi.spyOn(wa, "getGroupMetadata");
    h.store.close();
    rmSync(dir, { recursive: true, force: true });
    h = build(routerConfig(), { whatsapp: wa });
    // routerConfig registers the group with displayName "Team".
    expect(h.config.groups[GROUP]!.displayName).toBe("Team");

    await h.router.onInbound(
      inbound({ chatId: GROUP, chatType: "group", mentionsBot: true, chatName: "" })
    );
    expect(h.delivered[0]?.event.source.chat_name).toBe("Team");
    expect(metadata).not.toHaveBeenCalled();
  });

  it("asks the port for the subject on every message, so a rename shows up", async () => {
    const wa = createFakeWhatsAppPort();
    h.store.close();
    rmSync(dir, { recursive: true, force: true });
    h = build(routerConfig(), { whatsapp: wa });
    // No display_name: the live subject is worth a metadata call.
    h.config.groups[GROUP]!.displayName = null;
    const metadata = vi
      .spyOn(wa, "getGroupMetadata")
      .mockResolvedValue(groupMeta(GROUP, "Weekend plans"));

    await h.router.onInbound(groupMention());
    expect(metadata).toHaveBeenCalledExactlyOnceWith(GROUP);
    expect(h.delivered[0]?.event.source.chat_name).toBe("Weekend plans");

    // Caching is the port's job, so the router asks again every time — and
    // picks up a rename instead of serving a stale name for five minutes.
    h.delivered.length = 0;
    metadata.mockResolvedValue(groupMeta(GROUP, "Weekend plans (moved)"));
    await h.router.onInbound(groupMention());
    expect(metadata).toHaveBeenCalledTimes(2);
    expect(h.delivered[0]?.event.source.chat_name).toBe("Weekend plans (moved)");
  });

  it("falls back to the group's digits when there is no subject", async () => {
    const wa = createFakeWhatsAppPort();
    h.store.close();
    rmSync(dir, { recursive: true, force: true });
    h = build(routerConfig(), { whatsapp: wa });
    h.config.groups[GROUP]!.displayName = null;
    const metadata = vi.spyOn(wa, "getGroupMetadata").mockResolvedValue(groupMeta(GROUP, "   "));

    await h.router.onInbound(groupMention());
    expect(metadata).toHaveBeenCalledOnce();
    expect(h.delivered[0]?.event.source.chat_name).toBe("120363000000000001");
  });

  it("delivers the message even when the subject lookup fails", async () => {
    const wa = createFakeWhatsAppPort();
    h.store.close();
    rmSync(dir, { recursive: true, force: true });
    h = build(routerConfig(), { whatsapp: wa });
    h.config.groups[GROUP]!.displayName = null;
    const metadata = vi.spyOn(wa, "getGroupMetadata").mockRejectedValue(new Error("no metadata"));

    await h.router.onInbound(groupMention());
    expect(metadata).toHaveBeenCalledOnce();
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]?.event.source.chat_name).toBe("120363000000000001");

    // A failure is not cached, so the next message tries again.
    h.delivered.length = 0;
    await h.router.onInbound(groupMention());
    expect(metadata).toHaveBeenCalledTimes(2);
  });

  it("refuses an oversized declared size without downloading it", async () => {
    const cap = 1024;
    const config = routerConfig();
    config.media.maxBytes = cap;
    h.store.close();
    rmSync(dir, { recursive: true, force: true });
    h = build(config);

    const big = inboundMedia({ declaredSize: cap + 1 });
    await h.router.onInbound(inbound({ kind: "image", text: "a cat", media: big.media }));

    expect(big.calls).toEqual([]);
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]?.event.text).toBe("a cat\n[image too large to forward]");
    expect(h.delivered[0]).not.toHaveProperty("media_urls");
  });

  it("aborts a stream that crosses the cap and says so in the text", async () => {
    const cap = 16;
    const config = routerConfig();
    config.media.maxBytes = cap;
    h.store.close();
    rmSync(dir, { recursive: true, force: true });
    h = build(config);

    // The declared size lied; the stream is what actually overruns.
    let aborted = false;
    const overrunning = inboundMedia({
      declaredSize: 4,
      behaviour: async (maxBytes) => {
        const chunk = new Uint8Array(maxBytes * 4);
        if (chunk.byteLength > maxBytes) {
          aborted = true;
        }
        throw new MediaTooLargeError(chunk.byteLength, maxBytes);
      },
    });
    await h.router.onInbound(inbound({ kind: "image", text: "a cat", media: overrunning.media }));

    expect(overrunning.calls).toEqual([cap]);
    expect(aborted).toBe(true);
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]?.event.text).toBe("a cat\n[image too large to forward]");
    expect(h.delivered[0]).not.toHaveProperty("media_urls");
  });

  it("delivers the message with the old wording when the download fails outright", async () => {
    const failing = inboundMedia({
      behaviour: async () => {
        throw new Error("socket hang up");
      },
    });
    await h.router.onInbound(inbound({ kind: "image", text: "a cat", media: failing.media }));
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]?.event.text).toBe("a cat\n[image could not be downloaded]");
    expect(h.delivered[0]?.event.message_type).toBe("photo");
  });

  it("downloads a normal image once, with the boot cap, and stores it", async () => {
    const cap = 4096;
    const config = routerConfig();
    config.media.maxBytes = cap;
    h.store.close();
    rmSync(dir, { recursive: true, force: true });
    h = build(config);

    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const normal = inboundMedia({ bytes, declaredSize: bytes.byteLength });
    await h.router.onInbound(inbound({ kind: "image", text: "a cat", media: normal.media }));

    expect(normal.calls).toEqual([cap]);
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]?.event.text).toBe("a cat");
    expect(h.delivered[0]?.event.media?.[0]).toMatchObject({ kind: "image", mime: "image/jpeg" });
    const id = mediaIdFromUrl(h.delivered[0]?.event.media_urls?.[0] ?? "") ?? "";
    expect(h.store.media.get(id)?.bytes.equals(Buffer.from(bytes))).toBe(true);
  });

  it("never throws when the relay does", async () => {
    const created = tempStore();
    const router = createRouter({
      getConfig: (): Config => h.config,
      maxMediaBytes: h.config.media.maxBytes,
      allowUnroutedOutbound: h.config.allowUnroutedOutbound,
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
