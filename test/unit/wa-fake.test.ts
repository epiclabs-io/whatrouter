import { describe, expect, it } from "vitest";
import { FAKE_BOT_LID, FAKE_BOT_PN, createFakeWhatsAppPort } from "../../src/whatsapp/fake.js";
import type { InboundMessage } from "../../src/whatsapp/port.js";

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: "M1",
    chatId: "34611111111@s.whatsapp.net",
    chatIdRaw: "34611111111@s.whatsapp.net",
    chatType: "dm",
    chatName: "Alice",
    senderId: "34611111111@s.whatsapp.net",
    senderIdAlt: null,
    senderName: "Alice",
    text: "hello",
    kind: "text",
    mentionsBot: false,
    quoted: null,
    media: null,
    ...overrides,
  };
}

describe("createFakeWhatsAppPort", () => {
  it("reports a connected, known identity", async () => {
    const port = createFakeWhatsAppPort();
    expect(port.state()).toBe("connected");
    expect(port.botIds()).toEqual([FAKE_BOT_PN, FAKE_BOT_LID]);
  });

  it("delivers injected messages to the handler", async () => {
    const port = createFakeWhatsAppPort();
    const seen: InboundMessage[] = [];
    port.onMessage(async (m) => {
      seen.push(m);
    });

    await port.inject(inbound());
    expect(seen).toHaveLength(1);
    expect(seen[0]?.text).toBe("hello");
  });

  it("refuses to inject without a handler", async () => {
    const port = createFakeWhatsAppPort();
    await expect(port.inject(inbound())).rejects.toThrow(/no inbound handler/);
  });

  it("records every outbound call and hands out incrementing ids", async () => {
    const port = createFakeWhatsAppPort();
    const chat = "34611111111@s.whatsapp.net";

    expect(await port.sendText(chat, "one", { replyTo: "M1" })).toEqual({ messageId: "fake-1" });
    await port.typing(chat, true);
    await port.react(chat, "M1", "👍");
    await port.editText(chat, "fake-1", "one (edited)");
    await port.deleteMessage(chat, "fake-1");
    expect(
      await port.sendMedia(chat, { kind: "image", bytes: new Uint8Array([1]), mime: "image/png" })
    ).toEqual({ messageId: "fake-2" });

    expect(port.sent.map((s) => s.kind)).toEqual([
      "text",
      "typing",
      "react",
      "edit",
      "delete",
      "media",
    ]);
    expect(port.sent[0]).toEqual({
      kind: "text",
      chat,
      text: "one",
      replyTo: "M1",
      messageId: "fake-1",
    });
  });

  it("answers chat info and records the lookup", async () => {
    const port = createFakeWhatsAppPort();
    expect(await port.chatInfo("120363001234567890@g.us")).toEqual({
      name: "120363001234567890",
      type: "group",
    });
    port.setChatName("34611111111@s.whatsapp.net", "Alice");
    expect(await port.chatInfo("34611111111@s.whatsapp.net")).toEqual({
      name: "Alice",
      type: "dm",
    });
    expect(port.sent.filter((s) => s.kind === "chatInfo")).toHaveLength(2);
  });

  it("manages group metadata, participants and settings deterministically", async () => {
    const port = createFakeWhatsAppPort();
    const member = "34611111111:7@s.whatsapp.net";
    const group = await port.createGroup("Original", [member]);

    expect(group.id).toBe("120363000000000001@g.us");
    expect(group.participants).toEqual([
      { id: FAKE_BOT_PN, admin: "superadmin" },
      { id: "34611111111@s.whatsapp.net", admin: null },
    ]);
    expect(await port.updateGroupParticipants(group.id, [member], "promote")).toEqual([
      { participantId: "34611111111@s.whatsapp.net", status: "200" },
    ]);

    await port.updateGroupSubject(group.id, "Renamed");
    await port.updateGroupDescription(group.id, "Description");
    await port.setGroupAnnouncement(group.id, true);
    await port.setGroupRestrict(group.id, true);
    await port.setGroupEphemeralDuration(group.id, 86400);
    await port.setGroupMemberAddMode(group.id, "all");
    await port.setGroupJoinApprovalMode(group.id, true);

    expect(await port.getGroupMetadata(group.id)).toMatchObject({
      subject: "Renamed",
      description: "Description",
      announcement: true,
      restrict: true,
      ephemeralDuration: 86400,
      memberAddMode: "all",
      joinApprovalMode: true,
      size: 2,
    });
    expect((await port.getGroupMetadata(group.id)).participants[1]?.admin).toBe("admin");
  });

  it("reviews pending joins and rotates invite codes", async () => {
    const port = createFakeWhatsAppPort();
    const group = await port.createGroup("Requests", []);
    port.setPendingGroupJoinRequests(group.id, [
      { participantId: "34622222222:3@s.whatsapp.net", method: "invite_link" },
    ]);

    expect(await port.listPendingGroupJoinRequests(group.id)).toEqual([
      { participantId: "34622222222@s.whatsapp.net", method: "invite_link" },
    ]);
    expect(
      await port.reviewPendingGroupJoinRequests(group.id, ["34622222222@s.whatsapp.net"], "approve")
    ).toEqual([{ participantId: "34622222222@s.whatsapp.net", status: "200" }]);
    expect((await port.getGroupMetadata(group.id)).size).toBe(2);

    const oldCode = await port.getGroupInviteCode(group.id);
    const newCode = await port.revokeGroupInviteCode(group.id);
    expect(newCode).not.toBe(oldCode);
    expect(await port.acceptGroupInviteCode(oldCode ?? "")).toBeNull();
    expect(await port.acceptGroupInviteCode(newCode ?? "")).toBe(group.id);

    await port.leaveGroup(group.id);
    await expect(port.getGroupMetadata(group.id)).rejects.toThrow(/unknown fake WhatsApp group/);
  });

  it("resets its recording", async () => {
    const port = createFakeWhatsAppPort();
    await port.sendText("x@s.whatsapp.net", "hi");
    port.reset();
    expect(port.sent).toHaveLength(0);
    expect(await port.sendText("x@s.whatsapp.net", "hi")).toEqual({ messageId: "fake-1" });
  });
});
