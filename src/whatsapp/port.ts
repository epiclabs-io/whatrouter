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

export type GroupParticipantAdmin = "admin" | "superadmin" | null;

export interface GroupParticipant {
  id: string;
  admin: GroupParticipantAdmin;
}

export interface GroupMetadata {
  id: string;
  subject: string;
  description: string | null;
  owner: string | null;
  participants: GroupParticipant[];
  size: number;
  /** Only when WhatsApp includes it in metadata; use `getGroupInviteCode` to fetch it. */
  inviteCode: string | null;
  announcement: boolean;
  restrict: boolean;
  ephemeralDuration: number;
  memberAddMode: "admins" | "all";
  joinApprovalMode: boolean;
}

export type GroupParticipantAction = "add" | "remove" | "promote" | "demote";

export interface GroupParticipantUpdate {
  participantId: string;
  status: string;
}

export type GroupJoinRequestMethod = "invite_link" | "linked_group_join" | "non_admin_add";

export interface GroupJoinRequest {
  participantId: string;
  method: GroupJoinRequestMethod | null;
}

export type GroupJoinRequestAction = "approve" | "reject";

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
  createGroup(subject: string, participantIds: string[]): Promise<GroupMetadata>;
  /** Cached metadata only; `inviteCode` is whatever WhatsApp included (often null). */
  getGroupMetadata(groupId: string): Promise<GroupMetadata>;
  updateGroupParticipants(
    groupId: string,
    participantIds: string[],
    action: GroupParticipantAction
  ): Promise<GroupParticipantUpdate[]>;
  listPendingGroupJoinRequests(groupId: string): Promise<GroupJoinRequest[]>;
  reviewPendingGroupJoinRequests(
    groupId: string,
    participantIds: string[],
    action: GroupJoinRequestAction
  ): Promise<GroupParticipantUpdate[]>;
  getGroupInviteCode(groupId: string): Promise<string | null>;
  revokeGroupInviteCode(groupId: string): Promise<string | null>;
  acceptGroupInviteCode(code: string): Promise<string | null>;
  leaveGroup(groupId: string): Promise<void>;
  updateGroupSubject(groupId: string, subject: string): Promise<void>;
  updateGroupDescription(groupId: string, description: string | null): Promise<void>;
  setGroupAnnouncement(groupId: string, enabled: boolean): Promise<void>;
  setGroupRestrict(groupId: string, enabled: boolean): Promise<void>;
  setGroupEphemeralDuration(groupId: string, seconds: number): Promise<void>;
  setGroupMemberAddMode(groupId: string, mode: "admins" | "all"): Promise<void>;
  setGroupJoinApprovalMode(groupId: string, enabled: boolean): Promise<void>;
}
