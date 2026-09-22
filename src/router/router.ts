/**
 * The router: the only place that knows about both WhatsApp and the relay.
 *
 * Inbound  — resolve the chat to a profile, apply the relevance gate, re-host
 *            any media, build the wire event, hand it to the relay (which
 *            delivers it live or buffers it durably). Never throws: a message we
 *            cannot handle is logged and dropped, never a crash in the WhatsApp
 *            event loop.
 * Outbound — one action from one profile, tenant-checked against the route
 *            table, dispatched to the `WhatsAppPort`. Every branch answers with
 *            a result object; an adapter that throws becomes
 *            `{success:false, error}` (the gateway waits on its requestId).
 */
import { WHATSAPP_SUPPORTED_OPS } from '../relay/descriptor.js';
import { shouldDeliver } from './relevance.js';
import { toRelayEvent, type EventMedia } from './event.js';
import {
  buildRouteTable,
  canonicalChatId,
  isRoutedTo,
  resolveProfile,
  type RouteTable,
} from './routes.js';
import type { Config, ProfileConfig } from '../config/schema.js';
import type { OutboundAction, OutboundResult, RelayEvent } from '../relay/frames.js';
import type { DeliveryOutcome } from '../relay/server.js';
import type { Store } from '../store/db.js';
import type { Logger } from '../util/log.js';
import type { InboundMessage, OutboundMedia, WhatsAppPort } from '../whatsapp/port.js';

/** The slice of the relay server the router needs (kept narrow for tests and wiring). */
export interface RelayDeliverer {
  deliver(profileName: string, event: RelayEvent): DeliveryOutcome;
}

export interface RouterOptions {
  config: Config;
  store: Store;
  log: Logger;
  whatsapp: WhatsAppPort;
  relay: RelayDeliverer;
  /** Public URL for a stored media id (see `relay/media-url.ts`). */
  mediaUrlFor: (id: string) => string;
  fetchImpl?: typeof fetch | undefined;
}

export interface Router {
  onInbound(m: InboundMessage): Promise<void>;
  execute(profile: ProfileConfig, action: OutboundAction, platform?: string): Promise<OutboundResult>;
  /** Exposed for `/healthz`-style introspection and tests. */
  readonly table: RouteTable;
}

const KNOWN_OPS = new Set<string>(WHATSAPP_SUPPORTED_OPS);
const OUTBOUND_MEDIA_KINDS = new Set<OutboundMedia['kind']>([
  'image',
  'video',
  'voice',
  'audio',
  'document',
]);
const MEDIA_FETCH_TIMEOUT_MS = 30_000;
const MEDIA_PATH = '/relay/media/';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** `…/relay/media/<id>` -> `<id>` (query/fragment stripped), or `null`. */
export function mediaIdFromUrl(url: string): string | null {
  const at = url.indexOf(MEDIA_PATH);
  if (at === -1) return null;
  const tail = url.slice(at + MEDIA_PATH.length);
  const id = tail.split(/[?#]/)[0] ?? '';
  return id === '' ? null : id;
}

type MediaSource =
  | { ok: true; bytes: Uint8Array; mime: string; filename: string | null }
  | { ok: false; error: string };

export function createRouter(opts: RouterOptions): Router {
  const { config, store, log, whatsapp, relay, mediaUrlFor } = opts;
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const table = buildRouteTable(config);

  // ------------------------------------------------------------------ inbound

  /** Re-hosts the attachment; media we cannot store never drops the message. */
  function storeMedia(profileName: string, m: InboundMessage): EventMedia | null {
    const media = m.media;
    if (media === null) return null;
    try {
      const { id } = store.media.put(profileName, media.bytes, media.mime, media.filename ?? null);
      return {
        url: mediaUrlFor(id),
        kind: media.kind,
        mime: media.mime,
        size: media.size > 0 ? media.size : media.bytes.byteLength,
        filename: media.filename,
        caption: media.caption,
      };
    } catch (err: unknown) {
      log.warn(
        { profile: profileName, chatId: m.chatId, err: errorMessage(err) },
        'could not store inbound media; delivering the message without it',
      );
      return null;
    }
  }

  async function onInbound(m: InboundMessage): Promise<void> {
    try {
      const match = resolveProfile(table, config, m);
      if (match === null) {
        log.info(
          {
            chatId: m.chatId,
            senderId: m.senderId,
            senderIdAlt: m.senderIdAlt,
            chatType: m.chatType,
          },
          "unrouted chat dropped; add it to a profile's routes",
        );
        return;
      }
      const { profile, route } = match;

      const policy = store.policy.get(profile.name);
      const decision = shouldDeliver(m, route, policy);
      if (!decision.deliver) {
        log.debug(
          {
            profile: profile.name,
            chatId: m.chatId,
            senderId: m.senderId,
            messageId: m.messageId,
            reason: decision.reason,
          },
          'inbound dropped by the relevance gate',
        );
        return;
      }

      const media = storeMedia(profile.name, m);
      const event = toRelayEvent(m, media);
      const outcome = relay.deliver(profile.name, event);
      // Remember it so a reply to a chat we matched by alt id or `default_profile`
      // still passes the outbound tenant check.
      table.remember(m.chatId, profile.name);
      log.debug(
        {
          profile: profile.name,
          chatId: m.chatId,
          messageId: m.messageId,
          messageType: event.message_type,
          media: media === null ? 0 : 1,
          outcome,
        },
        'inbound delivered to the relay',
      );
    } catch (err: unknown) {
      // The WhatsApp adapter calls us from its event loop: never throw back.
      log.error(
        { err: errorMessage(err), chatId: m.chatId, messageId: m.messageId },
        'inbound handling failed',
      );
    }
  }

  // ----------------------------------------------------------------- outbound

  /** Bytes for `send_media`: our own media store when we host it, else an HTTP fetch. */
  async function resolveMedia(profile: ProfileConfig, sourceUrl: string): Promise<MediaSource> {
    const ownId = mediaIdFromUrl(sourceUrl);
    if (ownId !== null) {
      const found = store.media.get(ownId);
      // A foreign profile's media is indistinguishable from media that is gone.
      if (found === null || found.meta.profile !== profile.name) {
        return { ok: false, error: 'media not found' };
      }
      return {
        ok: true,
        bytes: found.bytes,
        mime: found.meta.mime,
        filename: found.meta.filename,
      };
    }

    const res = await doFetch(sourceUrl, { signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS) });
    if (!res.ok) return { ok: false, error: `could not fetch media: HTTP ${res.status}` };
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > config.media.maxBytes) {
      return { ok: false, error: `media is larger than ${config.media.maxBytes} bytes` };
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > config.media.maxBytes) {
      return { ok: false, error: `media is larger than ${config.media.maxBytes} bytes` };
    }
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
    return {
      ok: true,
      bytes,
      mime: contentType === '' ? 'application/octet-stream' : contentType,
      filename: null,
    };
  }

  async function sendMedia(
    profile: ProfileConfig,
    chat: string,
    record: Record<string, unknown>,
  ): Promise<OutboundResult> {
    const kind = str(record['media_kind']) as OutboundMedia['kind'];
    if (!OUTBOUND_MEDIA_KINDS.has(kind)) {
      return { success: false, error: `unsupported media_kind: ${str(record['media_kind'])}` };
    }
    const sourceUrl = str(record['source_url']);
    if (sourceUrl === '') return { success: false, error: 'missing source_url' };

    const resolved = await resolveMedia(profile, sourceUrl);
    if (!resolved.ok) return { success: false, error: resolved.error };

    const filename = str(record['filename']) || (resolved.filename ?? '');
    const caption = str(record['content']);
    const replyTo = str(record['reply_to']);
    const media: OutboundMedia = {
      kind,
      bytes: resolved.bytes,
      mime: resolved.mime,
      ...(filename === '' ? {} : { filename }),
      ...(caption === '' ? {} : { caption }),
      ...(replyTo === '' ? {} : { replyTo }),
    };
    const { messageId } = await whatsapp.sendMedia(chat, media);
    return { success: true, message_id: messageId };
  }

  async function execute(
    profile: ProfileConfig,
    action: OutboundAction,
    _platform?: string,
  ): Promise<OutboundResult> {
    const record = action as unknown as Record<string, unknown>;
    const op = str(record['op']);
    // Answered before the tenant check: an op we do not implement is a contract
    // mismatch, and the answer must not depend on which chat it named.
    if (!KNOWN_OPS.has(op)) return { success: false, error: `unsupported op: ${op}` };

    const chat = canonicalChatId(str(record['chat_id']));
    if (chat === '') return { success: false, error: 'missing chat_id' };
    if (!isRoutedTo(table, config, profile.name, chat)) {
      log.warn(
        { profile: profile.name, chatId: chat, op },
        'refusing an outbound action for a chat this profile does not own',
      );
      return { success: false, error: 'chat not routed to this profile' };
    }

    try {
      switch (op) {
        case 'send': {
          const content = str(record['content']);
          if (content === '') return { success: false, error: 'empty content' };
          const replyTo = str(record['reply_to']);
          const { messageId } = await whatsapp.sendText(
            chat,
            content,
            replyTo === '' ? {} : { replyTo },
          );
          return { success: true, message_id: messageId };
        }
        case 'edit': {
          const messageId = str(record['message_id']);
          if (messageId === '') return { success: false, error: 'missing message_id' };
          await whatsapp.editText(chat, messageId, str(record['content']));
          return { success: true };
        }
        case 'delete': {
          const messageId = str(record['message_id']);
          if (messageId === '') return { success: false, error: 'missing message_id' };
          await whatsapp.deleteMessage(chat, messageId);
          return { success: true };
        }
        case 'typing': {
          // `content: ""` is the gateway's "stop typing"; anything else composes.
          await whatsapp.typing(chat, record['content'] !== '');
          return { success: true };
        }
        case 'react': {
          const messageId = str(record['message_id']);
          if (messageId === '') return { success: false, error: 'missing message_id' };
          const remove = record['remove'] === true;
          await whatsapp.react(chat, messageId, remove ? '' : str(record['emoji']));
          return { success: true };
        }
        case 'send_media':
          return await sendMedia(profile, chat, record);
        case 'get_chat_info':
          return { success: true, chat_info: await whatsapp.chatInfo(chat) };
        default:
          return { success: false, error: `unsupported op: ${op}` };
      }
    } catch (err: unknown) {
      const message = errorMessage(err);
      log.warn({ profile: profile.name, op, chatId: chat, err: message }, 'outbound action failed');
      return { success: false, error: message };
    }
  }

  return { onInbound, execute, table };
}
