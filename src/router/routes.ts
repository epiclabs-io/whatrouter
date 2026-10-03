/**
 * Which profile owns a chat.
 *
 * The table is built once from the validated config: DM routes are keyed by the
 * canonical user JID, group routes by the `@g.us` JID (the loader already
 * canonicalized both and rejected a chat routed to two profiles).
 *
 * Two things make this more than a `Map` lookup:
 *  - **LID/phone duality.** The same person reaches us as `<n>@s.whatsapp.net`
 *    or `<n>@lid` depending on the chat; a route written in one form must still
 *    match a message that arrived in the other, so a DM also tries `senderIdAlt`.
 *  - **`default_profile`.** A chat with no route may still be delivered, and the
 *    reply must then pass the outbound tenant check — so every chat we actually
 *    delivered is remembered (bounded, in memory) as belonging to that profile.
 */
import { digitsOf, normalizeJid, phoneToJid } from "../whatsapp/jid.js";
import type { Config, ProfileConfig, Route } from "../config/schema.js";
import type { InboundMessage } from "../whatsapp/port.js";

export interface RouteEntry {
  profile: ProfileConfig;
  route: Route;
}

/** A configured route, or the `default_profile` fallback (`route: null`). */
export interface ResolvedRoute {
  profile: ProfileConfig;
  route: Route | null;
}

/** Plenty for a WhatsApp account's live chats; keeps the memory bounded. */
export const DELIVERED_MEMORY_MAX = 1024;

/**
 * `canonical chat id -> {profile, route}`, plus the memory of chats we resolved
 * the soft way (alt id / `default_profile`) and actually delivered.
 */
export class RouteTable extends Map<string, RouteEntry> {
  readonly #delivered = new Map<string, string>();

  /** Called after an event was handed to a profile, so its reply is allowed back. */
  remember(chatId: string, profileName: string): void {
    const id = canonicalChatId(chatId);
    if (id === "") {
      return;
    }
    // Re-insert so this chat becomes the newest entry (insertion-ordered LRU).
    this.#delivered.delete(id);
    this.#delivered.set(id, profileName);
    while (this.#delivered.size > DELIVERED_MEMORY_MAX) {
      const oldest = this.#delivered.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.#delivered.delete(oldest.value);
    }
  }

  rememberedProfile(chatId: string): string | undefined {
    return this.#delivered.get(canonicalChatId(chatId));
  }
}

/**
 * The form a chat is keyed by: `normalizeJid` plus a bare-digits fallback, so an
 * outbound `chat_id` written as `+34600000000` still finds its route.
 */
export function canonicalChatId(raw: string | null | undefined): string {
  const jid = normalizeJid(raw);
  if (jid === "") {
    return "";
  }
  if (jid.includes("@")) {
    return jid;
  }
  const digits = digitsOf(jid);
  return digits === "" ? jid : phoneToJid(digits);
}

export function buildRouteTable(config: Config): RouteTable {
  const table = new RouteTable();
  for (const profile of config.profiles) {
    for (const route of profile.routes) {
      // Duplicates are a config error the loader already rejected; last wins here.
      table.set(canonicalChatId(route.id), { profile, route });
    }
  }
  return table;
}

function defaultProfileOf(config: Config): ProfileConfig | null {
  if (config.defaultProfile === null) {
    return null;
  }
  return config.profiles.find((p) => p.name === config.defaultProfile) ?? null;
}

/**
 * Exact chat match first, then (for DMs) the other form of the sender id, then
 * `default_profile`. `null` means "no profile wants this chat" — drop it.
 */
export function resolveProfile(
  table: RouteTable,
  config: Config,
  m: InboundMessage
): ResolvedRoute | null {
  const exact = table.get(canonicalChatId(m.chatId));
  if (exact !== undefined) {
    return { profile: exact.profile, route: exact.route };
  }

  // A LID-keyed route for a message that arrived as a phone number, or vice versa.
  if (m.chatType === "dm" && m.senderIdAlt !== null && m.senderIdAlt !== "") {
    const alt = table.get(canonicalChatId(m.senderIdAlt));
    if (alt !== undefined) {
      return { profile: alt.profile, route: alt.route };
    }
  }

  // `default_profile` is a DM-only fallback (D5). A group has to be routed on
  // purpose: every member of an unregistered-but-registered group would
  // otherwise be answered by whoever the operator made the default, which is
  // not a decision anyone made about those people.
  if (m.chatType === "dm") {
    const fallback = defaultProfileOf(config);
    if (fallback !== null) {
      return { profile: fallback, route: null };
    }
  }
  return null;
}

/**
 * The outbound tenant check: may `profileName` act on `chatId`?
 *
 * Fail-closed by default — a compromised or confused Hermes instance can only
 * reach chats routed to it (or ones we already delivered to it).
 */
export function isRoutedTo(
  table: RouteTable,
  allowUnroutedOutbound: boolean,
  profileName: string,
  chatId: string
): boolean {
  // A boot setting, so it arrives as its own argument rather than as the whole
  // live config: this check gates every outbound action and must not answer to
  // a value that changed under a running process.
  if (allowUnroutedOutbound) {
    return true;
  }
  const id = canonicalChatId(chatId);
  if (id === "") {
    return false;
  }
  const entry = table.get(id);
  if (entry !== undefined) {
    return entry.profile.name === profileName;
  }
  return table.rememberedProfile(id) === profileName;
}
