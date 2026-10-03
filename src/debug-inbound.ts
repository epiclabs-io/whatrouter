/**
 * `POST /debug/inbound`: inject a message as if WhatsApp had delivered it.
 *
 * Mounted only in fake mode (`WHATROUTER_FAKE_WHATSAPP=1`), and never in a
 * production build. It exists so the router, the buffer and the relay wire can be
 * exercised end to end without a phone, which is why it takes the message as
 * JSON rather than talking to the port.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody, sendJson, type HttpRoute } from "./http/server.js";
import { canonicalChatId } from "./router/routes.js";
import { MediaTooLargeError } from "./store/media.js";
import { digitsOf, isGroupJid, normalizeJid } from "./whatsapp/jid.js";
import type {
  ChatType,
  InboundMedia,
  InboundMessage,
  MediaKind,
  MessageKind,
  QuotedMessage,
} from "./whatsapp/port.js";
import type { Logger } from "./util/log.js";

/** The policy document is small; nothing larger is a debug injection. */
const JSON_BODY_LIMIT = 1_048_576;

/** Builds the route for a fake port's injector. */
export function debugInboundRoute(
  inject: (message: InboundMessage) => Promise<void>,
  log: Logger
): HttpRoute {
  return {
    method: "POST",
    path: "/debug/inbound",
    async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const body = await readBody(req, JSON_BODY_LIMIT);
      if (!body.ok) {
        sendJson(res, 413, { error: "payload too large" });
        return;
      }
      let parsed: unknown;
      try {
        parsed = body.body.byteLength === 0 ? {} : JSON.parse(body.body.toString("utf8"));
      } catch {
        sendJson(res, 400, { error: "invalid json" });
        return;
      }
      try {
        await inject(inboundFromDebugBody(parsed));
        sendJson(res, 200, {});
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err: message }, "debug inbound failed");
        sendJson(res, 500, { error: message });
      }
    },
  };
}

const MESSAGE_KINDS = new Set<string>([
  "text",
  "image",
  "video",
  "voice",
  "audio",
  "document",
  "sticker",
  "location",
  "other",
]);
const MEDIA_KINDS = new Set<string>(["image", "video", "voice", "audio", "document", "sticker"]);

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function mediaKindFor(kind: string | undefined, mime: string): MediaKind {
  if (kind !== undefined && MEDIA_KINDS.has(kind)) {
    return kind as MediaKind;
  }
  if (mime.startsWith("image/")) {
    return "image";
  }
  if (mime.startsWith("video/")) {
    return "video";
  }
  if (mime.startsWith("audio/")) {
    return "audio";
  }
  return "document";
}

/**
 * Turns the tiny `POST /debug/inbound` body into a full `InboundMessage`.
 *
 * ```jsonc
 * {
 *   "chatId": "34600000001@s.whatsapp.net",   // required
 *   "text": "hola",                            // default ""
 *   "chatType": "dm" | "group",               // default: inferred from chatId
 *   "senderId": "…", "senderIdAlt": "…",      // default: chatId / null
 *   "senderName": "…", "chatName": "…",       // default: the id's digits
 *   "messageId": "…",                          // default: debug-<n>
 *   "mentionsBot": false, "mentionedIds": [],
 *   "quoted": {"messageId","text","senderId","isFromBot"},
 *   "kind": "text|image|…",                    // default: from the media, else text
 *   "mediaBase64": "…", "mediaMime": "…", "mediaFilename": "…", "mediaCaption": "…",
 *   "timestamp": 1758000000
 * }
 * ```
 */
let debugCounter = 0;

export function inboundFromDebugBody(body: unknown): InboundMessage {
  const raw = asRecord(body);

  const chatIdRaw = optionalString(raw["chatId"]);
  if (chatIdRaw === undefined) {
    throw new Error("chatId is required");
  }
  // `+34600000001`, `34600000001` and `…@s.whatsapp.net` all land on the same id.
  const chatId = canonicalChatId(chatIdRaw);

  const chatTypeRaw = optionalString(raw["chatType"]);
  const chatType: ChatType =
    chatTypeRaw === "group" || chatTypeRaw === "dm"
      ? chatTypeRaw
      : isGroupJid(chatId)
        ? "group"
        : "dm";

  const senderId = canonicalChatId(optionalString(raw["senderId"]) ?? chatId);
  const senderIdAltRaw = optionalString(raw["senderIdAlt"]);
  const senderIdAlt = senderIdAltRaw === undefined ? null : canonicalChatId(senderIdAltRaw);
  const senderName = optionalString(raw["senderName"]) ?? digitsOf(senderId);
  const chatName =
    optionalString(raw["chatName"]) ?? (chatType === "group" ? digitsOf(chatId) : senderName);

  const text = typeof raw["text"] === "string" ? raw["text"] : "";

  let media: InboundMedia | null = null;
  const base64 = optionalString(raw["mediaBase64"]);
  const kindRaw = optionalString(raw["kind"]);
  if (base64 !== undefined) {
    const bytes = new Uint8Array(Buffer.from(base64, "base64"));
    const mime = optionalString(raw["mediaMime"]) ?? "application/octet-stream";
    const filename = optionalString(raw["mediaFilename"]);
    const caption = optionalString(raw["mediaCaption"]);
    media = {
      kind: mediaKindFor(kindRaw, mime),
      mime,
      declaredSize: bytes.byteLength,
      // The debug endpoint has already decoded the attachment, so "downloading"
      // it is handing the same array over. It still goes through the router's
      // cap: a debug injection must not become a way around it.
      download: async (maxBytes: number) => {
        if (bytes.byteLength > maxBytes) {
          throw new MediaTooLargeError(bytes.byteLength, maxBytes);
        }
        return bytes;
      },
      ...(filename === undefined ? {} : { filename }),
      ...(caption === undefined ? {} : { caption }),
    };
  }

  const kind: MessageKind =
    kindRaw !== undefined && MESSAGE_KINDS.has(kindRaw)
      ? (kindRaw as MessageKind)
      : media !== null
        ? (media.kind as MessageKind)
        : "text";

  const quotedRaw = asRecord(raw["quoted"]);
  const quotedId = optionalString(quotedRaw["messageId"]);
  const quoted: QuotedMessage | null =
    quotedId === undefined
      ? null
      : {
          messageId: quotedId,
          text: typeof quotedRaw["text"] === "string" ? quotedRaw["text"] : "",
          senderId: normalizeJid(optionalString(quotedRaw["senderId"]) ?? ""),
          isFromBot: quotedRaw["isFromBot"] === true,
        };

  const mentionedIds = Array.isArray(raw["mentionedIds"])
    ? raw["mentionedIds"]
        .filter((v): v is string => typeof v === "string")
        .map((v) => normalizeJid(v))
    : [];

  debugCounter += 1;

  return {
    messageId: optionalString(raw["messageId"]) ?? `debug-${debugCounter}`,
    chatId,
    chatIdRaw: optionalString(raw["chatIdRaw"]) ?? chatIdRaw,
    chatType,
    chatName,
    senderId,
    senderIdAlt,
    senderName,
    text,
    kind,
    timestamp:
      typeof raw["timestamp"] === "number" && Number.isFinite(raw["timestamp"])
        ? Math.floor(raw["timestamp"])
        : Math.floor(Date.now() / 1000),
    mentionsBot: raw["mentionsBot"] === true,
    mentionedIds,
    quoted,
    media,
  };
}
