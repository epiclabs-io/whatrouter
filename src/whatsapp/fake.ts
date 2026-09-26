/**
 * In-memory `WhatsAppPort` for tests, the conformance run and
 * `WHATROUTER_FAKE_WHATSAPP=1`.
 *
 * Inbound is pushed in with `inject`; outbound is recorded in `sent` in call order.
 * Message ids are handed out as `fake-1`, `fake-2`, ... to whatever returns one.
 */
import { digitsOf, isGroupJid, normalizeJid } from "./jid.js";
import type {
  ChatType,
  InboundHandler,
  InboundMessage,
  OutboundMedia,
  WhatsAppPort,
  WhatsAppState,
} from "./port.js";

export const FAKE_BOT_PN = "1000@s.whatsapp.net";
export const FAKE_BOT_LID = "2000@lid";

export type FakeSent =
  | { kind: "text"; chat: string; text: string; replyTo: string | undefined; messageId: string }
  | { kind: "edit"; chat: string; messageId: string; text: string }
  | { kind: "delete"; chat: string; messageId: string }
  | { kind: "typing"; chat: string; on: boolean }
  | { kind: "react"; chat: string; messageId: string; emoji: string }
  | { kind: "media"; chat: string; media: OutboundMedia; messageId: string }
  | { kind: "chatInfo"; chat: string };

export interface FakeWhatsAppPort extends WhatsAppPort {
  /** Everything the router asked us to do, oldest first. */
  sent: FakeSent[];
  /** Delivers a message as if it had arrived from WhatsApp. */
  inject(m: InboundMessage): Promise<void>;
  /** Names returned by `chatInfo` for a chat (defaults to the jid digits). */
  setChatName(chat: string, name: string): void;
  setState(state: WhatsAppState): void;
  reset(): void;
}

export function createFakeWhatsAppPort(): FakeWhatsAppPort {
  const sent: FakeSent[] = [];
  const names = new Map<string, string>();
  let handler: InboundHandler | null = null;
  let state: WhatsAppState = "connected";
  let counter = 0;

  const nextId = (): string => {
    counter += 1;
    return `fake-${counter}`;
  };

  return {
    sent,

    async start(): Promise<void> {
      state = "connected";
    },

    async stop(): Promise<void> {
      state = "disconnected";
    },

    state(): WhatsAppState {
      return state;
    },

    setState(next: WhatsAppState): void {
      state = next;
    },

    botIds(): string[] {
      return [FAKE_BOT_PN, FAKE_BOT_LID];
    },

    onMessage(next: InboundHandler): void {
      handler = next;
    },

    async inject(m: InboundMessage): Promise<void> {
      if (handler === null) {
        throw new Error("no inbound handler registered");
      }
      await handler(m);
    },

    setChatName(chat: string, name: string): void {
      names.set(normalizeJid(chat), name);
    },

    reset(): void {
      sent.length = 0;
      names.clear();
      counter = 0;
    },

    async sendText(chat, text, options): Promise<{ messageId: string }> {
      const messageId = nextId();
      sent.push({ kind: "text", chat, text, replyTo: options?.replyTo, messageId });
      return { messageId };
    },

    async editText(chat, messageId, text): Promise<void> {
      sent.push({ kind: "edit", chat, messageId, text });
    },

    async deleteMessage(chat, messageId): Promise<void> {
      sent.push({ kind: "delete", chat, messageId });
    },

    async typing(chat, on): Promise<void> {
      sent.push({ kind: "typing", chat, on });
    },

    async react(chat, messageId, emoji): Promise<void> {
      sent.push({ kind: "react", chat, messageId, emoji });
    },

    async sendMedia(chat, media: OutboundMedia): Promise<{ messageId: string }> {
      const messageId = nextId();
      sent.push({ kind: "media", chat, media, messageId });
      return { messageId };
    },

    async chatInfo(chat): Promise<{ name: string; type: ChatType }> {
      sent.push({ kind: "chatInfo", chat });
      const canonical = normalizeJid(chat);
      const type: ChatType = isGroupJid(canonical) ? "group" : "dm";
      return { name: names.get(canonical) ?? digitsOf(canonical), type };
    },
  };
}
