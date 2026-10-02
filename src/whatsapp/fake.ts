/**
 * In-memory `WhatsAppPort` for tests, the conformance run and
 * `WHATROUTER_FAKE_WHATSAPP=1`.
 *
 * Inbound is pushed in with `inject`; outbound messages are recorded in `sent` in call order.
 * Message ids are handed out as `fake-1`, `fake-2`, ... to whatever returns one.
 */
import { digitsOf, isGroupJid, normalizeJid } from "./jid.js";
import type {
  ChatType,
  GroupJoinRequest,
  GroupMetadata,
  GroupParticipantUpdate,
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
  /** Outbound messaging calls, oldest first. */
  sent: FakeSent[];
  /** Delivers a message as if it had arrived from WhatsApp. */
  inject(m: InboundMessage): Promise<void>;
  /** Names returned by `chatInfo` for a chat (defaults to the jid digits). */
  setChatName(chat: string, name: string): void;
  /** Replaces the pending requests for an existing fake group. */
  setPendingGroupJoinRequests(groupId: string, requests: GroupJoinRequest[]): void;
  setState(state: WhatsAppState): void;
  reset(): void;
}

export function createFakeWhatsAppPort(): FakeWhatsAppPort {
  const sent: FakeSent[] = [];
  const names = new Map<string, string>();
  const groups = new Map<string, GroupMetadata>();
  const pendingRequests = new Map<string, GroupJoinRequest[]>();
  let handler: InboundHandler | null = null;
  let state: WhatsAppState = "connected";
  let counter = 0;
  let groupCounter = 0;
  let inviteCounter = 0;

  const nextId = (): string => {
    counter += 1;
    return `fake-${counter}`;
  };

  const nextInviteCode = (): string => {
    inviteCounter += 1;
    return `fake-invite-${inviteCounter}`;
  };

  const copyGroup = (group: GroupMetadata): GroupMetadata => ({
    ...group,
    participants: group.participants.map((participant) => ({ ...participant })),
  });

  const requireGroup = (groupId: string): GroupMetadata => {
    const jid = normalizeJid(groupId);
    const group = groups.get(jid);
    if (group === undefined) {
      throw new Error(`unknown fake WhatsApp group: ${jid}`);
    }
    return group;
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

    setPendingGroupJoinRequests(groupId, requests): void {
      const jid = normalizeJid(groupId);
      requireGroup(jid);
      pendingRequests.set(
        jid,
        requests.map((request) => ({
          participantId: normalizeJid(request.participantId),
          method: request.method,
        }))
      );
    },

    reset(): void {
      sent.length = 0;
      names.clear();
      groups.clear();
      pendingRequests.clear();
      counter = 0;
      groupCounter = 0;
      inviteCounter = 0;
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

    async createGroup(subject, participantIds): Promise<GroupMetadata> {
      groupCounter += 1;
      const id = `120363000000${String(groupCounter).padStart(6, "0")}@g.us`;
      const participantSet = new Set([FAKE_BOT_PN, ...participantIds.map(normalizeJid)]);
      const group: GroupMetadata = {
        id,
        subject,
        description: null,
        owner: FAKE_BOT_PN,
        participants: [...participantSet].map((participantId) => ({
          id: participantId,
          admin: participantId === FAKE_BOT_PN ? "superadmin" : null,
        })),
        size: participantSet.size,
        inviteCode: nextInviteCode(),
        announcement: false,
        restrict: false,
        ephemeralDuration: 0,
        memberAddMode: "admins",
        joinApprovalMode: false,
      };
      groups.set(id, group);
      pendingRequests.set(id, []);
      return copyGroup(group);
    },

    async getGroupMetadata(groupId): Promise<GroupMetadata> {
      return copyGroup(requireGroup(groupId));
    },

    async updateGroupParticipants(
      groupId,
      participantIds,
      action
    ): Promise<GroupParticipantUpdate[]> {
      const group = requireGroup(groupId);
      const results: GroupParticipantUpdate[] = [];
      for (const rawId of participantIds) {
        const participantId = normalizeJid(rawId);
        const index = group.participants.findIndex(
          (participant) => participant.id === participantId
        );
        let status = "200";
        if (action === "add") {
          if (index === -1) {
            group.participants.push({ id: participantId, admin: null });
          } else {
            status = "409";
          }
        } else if (index === -1) {
          status = "404";
        } else if (action === "remove") {
          group.participants.splice(index, 1);
        } else {
          const participant = group.participants[index];
          if (participant !== undefined) {
            participant.admin = action === "promote" ? "admin" : null;
          }
        }
        results.push({ participantId, status });
      }
      group.size = group.participants.length;
      return results;
    },

    async listPendingGroupJoinRequests(groupId): Promise<GroupJoinRequest[]> {
      const jid = normalizeJid(groupId);
      requireGroup(jid);
      return (pendingRequests.get(jid) ?? []).map((request) => ({ ...request }));
    },

    async reviewPendingGroupJoinRequests(
      groupId,
      participantIds,
      action
    ): Promise<GroupParticipantUpdate[]> {
      const jid = normalizeJid(groupId);
      const group = requireGroup(jid);
      const requests = pendingRequests.get(jid) ?? [];
      const results = participantIds.map((rawId) => {
        const participantId = normalizeJid(rawId);
        const index = requests.findIndex((request) => request.participantId === participantId);
        if (index === -1) {
          return { participantId, status: "404" };
        }
        requests.splice(index, 1);
        if (
          action === "approve" &&
          !group.participants.some((participant) => participant.id === participantId)
        ) {
          group.participants.push({ id: participantId, admin: null });
          group.size = group.participants.length;
        }
        return { participantId, status: "200" };
      });
      return results;
    },

    async getGroupInviteCode(groupId): Promise<string | null> {
      return requireGroup(groupId).inviteCode;
    },

    async revokeGroupInviteCode(groupId): Promise<string | null> {
      const group = requireGroup(groupId);
      group.inviteCode = nextInviteCode();
      return group.inviteCode;
    },

    async acceptGroupInviteCode(code): Promise<string | null> {
      for (const group of groups.values()) {
        if (group.inviteCode === code) {
          return group.id;
        }
      }
      return null;
    },

    async leaveGroup(groupId): Promise<void> {
      const jid = normalizeJid(groupId);
      requireGroup(jid);
      groups.delete(jid);
      pendingRequests.delete(jid);
    },

    async updateGroupSubject(groupId, subject): Promise<void> {
      requireGroup(groupId).subject = subject;
    },

    async updateGroupDescription(groupId, description): Promise<void> {
      requireGroup(groupId).description = description;
    },

    async setGroupAnnouncement(groupId, enabled): Promise<void> {
      requireGroup(groupId).announcement = enabled;
    },

    async setGroupRestrict(groupId, enabled): Promise<void> {
      requireGroup(groupId).restrict = enabled;
    },

    async setGroupEphemeralDuration(groupId, seconds): Promise<void> {
      requireGroup(groupId).ephemeralDuration = seconds;
    },

    async setGroupMemberAddMode(groupId, mode): Promise<void> {
      requireGroup(groupId).memberAddMode = mode;
    },

    async setGroupJoinApprovalMode(groupId, enabled): Promise<void> {
      requireGroup(groupId).joinApprovalMode = enabled;
    },

    async chatInfo(chat): Promise<{ name: string; type: ChatType }> {
      sent.push({ kind: "chatInfo", chat });
      const canonical = normalizeJid(chat);
      const type: ChatType = isGroupJid(canonical) ? "group" : "dm";
      return { name: names.get(canonical) ?? digitsOf(canonical), type };
    },
  };
}
