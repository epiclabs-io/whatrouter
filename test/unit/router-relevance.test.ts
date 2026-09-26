import { describe, expect, it } from "vitest";
import { shouldDeliver } from "../../src/router/relevance.js";
import type { RelayPolicy } from "../../src/store/policy.js";
import type { InboundMessage } from "../../src/whatsapp/port.js";
import { ALICE, BOB, GROUP, dmRoute, groupRoute, inbound } from "../helpers/router.js";

const groupMessage = (overrides: Partial<InboundMessage> = {}): InboundMessage =>
  inbound({
    chatId: GROUP,
    chatIdRaw: GROUP,
    chatType: "group",
    chatName: "Team",
    senderId: ALICE,
    ...overrides,
  });

describe("shouldDeliver: DMs", () => {
  it("always delivers, whatever the route or policy says", () => {
    expect(shouldDeliver(inbound(), dmRoute(ALICE), null)).toEqual({ deliver: true });
    expect(shouldDeliver(inbound(), null, { requireAddress: true })).toEqual({ deliver: true });
    expect(shouldDeliver(inbound({ text: "no mention here" }), null, null)).toEqual({
      deliver: true,
    });
  });
});

describe("shouldDeliver: group mention gating", () => {
  it("drops an unaddressed message by default", () => {
    expect(shouldDeliver(groupMessage(), groupRoute(GROUP), null)).toEqual({
      deliver: false,
      reason: "not_addressed",
    });
  });

  it("delivers on an @mention, a reply to us, or a slash command", () => {
    expect(shouldDeliver(groupMessage({ mentionsBot: true }), groupRoute(GROUP), null)).toEqual({
      deliver: true,
    });
    const quoted = groupMessage({
      quoted: {
        messageId: "wa-0",
        text: "earlier",
        senderId: "1000@s.whatsapp.net",
        isFromBot: true,
      },
    });
    expect(shouldDeliver(quoted, groupRoute(GROUP), null)).toEqual({ deliver: true });
    expect(shouldDeliver(groupMessage({ text: "/help" }), groupRoute(GROUP), null)).toEqual({
      deliver: true,
    });
    expect(shouldDeliver(groupMessage({ text: "   /help" }), groupRoute(GROUP), null)).toEqual({
      deliver: true,
    });
  });

  it("does not count a quote of someone else as addressing us", () => {
    const quoted = groupMessage({
      quoted: { messageId: "wa-0", text: "earlier", senderId: BOB, isFromBot: false },
    });
    expect(shouldDeliver(quoted, groupRoute(GROUP), null)).toEqual({
      deliver: false,
      reason: "not_addressed",
    });
  });

  it("honours require_mention: false on the route", () => {
    const route = groupRoute(GROUP, { requireMention: false });
    expect(shouldDeliver(groupMessage(), route, null)).toEqual({ deliver: true });
  });

  it("falls back to the gateway policy when the route says nothing", () => {
    const policy: RelayPolicy = { requireAddress: false };
    expect(shouldDeliver(groupMessage(), groupRoute(GROUP), policy)).toEqual({ deliver: true });
    expect(shouldDeliver(groupMessage(), null, policy)).toEqual({ deliver: true });
  });

  it("lets the route override the policy in both directions", () => {
    expect(
      shouldDeliver(groupMessage(), groupRoute(GROUP, { requireMention: true }), {
        requireAddress: false,
      })
    ).toEqual({ deliver: false, reason: "not_addressed" });
    expect(
      shouldDeliver(groupMessage(), groupRoute(GROUP, { requireMention: false }), {
        requireAddress: true,
      })
    ).toEqual({ deliver: true });
  });

  it("requires addressing when the policy has no opinion", () => {
    expect(shouldDeliver(groupMessage(), groupRoute(GROUP), {})).toEqual({
      deliver: false,
      reason: "not_addressed",
    });
  });
});

describe("shouldDeliver: allowed_senders", () => {
  it("drops a sender who is not on the list, even when addressed", () => {
    const route = groupRoute(GROUP, { allowedSenders: [BOB] });
    expect(shouldDeliver(groupMessage({ mentionsBot: true }), route, null)).toEqual({
      deliver: false,
      reason: "sender_not_allowed",
    });
  });

  it("accepts a listed sender, by either of their ids", () => {
    const route = groupRoute(GROUP, { allowedSenders: [ALICE], requireMention: false });
    expect(shouldDeliver(groupMessage(), route, null)).toEqual({ deliver: true });
    const byAlt = groupMessage({ senderId: "777888999@lid", senderIdAlt: ALICE });
    expect(shouldDeliver(byAlt, route, null)).toEqual({ deliver: true });
  });

  it("an empty allowed_senders list allows nobody", () => {
    const route = groupRoute(GROUP, { allowedSenders: [], requireMention: false });
    expect(shouldDeliver(groupMessage(), route, null)).toEqual({
      deliver: false,
      reason: "sender_not_allowed",
    });
  });

  it("a lid sender does not match a phone entry with the same digits", () => {
    const route = groupRoute(GROUP, { allowedSenders: [ALICE], requireMention: false });
    const lid = groupMessage({ senderId: "34600000001@lid", senderIdAlt: null });
    expect(shouldDeliver(lid, route, null)).toEqual({
      deliver: false,
      reason: "sender_not_allowed",
    });
  });
});
