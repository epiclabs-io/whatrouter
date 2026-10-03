/**
 * The wire shape is a contract with the gateway's `_event_from_wire`, so these
 * are whole-object comparisons over the JSON we would actually send, not
 * field-by-field spot checks: an extra or missing key fails the test.
 */
import { describe, expect, it } from "vitest";
import { messageTypeFor, toRelayEvent, type EventMedia } from "../../src/router/event.js";
import type { RelayEvent } from "../../src/relay/frames.js";
import type { MessageKind } from "../../src/whatsapp/port.js";
import { ALICE, GROUP, inbound } from "../helpers/router.js";

/** What the gateway would actually parse (drops undefined-valued keys). */
function wire(event: RelayEvent): unknown {
  return JSON.parse(JSON.stringify(event));
}

describe("toRelayEvent", () => {
  it("builds the documented shape for a plain DM", () => {
    const event = toRelayEvent(inbound(), null);
    expect(wire(event)).toEqual({
      text: "hola",
      message_type: "text",
      message_id: "wa-1",
      reply_to_message_id: null,
      reply_to: null,
      source: {
        platform: "whatsapp",
        chat_id: ALICE,
        chat_type: "dm",
        chat_name: "Alice",
        user_id: ALICE,
        user_name: "Alice",
        thread_id: null,
        chat_topic: null,
        message_id: "wa-1",
      },
    });
    expect("media_urls" in event).toBe(false);
    expect("media" in event).toBe(false);
    expect("user_id_alt" in event.source).toBe(false);
    expect("chat_id_alt" in event.source).toBe(false);
  });

  it("carries both id forms when they differ", () => {
    const m = inbound({
      chatId: ALICE,
      chatIdRaw: "777888999@lid",
      senderId: ALICE,
      senderIdAlt: "777888999@lid",
    });
    expect(wire(toRelayEvent(m, null))).toMatchObject({
      source: { user_id_alt: "777888999@lid", chat_id_alt: "777888999@lid" },
    });
  });

  it("builds a group photo with caption, media and a quote", () => {
    const media: EventMedia = {
      url: "https://wr.example.com/relay/media/0123456789abcdef0123456789abcdef",
      kind: "image",
      mime: "image/jpeg",
      size: 4,
      filename: "photo.jpg",
      caption: "look at this",
    };
    const m = inbound({
      messageId: "wa-7",
      chatId: GROUP,
      chatIdRaw: GROUP,
      chatType: "group",
      chatName: "Team WhatRouter",
      senderId: ALICE,
      senderIdAlt: "777888999@lid",
      senderName: "Alice",
      text: "look at this",
      kind: "image",
      mentionsBot: true,
      mentionedIds: ["1000@s.whatsapp.net"],
      quoted: {
        messageId: "wa-6",
        text: "previous",
        senderId: "1000@s.whatsapp.net",
        isFromBot: true,
      },
      media: {
        kind: "image",
        mime: "image/jpeg",
        declaredSize: 4,
        download: async () => new Uint8Array([1, 2, 3, 4]),
        filename: "photo.jpg",
        caption: "look at this",
      },
    });

    expect(wire(toRelayEvent(m, media))).toEqual({
      text: "look at this",
      message_type: "photo",
      message_id: "wa-7",
      reply_to_message_id: "wa-6",
      reply_to: { text: "previous", author: "1000", is_own: true },
      media_urls: ["https://wr.example.com/relay/media/0123456789abcdef0123456789abcdef"],
      media: [
        {
          url: "https://wr.example.com/relay/media/0123456789abcdef0123456789abcdef",
          kind: "image",
          mime: "image/jpeg",
          size: 4,
          filename: "photo.jpg",
          caption: "look at this",
        },
      ],
      source: {
        platform: "whatsapp",
        chat_id: GROUP,
        chat_type: "group",
        chat_name: "Team WhatRouter",
        user_id: ALICE,
        user_name: "Alice",
        thread_id: null,
        chat_topic: null,
        user_id_alt: "777888999@lid",
        message_id: "wa-7",
      },
    });
  });

  it("marks a slash command as such", () => {
    const event = toRelayEvent(inbound({ messageId: "wa-9", text: "/help me" }), null);
    expect(wire(event)).toEqual({
      text: "/help me",
      message_type: "command",
      message_id: "wa-9",
      reply_to_message_id: null,
      reply_to: null,
      source: {
        platform: "whatsapp",
        chat_id: ALICE,
        chat_type: "dm",
        chat_name: "Alice",
        user_id: ALICE,
        user_name: "Alice",
        thread_id: null,
        chat_topic: null,
        message_id: "wa-9",
      },
    });
  });

  it("keeps every media[i].url present in media_urls", () => {
    const media: EventMedia = {
      url: "http://localhost:8466/relay/media/aaaa",
      kind: "voice",
      mime: "audio/ogg; codecs=opus",
      size: 9,
    };
    const event = toRelayEvent(inbound({ kind: "voice", text: "" }), media);
    expect(event.media_urls).toEqual([media.url]);
    expect(event.media?.[0]?.url).toBe(media.url);
    expect(event.media?.[0]).not.toHaveProperty("filename");
    expect(event.media?.[0]).not.toHaveProperty("caption");
  });

  it("uses the quoted sender digits as the author, or the raw id", () => {
    const digits = toRelayEvent(
      inbound({ quoted: { messageId: "q", text: "t", senderId: ALICE, isFromBot: false } }),
      null
    );
    expect(digits.reply_to?.author).toBe("34600000001");
    const raw = toRelayEvent(
      inbound({ quoted: { messageId: "q", text: "t", senderId: "weird", isFromBot: false } }),
      null
    );
    expect(raw.reply_to?.author).toBe("weird");
  });
});

describe("messageTypeFor", () => {
  const cases: Array<[MessageKind, string, string]> = [
    ["text", "hola", "text"],
    ["text", "/start", "command"],
    ["text", "  /start", "command"],
    ["image", "", "photo"],
    ["video", "", "video"],
    ["voice", "", "voice"],
    ["audio", "", "audio"],
    ["document", "", "document"],
    ["sticker", "", "sticker"],
    ["location", "", "location"],
    ["other", "", "text"],
  ];

  it.each(cases)("maps %s / %j to %s", (kind, text, expected) => {
    expect(messageTypeFor(inbound({ kind, text }))).toBe(expected);
  });

  it("does not turn a captioned photo into a command", () => {
    expect(messageTypeFor(inbound({ kind: "image", text: "/not-a-command" }))).toBe("photo");
  });
});
