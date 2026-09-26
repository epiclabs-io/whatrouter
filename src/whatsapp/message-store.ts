/**
 * Bounded memory of recent WhatsApp messages.
 *
 * Two jobs:
 *  - keep the last N `WAMessage`s so we can quote them, react to them, and answer
 *    Baileys' `getMessage` retries;
 *  - remember the ids of the messages *we* sent, so an echo coming back through
 *    `messages.upsert` is dropped instead of routed to a gateway.
 *
 * Plain Map-based LRU: Maps keep insertion order, so the oldest key is always the
 * first one `keys().next()` yields.
 */
import type { WAMessage } from "@whiskeysockets/baileys";

export const DEFAULT_STORE_LIMIT = 512;

export interface MessageStore {
  /** Stores a message under `key.id`; no-op for a message without an id. */
  remember(msg: WAMessage): void;
  /** Most recent message with that id, refreshing its LRU position. */
  get(id: string): WAMessage | undefined;
  rememberSentId(id: string): void;
  wasSentByUs(id: string): boolean;
  /** Number of stored messages (tests). */
  size(): number;
  clear(): void;
}

function trim(map: Map<string, unknown>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done === true) {
      return;
    }
    map.delete(oldest.value);
  }
}

export function createMessageStore(limit: number = DEFAULT_STORE_LIMIT): MessageStore {
  const max = Math.max(1, limit);
  const messages = new Map<string, WAMessage>();
  const sentIds = new Map<string, true>();

  return {
    remember(msg: WAMessage): void {
      const id = msg.key?.id;
      if (id === undefined || id === null || id === "") {
        return;
      }
      messages.delete(id);
      messages.set(id, msg);
      trim(messages, max);
    },

    get(id: string): WAMessage | undefined {
      const found = messages.get(id);
      if (found === undefined) {
        return undefined;
      }
      // Touch: keep hot messages (a chat we are actively replying in) alive.
      messages.delete(id);
      messages.set(id, found);
      return found;
    },

    rememberSentId(id: string): void {
      if (id === "") {
        return;
      }
      sentIds.delete(id);
      sentIds.set(id, true);
      trim(sentIds, max);
    },

    wasSentByUs(id: string): boolean {
      return sentIds.has(id);
    },

    size(): number {
      return messages.size;
    },

    clear(): void {
      messages.clear();
      sentIds.clear();
    },
  };
}
