import { describe, expect, it } from "vitest";
import {
  canonicalJid,
  digitsOf,
  isBroadcastOrNewsletter,
  isGroupJid,
  isLidJid,
  isPhoneLike,
  isPnJid,
  normalizeJid,
  phoneToJid,
  sameUser,
} from "../../src/whatsapp/jid.js";

describe("normalizeJid", () => {
  it("strips the :device suffix", () => {
    expect(normalizeJid("34600000000:12@s.whatsapp.net")).toBe("34600000000@s.whatsapp.net");
    expect(normalizeJid("123456789012345:3@lid")).toBe("123456789012345@lid");
  });

  it("lowercases the server and folds the legacy @c.us form", () => {
    expect(normalizeJid("34600000000@S.WhatsApp.Net")).toBe("34600000000@s.whatsapp.net");
    expect(normalizeJid("34600000000@c.us")).toBe("34600000000@s.whatsapp.net");
  });

  it("passes through group jids and bare digits, and tolerates empty input", () => {
    expect(normalizeJid("120363001234567890@g.us")).toBe("120363001234567890@g.us");
    expect(normalizeJid(" 34600000000 ")).toBe("34600000000");
    expect(normalizeJid(null)).toBe("");
  });
});

describe("digitsOf / phoneToJid", () => {
  it("keeps digits only", () => {
    expect(digitsOf("+34 600 000 000")).toBe("34600000000");
    expect(digitsOf("34600000000@s.whatsapp.net")).toBe("34600000000");
    expect(digitsOf("(34) 600-000.000")).toBe("34600000000");
  });

  it("builds a phone-number jid", () => {
    expect(phoneToJid("+34 600 000 000")).toBe("34600000000@s.whatsapp.net");
    expect(phoneToJid("34600000000")).toBe("34600000000@s.whatsapp.net");
  });
});

describe("predicates", () => {
  it("classifies servers", () => {
    expect(isGroupJid("120363001234567890@g.us")).toBe(true);
    expect(isLidJid("123456789012345@lid")).toBe(true);
    expect(isPnJid("34600000000@s.whatsapp.net")).toBe(true);
    expect(isPnJid("34600000000@c.us")).toBe(true);
    expect(isPnJid("123456789012345@lid")).toBe(false);
  });

  it("flags broadcast and newsletter chats", () => {
    expect(isBroadcastOrNewsletter("status@broadcast")).toBe(true);
    expect(isBroadcastOrNewsletter("12345@newsletter")).toBe(true);
    expect(isBroadcastOrNewsletter("34600000000@s.whatsapp.net")).toBe(false);
  });

  it("accepts phone shapes of 6 to 15 digits", () => {
    expect(isPhoneLike("+34600000000")).toBe(true);
    expect(isPhoneLike("34 600 000 000")).toBe(true);
    expect(isPhoneLike("12345")).toBe(false);
    expect(isPhoneLike("1234567890123456")).toBe(false);
    expect(isPhoneLike("+34600000000@lid")).toBe(false);
  });
});

describe("canonicalJid", () => {
  it("prefers the phone-number form from either side", () => {
    expect(canonicalJid("123456789012345@lid", "34600000000@s.whatsapp.net")).toBe(
      "34600000000@s.whatsapp.net"
    );
    expect(canonicalJid("34600000000:5@s.whatsapp.net", "123456789012345@lid")).toBe(
      "34600000000@s.whatsapp.net"
    );
  });

  it("falls back to the lid form when no phone number is known", () => {
    expect(canonicalJid("123456789012345@lid")).toBe("123456789012345@lid");
    expect(canonicalJid("123456789012345@lid", null)).toBe("123456789012345@lid");
  });

  it("leaves group jids alone", () => {
    expect(canonicalJid("120363001234567890@g.us")).toBe("120363001234567890@g.us");
  });
});

describe("sameUser", () => {
  it("matches across formatting and bare digits", () => {
    expect(sameUser("+34600000000", "34600000000@s.whatsapp.net")).toBe(true);
    expect(sameUser("34600000000:9@s.whatsapp.net", "34600000000@s.whatsapp.net")).toBe(true);
  });

  it("never mixes the lid and phone namespaces", () => {
    expect(sameUser("34600000000@lid", "34600000000@s.whatsapp.net")).toBe(false);
    expect(sameUser("34600000000@s.whatsapp.net", "34600000001@s.whatsapp.net")).toBe(false);
    expect(sameUser("", "34600000000@s.whatsapp.net")).toBe(false);
  });
});
