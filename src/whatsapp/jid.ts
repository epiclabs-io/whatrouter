/**
 * JID helpers shared by the config loader, the router and the Baileys adapter.
 * Pure string manipulation: no Baileys import, no I/O.
 */

export const PN_SERVER = "s.whatsapp.net";
export const LID_SERVER = "lid";
export const GROUP_SERVER = "g.us";

/** Phone numbers as operators write them: optional `+`, 6-15 digits, spaces/dashes tolerated. */
const PHONE_RE = /^\+?\d{6,15}$/;
const GROUP_JID_RE = /^\d+(-\d+)?@g\.us$/;
const LID_JID_RE = /^\d+@lid$/;
const PN_JID_RE = /^\d+@s\.whatsapp\.net$/;

function serverOf(jid: string): string {
  const at = jid.indexOf("@");
  return at === -1 ? "" : jid.slice(at + 1);
}

function userOf(jid: string): string {
  const at = jid.indexOf("@");
  return at === -1 ? jid : jid.slice(0, at);
}

/**
 * Hermes' `normalizeWhatsAppId`: drop the `:device` suffix Baileys attaches to our own
 * ids, lowercase the server, and fold the legacy `@c.us` server into `@s.whatsapp.net`.
 */
export function normalizeJid(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  if (s === "") {
    return "";
  }
  const at = s.indexOf("@");
  if (at === -1) {
    return s.split(":")[0] ?? "";
  }
  const user = (s.slice(0, at).split(":")[0] ?? "").trim();
  let server = s
    .slice(at + 1)
    .trim()
    .toLowerCase();
  if (server === "c.us") {
    server = PN_SERVER;
  }
  return `${user}@${server}`;
}

/** Digits of a phone number or of the user part of a JID (`+34 600 000 000` -> `34600000000`). */
export function digitsOf(phoneOrJid: string | null | undefined): string {
  return userOf((phoneOrJid ?? "").trim()).replace(/\D/g, "");
}

/** `+34 600 000 000` -> `34600000000@s.whatsapp.net`. */
export function phoneToJid(phone: string): string {
  return `${digitsOf(phone)}@${PN_SERVER}`;
}

export function isGroupJid(jid: string): boolean {
  return serverOf(normalizeJid(jid)) === GROUP_SERVER;
}

export function isLidJid(jid: string): boolean {
  return serverOf(normalizeJid(jid)) === LID_SERVER;
}

export function isPnJid(jid: string): boolean {
  return serverOf(normalizeJid(jid)) === PN_SERVER;
}

/** `status@broadcast`, broadcast lists and newsletters are never routed. */
export function isBroadcastOrNewsletter(jid: string): boolean {
  const server = serverOf(normalizeJid(jid));
  return server === "broadcast" || server === "newsletter";
}

/** Does this string look like a phone number an operator would write in config? */
export function isPhoneLike(raw: string): boolean {
  return PHONE_RE.test(raw.trim().replace(/[\s().-]/g, ""));
}

export function isGroupJidLike(raw: string): boolean {
  return GROUP_JID_RE.test(normalizeJid(raw));
}

export function isLidJidLike(raw: string): boolean {
  return LID_JID_RE.test(normalizeJid(raw));
}

export function isPnJidLike(raw: string): boolean {
  return PN_JID_RE.test(normalizeJid(raw));
}

/** Parse an operator-facing user identity into its canonical runtime JID. */
export function parseUserIdentity(raw: string): string | null {
  const value = raw.trim();
  if (isPnJidLike(value) || isLidJidLike(value)) {
    return normalizeJid(value);
  }
  if (isPhoneLike(value)) {
    return phoneToJid(value);
  }
  return null;
}

/** Format a user identity for config: phone JIDs become bare digits; LIDs stay explicit. */
export function formatUserIdentity(raw: string): string | null {
  const identity = parseUserIdentity(raw);
  if (identity === null) {
    return null;
  }
  return isPnJid(identity) ? digitsOf(identity) : identity;
}

/**
 * The id we key everything on: the `@s.whatsapp.net` form when either side is a phone
 * number JID, else the `@lid` form. Anything else (groups) passes through normalized.
 */
export function canonicalJid(primary: string, alt?: string | null): string {
  const p = normalizeJid(primary);
  const a = normalizeJid(alt);
  if (isPnJid(p)) {
    return p;
  }
  if (a !== "" && isPnJid(a)) {
    return a;
  }
  if (isLidJid(p)) {
    return p;
  }
  if (a !== "" && isLidJid(a)) {
    return a;
  }
  return p;
}

/**
 * Same WhatsApp user? Bare digits match either namespace, but a `@lid` id and a
 * `@s.whatsapp.net` id with the same digits are *different* users.
 */
export function sameUser(a: string, b: string): boolean {
  const x = normalizeJid(a);
  const y = normalizeJid(b);
  if (x === "" || y === "") {
    return false;
  }
  if (x === y) {
    return true;
  }
  const sx = serverOf(x);
  const sy = serverOf(y);
  if (sx !== "" && sy !== "" && sx !== sy) {
    return false;
  }
  const dx = digitsOf(x);
  return dx !== "" && dx === digitsOf(y);
}
