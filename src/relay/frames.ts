/**
 * Wire types for the Hermes relay protocol (NDJSON over one WebSocket).
 * Field names are verbatim from `gateway/relay/ws_transport.py`. Types only:
 * the line assembler and the session state machine live in WP2.
 */

export type ChatKind = 'dm' | 'group';

// ---------------------------------------------------------------- descriptor

export interface CapabilityDescriptor {
  contract_version: 1;
  platform: string;
  label: string;
  max_message_length: number;
  supports_draft_streaming: boolean;
  supports_edit: boolean;
  supports_threads: boolean;
  /** Anything other than "" / "plain" tells the gateway code blocks are safe. */
  markdown_dialect: string;
  len_unit: 'chars' | 'utf16';
  emoji: string;
  platform_hint: string;
  pii_safe: boolean;
  supports_context: boolean;
  /** Mandatory: an empty list makes the gateway assume the legacy op set. */
  supported_ops: string[];
}

// -------------------------------------------------------------- inbound event

export interface RelayMediaItem {
  /** MUST also appear in `media_urls`; the gateway resolves mime by URL lookup. */
  url: string;
  kind: 'image' | 'voice' | 'audio' | 'video' | 'document' | 'sticker';
  mime: string;
  size: number;
  filename?: string;
  caption?: string;
}

export interface RelaySource {
  platform: string;
  chat_id: string;
  chat_type: ChatKind;
  chat_name: string;
  user_id: string;
  user_name: string;
  thread_id: string | null;
  chat_topic: string | null;
  /** The other form of the sender id (`@lid` vs `@s.whatsapp.net`). */
  user_id_alt?: string | null;
  /** Raw `remoteJid` when it differs from `chat_id`. */
  chat_id_alt?: string | null;
  message_id: string;
}

export type RelayMessageType =
  | 'text'
  | 'command'
  | 'photo'
  | 'video'
  | 'audio'
  | 'voice'
  | 'document'
  | 'sticker'
  | 'location';

/** Consumed by the gateway's `_event_from_wire`. */
export interface RelayEvent {
  text: string;
  message_type: RelayMessageType;
  message_id: string;
  reply_to_message_id: string | null;
  reply_to?: { text: string; author: string; is_own: boolean } | null;
  media_urls?: string[];
  media?: RelayMediaItem[];
  source: RelaySource;
}

// ------------------------------------------------------------ outbound actions

export interface SendAction {
  op: 'send';
  chat_id: string;
  content: string;
  reply_to?: string | null;
  metadata?: Record<string, unknown>;
}

export interface EditAction {
  op: 'edit';
  chat_id: string;
  message_id: string;
  content: string;
}

export interface DeleteAction {
  op: 'delete';
  chat_id: string;
  message_id: string;
}

export interface TypingAction {
  op: 'typing';
  chat_id: string;
  /** `""` means "paused". */
  content?: string;
}

export interface ReactAction {
  op: 'react';
  chat_id: string;
  message_id: string;
  emoji: string;
  remove?: boolean;
}

export interface SendMediaAction {
  op: 'send_media';
  chat_id: string;
  media_kind: 'image' | 'video' | 'voice' | 'audio' | 'document';
  source_url: string;
  content?: string;
  filename?: string;
  reply_to?: string | null;
}

export interface GetChatInfoAction {
  op: 'get_chat_info';
  chat_id: string;
}

export type KnownOutboundAction =
  | SendAction
  | EditAction
  | DeleteAction
  | TypingAction
  | ReactAction
  | SendMediaAction
  | GetChatInfoAction;

/** The gateway may send ops we do not implement; answer `unsupported op: <op>`. */
export interface UnknownAction {
  op: string;
  [key: string]: unknown;
}

export type OutboundAction = KnownOutboundAction | UnknownAction;

export interface OutboundResult {
  success: boolean;
  error?: string;
  message_id?: string;
  chat_info?: { name: string; type: ChatKind };
}

// ------------------------------------------------------- gateway -> connector

export interface HelloFrame {
  type: 'hello';
  platform: string;
  /** May be empty. */
  botId?: string;
  command_manifest?: unknown;
}

export interface OutboundFrame {
  type: 'outbound';
  requestId: string;
  action: OutboundAction;
  platform?: string;
  botId?: string;
}

export interface InboundAckFrame {
  type: 'inbound_ack';
  bufferId: string;
}

export interface InterruptFrame {
  type: 'interrupt';
  session_key?: string;
  reason?: string;
}

export interface GoingIdleFrame {
  type: 'going_idle';
}

export type GatewayFrame =
  | HelloFrame
  | OutboundFrame
  | InboundAckFrame
  | InterruptFrame
  | GoingIdleFrame;

// ------------------------------------------------------- connector -> gateway

export interface DescriptorFrame {
  type: 'descriptor';
  descriptor: CapabilityDescriptor;
}

export interface InboundFrame {
  type: 'inbound';
  event: RelayEvent;
  /** Present <=> replayed from the buffer and therefore ack-gated. */
  bufferId?: string;
}

export interface OutboundResultFrame {
  type: 'outbound_result';
  requestId: string;
  result: OutboundResult;
}

export interface GoingIdleAckFrame {
  type: 'going_idle_ack';
}

export type ConnectorFrame =
  | DescriptorFrame
  | InboundFrame
  | OutboundResultFrame
  | GoingIdleAckFrame;

export type RelayFrame = GatewayFrame | ConnectorFrame;

const GATEWAY_FRAME_TYPES = new Set(['hello', 'outbound', 'inbound_ack', 'interrupt', 'going_idle']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * True for frames we must act on. Unknown `type` values are ignored by design
 * (the contract is additive-only), so this returns false rather than throwing.
 */
export function isGatewayFrame(value: unknown): value is GatewayFrame {
  if (!isRecord(value)) return false;
  const type = value['type'];
  if (typeof type !== 'string' || !GATEWAY_FRAME_TYPES.has(type)) return false;
  switch (type) {
    case 'hello':
      return typeof value['platform'] === 'string';
    case 'outbound':
      return typeof value['requestId'] === 'string' && isRecord(value['action'])
        && typeof value['action']['op'] === 'string';
    case 'inbound_ack':
      return typeof value['bufferId'] === 'string';
    default:
      return true;
  }
}
