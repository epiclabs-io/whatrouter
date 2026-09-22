/**
 * Baileys `WAMessage` -> `InboundMessage`.
 *
 * Everything platform-shaped happens here: envelope unwrapping, LID/phone
 * canonicalization, media download, quote and mention extraction. The router and
 * relay layers never see a Baileys type.
 *
 * `normalizeInbound` never throws: a message we cannot fully understand is either
 * dropped (returns null) or delivered with a degraded body.
 */
import {
  getContentType,
  normalizeMessageContent,
  type proto,
  type WAMessage,
} from '@whiskeysockets/baileys';
import type { Logger } from '../util/log.js';
import {
  canonicalJid,
  digitsOf,
  isBroadcastOrNewsletter,
  isGroupJid,
  isLidJid,
  normalizeJid,
  sameUser,
} from './jid.js';
import type { InboundMedia, InboundMessage, MediaKind, MessageKind } from './port.js';

export interface NormalizeContext {
  /** Our own ids (PN and LID), normalized. */
  botIds: string[];
  /** Last-resort LID -> phone resolution (`signalRepository.lidMapping`). */
  resolvePn?: ((lid: string) => Promise<string | null>) | undefined;
  /** Group subject lookup, usually a cached `groupMetadata` call. */
  groupSubject?: ((jid: string) => Promise<string | null>) | undefined;
  /** Media fetcher; omitted means "do not download" (media stays null). */
  download?: ((msg: WAMessage) => Promise<Uint8Array>) | undefined;
  log: Logger;
}

type Content = proto.IMessage;
type ContentType = keyof proto.IMessage;

/** Payload types that are protocol noise, never a user message. */
const IGNORED_TYPES = new Set<string>([
  'protocolMessage',
  'reactionMessage',
  'pollUpdateMessage',
  'senderKeyDistributionMessage',
  'messageContextInfo',
  'stickerSyncRmrMessage',
  'encReactionMessage',
  'keepInChatMessage',
  'placeholderMessage',
]);

const MEDIA_KIND_BY_TYPE: Partial<Record<string, MediaKind>> = {
  imageMessage: 'image',
  videoMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
  stickerMessage: 'sticker',
};

const DEFAULT_MIME: Record<MediaKind, string> = {
  image: 'image/jpeg',
  video: 'video/mp4',
  voice: 'audio/ogg; codecs=opus',
  audio: 'audio/mpeg',
  document: 'application/octet-stream',
  sticker: 'image/webp',
};

/** `messageTimestamp` is a number, a Long, or a stringified Long depending on the path. */
export function toUnixSeconds(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed);
  }
  if (typeof value === 'object' && value !== null) {
    const long = value as { toNumber?: () => number; low?: number; high?: number };
    if (typeof long.toNumber === 'function') {
      const n = long.toNumber();
      if (Number.isFinite(n)) return Math.floor(n);
    }
    if (typeof long.low === 'number') {
      return (long.high ?? 0) * 4294967296 + (long.low >>> 0);
    }
  }
  return Math.floor(Date.now() / 1000);
}

function node(content: Content, type: ContentType): Record<string, unknown> | undefined {
  const value = (content as Record<string, unknown>)[type];
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function contextInfoOf(content: Content, type: ContentType): proto.IContextInfo | undefined {
  const inner = node(content, type);
  const ctx = inner?.['contextInfo'];
  return typeof ctx === 'object' && ctx !== null ? (ctx as proto.IContextInfo) : undefined;
}

function vcardPhone(vcard: string): string {
  const match = /TEL[^:\n]*:([+0-9 ()-]{5,})/i.exec(vcard);
  return match?.[1]?.trim() ?? '';
}

function pollText(inner: Record<string, unknown>): string {
  const name = str(inner['name']);
  const rawOptions = inner['options'];
  const options = Array.isArray(rawOptions)
    ? rawOptions
        .map((o) => str((o as Record<string, unknown> | null)?.['optionName']))
        .filter((o) => o !== '')
    : [];
  return options.length === 0 ? `[Poll: ${name}]` : `[Poll: ${name} Options: ${options.join(', ')}]`;
}

function locationText(inner: Record<string, unknown>): string {
  const name = str(inner['name'] ?? inner['address']);
  const lat = inner['degreesLatitude'];
  const lng = inner['degreesLongitude'];
  const coords = `${typeof lat === 'number' ? lat : 0},${typeof lng === 'number' ? lng : 0}`;
  return name === '' ? `[Location: ${coords}]` : `[Location: ${name} ${coords}]`;
}

/** The human-readable body of a payload, bracketed for what WhatsApp renders as a card. */
export function extractText(content: Content | undefined | null): string {
  if (content === undefined || content === null) return '';
  const type = getContentType(content);
  if (type === undefined) return '';
  if (type === 'conversation') return str((content as Record<string, unknown>)['conversation']);
  const inner = node(content, type);
  if (inner === undefined) return '';

  switch (type) {
    case 'extendedTextMessage':
      return str(inner['text']);
    case 'imageMessage':
    case 'videoMessage':
      return str(inner['caption']);
    case 'documentMessage': {
      const caption = str(inner['caption']);
      if (caption !== '') return caption;
      const fileName = str(inner['fileName']);
      return fileName === '' ? '' : `[Document: ${fileName}]`;
    }
    case 'locationMessage':
    case 'liveLocationMessage':
      return locationText(inner);
    case 'contactMessage': {
      const name = str(inner['displayName']);
      const phone = vcardPhone(str(inner['vcard']));
      return `[Contact: ${[name, phone].filter((p) => p !== '').join(' ')}]`;
    }
    case 'contactsArrayMessage': {
      const list = Array.isArray(inner['contacts'])
        ? (inner['contacts'] as Record<string, unknown>[])
        : [];
      const names = list.map((c) => str(c['displayName'])).filter((n) => n !== '');
      return `[Contacts: ${names.join(', ')}]`;
    }
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3':
      return pollText(inner);
    default:
      return '';
  }
}

function kindOf(type: ContentType, inner: Record<string, unknown> | undefined): MessageKind {
  switch (type) {
    case 'conversation':
    case 'extendedTextMessage':
      return 'text';
    case 'imageMessage':
      return 'image';
    case 'videoMessage':
      return 'video';
    case 'audioMessage':
      return inner?.['ptt'] === true ? 'voice' : 'audio';
    case 'documentMessage':
      return 'document';
    case 'stickerMessage':
      return 'sticker';
    case 'locationMessage':
    case 'liveLocationMessage':
      return 'location';
    default:
      return 'other';
  }
}

async function resolveSender(
  raw: string,
  alt: string,
  ctx: NormalizeContext,
): Promise<{ senderId: string; senderIdAlt: string | null }> {
  const primary = normalizeJid(raw);
  const secondary = normalizeJid(alt);
  let senderId = canonicalJid(primary, secondary);
  let other = senderId === primary ? secondary : primary;

  if (isLidJid(senderId) && ctx.resolvePn !== undefined) {
    try {
      const pn = normalizeJid(await ctx.resolvePn(senderId));
      if (pn !== '' && !isLidJid(pn)) {
        other = senderId;
        senderId = pn;
      }
    } catch (err) {
      ctx.log.debug({ err, lid: senderId }, 'lid -> phone resolution failed');
    }
  }

  return { senderId, senderIdAlt: other === '' || other === senderId ? null : other };
}

function quotedFrom(
  contextInfo: proto.IContextInfo | undefined,
  botIds: string[],
): InboundMessage['quoted'] {
  const stanzaId = contextInfo?.stanzaId;
  if (stanzaId === undefined || stanzaId === null || stanzaId === '') return null;
  const participant = contextInfo?.participant ?? '';
  const quotedContent = normalizeMessageContent(contextInfo?.quotedMessage ?? undefined);
  return {
    messageId: stanzaId,
    text: extractText(quotedContent),
    senderId: canonicalJid(participant),
    isFromBot: botIds.some((id) => sameUser(participant, id)),
  };
}

export async function normalizeInbound(
  msg: WAMessage,
  ctx: NormalizeContext,
): Promise<InboundMessage | null> {
  const key = msg.key;
  if (key === undefined || key === null) return null;
  if (msg.message === undefined || msg.message === null) return null;
  if (key.fromMe === true) return null;

  const remoteJid = key.remoteJid ?? '';
  if (remoteJid === '' || isBroadcastOrNewsletter(remoteJid)) return null;

  const content = normalizeMessageContent(msg.message);
  if (content === undefined || content === null) return null;
  const type = getContentType(content);
  if (type === undefined || IGNORED_TYPES.has(type)) return null;

  const inner = node(content, type);
  const messageId = key.id ?? '';
  const isGroup = isGroupJid(remoteJid);

  const { senderId, senderIdAlt } = await resolveSender(
    key.participant ?? remoteJid,
    key.participantAlt ?? key.remoteJidAlt ?? '',
    ctx,
  );

  const chatId = isGroup ? normalizeJid(remoteJid) : senderId;
  const senderName = msg.pushName ?? digitsOf(senderId);

  let chatName = senderName;
  if (isGroup) {
    let subject: string | null = null;
    if (ctx.groupSubject !== undefined) {
      try {
        subject = await ctx.groupSubject(chatId);
      } catch (err) {
        ctx.log.debug({ err, chatId }, 'group subject lookup failed');
      }
    }
    chatName = subject === null || subject === '' ? digitsOf(chatId) : subject;
  }

  const contextInfo = contextInfoOf(content, type);
  const mentionedIds = (contextInfo?.mentionedJid ?? [])
    .map((jid) => normalizeJid(jid))
    .filter((jid) => jid !== '');
  const mentionsBot = mentionedIds.some((id) => ctx.botIds.some((bot) => sameUser(id, bot)));

  const kind = kindOf(type, inner);
  let text = extractText(content);
  let media: InboundMedia | null = null;
  let downloadFailed = false;

  const mediaKind: MediaKind | undefined =
    kind === 'voice' ? 'voice' : MEDIA_KIND_BY_TYPE[type as string];

  if (mediaKind !== undefined && ctx.download !== undefined) {
    try {
      const bytes = await ctx.download(msg);
      const caption = str(inner?.['caption']);
      const filename = str(inner?.['fileName']);
      media = {
        kind: mediaKind,
        mime: str(inner?.['mimetype']) || DEFAULT_MIME[mediaKind],
        bytes,
        size: bytes.byteLength,
        ...(filename === '' ? {} : { filename }),
        ...(caption === '' ? {} : { caption }),
      };
    } catch (err) {
      ctx.log.warn({ err, messageId, chatId }, 'media download failed; delivering without it');
      downloadFailed = true;
      const note = `[${kind} could not be downloaded]`;
      text = text === '' ? note : `${text}\n${note}`;
    }
  }

  // Nothing a gateway could act on: an unsupported card with no body and no media.
  if (kind === 'other' && text === '' && media === null && !downloadFailed) {
    ctx.log.debug({ type, chatId }, 'dropping message with no usable payload');
    return null;
  }

  return {
    messageId,
    chatId,
    chatIdRaw: remoteJid,
    chatType: isGroup ? 'group' : 'dm',
    chatName,
    senderId,
    senderIdAlt,
    senderName,
    text,
    kind,
    timestamp: toUnixSeconds(msg.messageTimestamp),
    mentionsBot,
    mentionedIds,
    quoted: quotedFrom(contextInfo, ctx.botIds),
    media,
    downloadFailed,
  };
}
