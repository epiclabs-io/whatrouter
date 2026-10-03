/**
 * `InboundMessage` -> the relay `event` object consumed by the Hermes gateway's
 * `_event_from_wire`. Field names and shape follow the upstream Hermes relay
 * connector contract.
 *
 * `media_urls` and `media[]` are present only when there is media, and
 * `media[i].url` MUST also appear in `media_urls`; the gateway resolves the MIME
 * type by URL lookup rather than by position.
 */
import { digitsOf } from "../whatsapp/jid.js";
import { isCommandText } from "./relevance.js";
import type { RelayEvent, RelayMediaItem, RelayMessageType } from "../relay/frames.js";
import type { InboundMessage, MessageKind } from "../whatsapp/port.js";

/** A stored, re-hosted attachment: what the gateway will fetch back from us. */
export interface EventMedia {
  url: string;
  kind: RelayMediaItem["kind"];
  mime: string;
  size: number;
  filename?: string | undefined;
  caption?: string | undefined;
}

const MESSAGE_TYPE_BY_KIND: Record<Exclude<MessageKind, "text">, RelayMessageType> = {
  image: "photo",
  video: "video",
  voice: "voice",
  audio: "audio",
  document: "document",
  sticker: "sticker",
  location: "location",
  // Anything we could not classify still reaches the agent as plain text.
  other: "text",
};

export function messageTypeFor(m: InboundMessage): RelayMessageType {
  if (m.kind === "text") {
    return isCommandText(m.text) ? "command" : "text";
  }
  return MESSAGE_TYPE_BY_KIND[m.kind];
}

/** `34600000000@s.whatsapp.net` -> `34600000000`; keeps the JID if it has no digits. */
function authorOf(senderId: string): string {
  const digits = digitsOf(senderId);
  return digits === "" ? senderId : digits;
}

export function toRelayEvent(m: InboundMessage, media: EventMedia | null): RelayEvent {
  const mediaItem: RelayMediaItem | null =
    media === null
      ? null
      : {
          url: media.url,
          kind: media.kind,
          mime: media.mime,
          size: media.size,
          ...(media.filename === undefined || media.filename === ""
            ? {}
            : { filename: media.filename }),
          ...(media.caption === undefined || media.caption === ""
            ? {}
            : { caption: media.caption }),
        };

  return {
    text: m.text,
    message_type: messageTypeFor(m),
    message_id: m.messageId,
    reply_to_message_id: m.quoted === null ? null : m.quoted.messageId,
    reply_to:
      m.quoted === null
        ? null
        : {
            text: m.quoted.text,
            author: authorOf(m.quoted.senderId),
            is_own: m.quoted.isFromBot,
          },
    ...(mediaItem === null ? {} : { media_urls: [mediaItem.url], media: [mediaItem] }),
    source: {
      platform: "whatsapp",
      chat_id: m.chatId,
      chat_type: m.chatType,
      chat_name: m.chatName,
      user_id: m.senderId,
      user_name: m.senderName,
      thread_id: null,
      chat_topic: null,
      ...(m.senderIdAlt === null || m.senderIdAlt === "" ? {} : { user_id_alt: m.senderIdAlt }),
      ...(m.chatIdRaw === m.chatId || m.chatIdRaw === "" ? {} : { chat_id_alt: m.chatIdRaw }),
      message_id: m.messageId,
    },
  };
}
