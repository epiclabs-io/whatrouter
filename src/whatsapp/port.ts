/**
 * The seam between the WhatsApp adapter (Baileys) and everything else.
 * The router and relay layers import only this file - never Baileys.
 */

export type ChatType = "dm" | "group";

export type MessageKind =
  "text" | "image" | "video" | "voice" | "audio" | "document" | "sticker" | "location" | "other";

export type MediaKind = "image" | "video" | "voice" | "audio" | "document" | "sticker";

export interface QuotedMessage {
  messageId: string;
  text: string;
  /** Canonical JID of the quoted message's author. */
  senderId: string;
  /** True when the quoted message was sent by us (reply-to-bot relevance gate). */
  isFromBot: boolean;
}

export interface InboundMedia {
  kind: MediaKind;
  mime: string;
  bytes: Uint8Array;
  filename?: string;
  caption?: string;
  size: number;
}

/** Already normalized: canonical ids, unwrapped payload, downloaded media. */
export interface InboundMessage {
  messageId: string;
  /** Canonical chat id: `<digits>@g.us` for groups, canonical sender JID for DMs. */
  chatId: string;
  /** `key.remoteJid` exactly as received (outbound targeting prefers this). */
  chatIdRaw: string;
  chatType: ChatType;
  /** Group subject, or the sender's pushName for DMs. */
  chatName: string;
  /** Canonical sender JID. */
  senderId: string;
  /** The other form of the sender id (`@lid` vs `@s.whatsapp.net`), or null. */
  senderIdAlt: string | null;
  senderName: string;
  text: string;
  kind: MessageKind;
  /** Unix seconds. */
  timestamp: number;
  mentionsBot: boolean;
  /** Normalized JIDs from `contextInfo.mentionedJid`. */
  mentionedIds: string[];
  quoted: QuotedMessage | null;
  media: InboundMedia | null;
  /** Media was present but could not be downloaded; the message is delivered anyway. */
  downloadFailed: boolean;
}

export interface OutboundMedia {
  kind: "image" | "video" | "voice" | "audio" | "document";
  bytes: Uint8Array;
  mime: string;
  filename?: string;
  caption?: string;
  replyTo?: string;
}

export type WhatsAppState = "unpaired" | "connecting" | "connected" | "disconnected";

export type InboundHandler = (m: InboundMessage) => Promise<void>;

export interface WhatsAppPort {
  start(): Promise<void>;
  stop(): Promise<void>;
  state(): WhatsAppState;
  /** Our own ids (PN and LID forms), normalized, for echo suppression and mention checks. */
  botIds(): string[];
  onMessage(handler: InboundHandler): void;
  sendText(chat: string, text: string, opts?: { replyTo?: string }): Promise<{ messageId: string }>;
  editText(chat: string, messageId: string, text: string): Promise<void>;
  deleteMessage(chat: string, messageId: string): Promise<void>;
  typing(chat: string, on: boolean): Promise<void>;
  react(chat: string, messageId: string, emoji: string): Promise<void>;
  sendMedia(chat: string, media: OutboundMedia): Promise<{ messageId: string }>;
  chatInfo(chat: string): Promise<{ name: string; type: ChatType }>;
}
