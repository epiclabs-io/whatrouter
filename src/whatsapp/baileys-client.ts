/**
 * The real `WhatsAppPort`: one Baileys multi-device socket, owned by this process.
 *
 * Shape of the thing:
 *  - `start()` refuses to open a socket when the auth state is not registered, so
 *    `serve` never prints a QR code (that is `whatrouter pair`'s job);
 *  - inbound messages are normalized here and handed to a single handler;
 *  - every outbound call goes through one serialized send queue;
 *  - the socket factory is injectable, which is what keeps the tests off the network.
 */
import { join } from "node:path";
import { Boom } from "@hapi/boom";
import {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeWASocket,
  useMultiFileAuthState,
  type AnyMessageContent,
  type AuthenticationState,
  type ConnectionState,
  type GroupMetadata as BaileysGroupMetadata,
  type MiscMessageGenerationOptions,
  type UserFacingSocketConfig,
  type WAMessage,
  type WAMessageKey,
  type WAPresence,
  type WAVersion,
} from "@whiskeysockets/baileys";
import type { Config } from "../config/schema.js";
import type { Logger } from "../util/log.js";
import { readCapped } from "../util/stream.js";
import { WHATSAPP_MAX_MESSAGE_CHARS, chunkText } from "./chunk.js";
import { markdownToWhatsApp } from "./format.js";
import { canonicalJid, digitsOf, isGroupJid, normalizeJid } from "./jid.js";
import { createMessageStore, type MessageStore } from "./message-store.js";
import { normalizeInbound } from "./normalize.js";
import {
  buildDeletePayload,
  buildEditPayload,
  buildMediaPayload,
  buildReactPayload,
  buildTextPayload,
  createSendQueue,
} from "./outbound.js";
import type {
  ChatType,
  GroupJoinRequest,
  GroupJoinRequestMethod,
  GroupMetadata,
  GroupParticipantUpdate,
  InboundHandler,
  OutboundMedia,
  WhatsAppPort,
  WhatsAppState,
} from "./port.js";

/** Everything we use from a Baileys socket - the seam the tests replace. */
export interface SocketEventsLike {
  on(event: "connection.update", listener: (update: Partial<ConnectionState>) => void): unknown;
  on(event: "creds.update", listener: (creds?: unknown) => void): unknown;
  on(event: "messages.upsert", listener: (upsert: MessagesUpsert) => void): unknown;
  on(
    event: "groups.update",
    listener: (updates: Array<{ id?: string | undefined }>) => void
  ): unknown;
  on(event: "group-participants.update", listener: (update: { id: string }) => void): unknown;
}

export interface MessagesUpsert {
  messages: WAMessage[];
  type: string;
}

export interface SocketLike {
  ev: SocketEventsLike;
  user?: { id: string; lid?: string | undefined; name?: string | undefined } | undefined;
  signalRepository?:
    { lidMapping?: { getPNForLID(lid: string): Promise<string | null> } | undefined } | undefined;
  ws?: { close(): void } | undefined;
  sendMessage(
    jid: string,
    content: AnyMessageContent,
    options?: MiscMessageGenerationOptions
  ): Promise<WAMessage | undefined>;
  sendPresenceUpdate(type: WAPresence, jid?: string): Promise<void>;
  readMessages(keys: WAMessageKey[]): Promise<void>;
  groupMetadata(jid: string): Promise<BaileysGroupMetadata>;
  groupCreate(subject: string, participants: string[]): Promise<BaileysGroupMetadata>;
  groupLeave(jid: string): Promise<void>;
  groupUpdateSubject(jid: string, subject: string): Promise<void>;
  groupRequestParticipantsList(jid: string): Promise<Record<string, string>[]>;
  groupRequestParticipantsUpdate(
    jid: string,
    participants: string[],
    action: "approve" | "reject"
  ): Promise<{ status: string; jid: string | undefined }[]>;
  groupParticipantsUpdate(
    jid: string,
    participants: string[],
    action: "add" | "remove" | "promote" | "demote"
  ): Promise<{ status: string; jid: string | undefined; content: unknown }[]>;
  groupUpdateDescription(jid: string, description?: string): Promise<void>;
  groupInviteCode(jid: string): Promise<string | undefined>;
  groupRevokeInvite(jid: string): Promise<string | undefined>;
  groupAcceptInvite(code: string): Promise<string | undefined>;
  groupToggleEphemeral(jid: string, ephemeralExpiration: number): Promise<void>;
  groupSettingUpdate(
    jid: string,
    setting: "announcement" | "not_announcement" | "locked" | "unlocked"
  ): Promise<void>;
  groupMemberAddMode(jid: string, mode: "admin_add" | "all_member_add"): Promise<void>;
  groupJoinApprovalMode(jid: string, mode: "on" | "off"): Promise<void>;
  updateMediaMessage(msg: WAMessage): Promise<WAMessage>;
  requestPairingCode(phoneNumber: string, customPairingCode?: string): Promise<string>;
  end(error?: Error | undefined): Promise<void> | void;
}

export type MakeSocket = (config: UserFacingSocketConfig) => SocketLike;

export const defaultMakeSocket: MakeSocket = (config) =>
  makeWASocket(config) as unknown as SocketLike;

export const AUTH_SUBDIR = "wa-auth";
export const VERSION_FETCH_TIMEOUT_MS = 15_000;
const GROUP_CACHE_TTL_MS = 5 * 60_000;
const GROUP_CACHE_MAX = 256;
const CHAT_MAP_MAX = 4096;
const RESTART_DELAY_MS = 1_000;
const BACKOFF_START_MS = 3_000;
const BACKOFF_MAX_MS = 60_000;

export interface BaileysClientOptions {
  config: Config;
  log: Logger;
  /** Injected in tests; defaults to the real `makeWASocket`. */
  makeSocket?: MakeSocket | undefined;
  /** Defaults to `<data_dir>/wa-auth`. */
  authDir?: string | undefined;
}

export interface BaileysClient extends WhatsAppPort {
  onStateChange(cb: (state: WhatsAppState) => void): void;
  /** The auth directory in use (pairing instructions, tests). */
  authDir(): string;
}

export function authDirFor(config: Config): string {
  return join(config.dataDir, AUTH_SUBDIR);
}

/** Baileys wraps disconnect causes in Boom; anything else gets boomified to 500. */
export function disconnectStatus(error: unknown): number | undefined {
  if (error === undefined || error === null) {
    return undefined;
  }
  const existing = (error as { output?: { statusCode?: number } }).output;
  if (existing !== undefined && typeof existing.statusCode === "number") {
    return existing.statusCode;
  }
  const boom = new Boom(error instanceof Error ? error : new Error(String(error)));
  return boom.output?.statusCode;
}

/** 3s, 6s, 12s ... capped at 60s. */
export function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** Math.max(0, attempt));
}

function remember<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done === true) {
      break;
    }
    map.delete(oldest.value);
  }
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export function createBaileysClient(opts: BaileysClientOptions): BaileysClient {
  const { config, log } = opts;
  const makeSocket = opts.makeSocket ?? defaultMakeSocket;
  // A test that injects a socket must never reach the network, not even for the
  // protocol version lookup.
  const fetchVersion = opts.makeSocket === undefined;
  const dir = opts.authDir ?? authDirFor(config);
  const waLogger = log.child({ mod: "baileys" });

  const store: MessageStore = createMessageStore();
  const queue = createSendQueue({ timeoutMs: config.whatsapp.sendTimeoutMs });
  const groupCache = new Map<string, { metadata: BaileysGroupMetadata; expires: number }>();
  const rawByCanonical = new Map<string, string>();
  const nameByChat = new Map<string, string>();
  const stateListeners: ((state: WhatsAppState) => void)[] = [];

  let state: WhatsAppState = "disconnected";
  let sock: SocketLike | null = null;
  let auth: AuthenticationState | null = null;
  let saveCreds: (() => Promise<void>) | null = null;
  let handler: InboundHandler | null = null;
  let botIds: string[] = [];
  let reconnectTimer: NodeJS.Timeout | null = null;
  let attempt = 0;
  let stopped = false;

  function setState(next: WhatsAppState): void {
    if (state === next) {
      return;
    }
    state = next;
    log.info({ state: next }, "whatsapp state");
    for (const cb of stateListeners) {
      try {
        cb(next);
      } catch (err) {
        log.error({ err }, "state listener failed");
      }
    }
  }

  function requireSocket(): SocketLike {
    if (sock === null) {
      throw new Error(`whatsapp is not connected (state: ${state})`);
    }
    return sock;
  }

  // ---------------------------------------------------------------- group data

  function cachedGroup(jid: string): BaileysGroupMetadata | undefined {
    const hit = groupCache.get(jid);
    if (hit === undefined) {
      return undefined;
    }
    if (hit.expires <= Date.now()) {
      groupCache.delete(jid);
      return undefined;
    }
    return hit.metadata;
  }

  async function fetchGroupMetadata(jid: string): Promise<BaileysGroupMetadata> {
    const hit = cachedGroup(jid);
    if (hit !== undefined) {
      return hit;
    }
    const metadata = await requireSocket().groupMetadata(jid);
    remember(
      groupCache,
      jid,
      { metadata, expires: Date.now() + GROUP_CACHE_TTL_MS },
      GROUP_CACHE_MAX
    );
    return metadata;
  }

  async function groupMetadata(jid: string): Promise<BaileysGroupMetadata | undefined> {
    try {
      return await fetchGroupMetadata(jid);
    } catch (err) {
      log.debug({ err, jid }, "groupMetadata failed");
      return undefined;
    }
  }

  async function groupSubject(jid: string): Promise<string | null> {
    const metadata = await groupMetadata(jid);
    return metadata?.subject ?? null;
  }

  function normalizeGroupMetadata(metadata: BaileysGroupMetadata): GroupMetadata {
    const participants = metadata.participants.map((participant) => ({
      id: canonicalJid(participant.id, participant.phoneNumber),
      admin:
        participant.admin === "admin" || participant.admin === "superadmin"
          ? participant.admin
          : null,
    }));
    const owner = canonicalJid(metadata.owner ?? "", metadata.ownerPn);
    return {
      id: normalizeJid(metadata.id),
      subject: metadata.subject,
      description: metadata.desc ?? null,
      owner: owner === "" ? null : owner,
      participants,
      size: metadata.size ?? participants.length,
      inviteCode: metadata.inviteCode ?? null,
      announcement: metadata.announce ?? false,
      restrict: metadata.restrict ?? false,
      ephemeralDuration: metadata.ephemeralDuration ?? 0,
      memberAddMode: metadata.memberAddMode === true ? "all" : "admins",
      joinApprovalMode: metadata.joinApprovalMode ?? false,
    };
  }

  function participantResults(
    results: { status: string; jid: string | undefined }[],
    requested: string[]
  ): GroupParticipantUpdate[] {
    return results.map((result, index) => ({
      participantId: normalizeJid(result.jid ?? requested[index] ?? ""),
      status: result.status,
    }));
  }

  function joinRequestMethod(value: string | undefined): GroupJoinRequestMethod | null {
    return value === "invite_link" || value === "linked_group_join" || value === "non_admin_add"
      ? value
      : null;
  }

  // ------------------------------------------------------------------- inbound

  async function download(msg: WAMessage, maxBytes: number): Promise<Uint8Array> {
    const current = requireSocket();
    // "stream", not "buffer": Baileys would otherwise concatenate the whole
    // attachment into memory before we ever see how large it turned out to be,
    // which is the allocation the cap exists to prevent.
    const stream = await downloadMediaMessage(
      msg,
      "stream",
      {},
      {
        logger: waLogger,
        reuploadRequest: (m: WAMessage) => current.updateMediaMessage(m),
      }
    );
    return await readCapped(stream, maxBytes);
  }

  async function resolvePn(lid: string): Promise<string | null> {
    const mapping = sock?.signalRepository?.lidMapping;
    if (mapping === undefined) {
      return null;
    }
    return await mapping.getPNForLID(lid);
  }

  async function handleUpsert(upsert: MessagesUpsert): Promise<void> {
    if (upsert.type !== "notify" && upsert.type !== "append") {
      return;
    }
    for (const msg of upsert.messages) {
      try {
        const m = await normalizeInbound(msg, {
          botIds,
          resolvePn,
          download,
          log,
        });
        if (m === null) {
          continue;
        }
        store.remember(msg);
        if (store.wasSentByUs(m.messageId)) {
          log.debug({ messageId: m.messageId }, "dropping echo of our own message");
          continue;
        }
        remember(rawByCanonical, m.chatId, m.chatIdRaw, CHAT_MAP_MAX);
        remember(nameByChat, m.chatId, m.chatName, CHAT_MAP_MAX);

        if (handler === null) {
          log.warn({ messageId: m.messageId }, "no inbound handler registered; dropping message");
          continue;
        }
        try {
          await handler(m);
        } catch (err) {
          // A gateway-side failure must never take the socket loop down.
          log.error({ err, messageId: m.messageId, chatId: m.chatId }, "inbound handler failed");
          continue;
        }
        if (config.whatsapp.sendReadReceipts && msg.key !== undefined && msg.key !== null) {
          try {
            await requireSocket().readMessages([msg.key]);
          } catch (err) {
            log.debug({ err }, "read receipt failed");
          }
        }
      } catch (err) {
        log.error({ err }, "failed to process inbound message");
      }
    }
  }

  // ---------------------------------------------------------------- connection

  function clearReconnect(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect(delayMs: number): void {
    if (stopped) {
      return;
    }
    clearReconnect();
    log.info({ delayMs }, "scheduling whatsapp reconnect");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      // The scheduler owns the rejection: an unhandled one would kill the process.
      connect().catch((err: unknown) => {
        log.error({ err }, "reconnect failed");
        attempt += 1;
        scheduleReconnect(backoffMs(attempt));
      });
    }, delayMs);
    reconnectTimer.unref?.();
  }

  function handleConnectionUpdate(update: Partial<ConnectionState>): void {
    if (update.qr !== undefined) {
      log.warn("whatsapp asked for a QR code while serving; run `whatrouter pair` instead");
    }
    if (update.connection === "connecting") {
      setState("connecting");
    }

    if (update.connection === "open") {
      attempt = 0;
      const user = sock?.user;
      botIds = [normalizeJid(user?.id), normalizeJid(user?.lid)].filter(
        (id, index, all) => id !== "" && all.indexOf(id) === index
      );
      log.info({ botIds }, "whatsapp connected");
      setState("connected");
      return;
    }

    if (update.connection !== "close") {
      return;
    }

    const status = disconnectStatus(update.lastDisconnect?.error);
    sock = null;
    if (stopped) {
      return;
    }

    if (status === DisconnectReason.loggedOut) {
      setState("unpaired");
      log.error("whatsapp session logged out; run `whatrouter pair` to link the account again");
      return;
    }

    setState("disconnected");
    if (status === DisconnectReason.restartRequired) {
      scheduleReconnect(RESTART_DELAY_MS);
      return;
    }
    const delay = backoffMs(attempt);
    attempt += 1;
    log.warn({ status, delay }, "whatsapp connection closed");
    scheduleReconnect(delay);
  }

  async function resolveVersion(): Promise<WAVersion | undefined> {
    if (!fetchVersion) {
      return undefined;
    }
    try {
      const timeout = new Promise<null>((resolve) => {
        const timer = setTimeout(() => resolve(null), VERSION_FETCH_TIMEOUT_MS);
        timer.unref?.();
      });
      const result = await Promise.race([fetchLatestBaileysVersion(), timeout]);
      if (result === null) {
        log.warn("whatsapp version lookup timed out; using the bundled version");
        return undefined;
      }
      return result.version;
    } catch (err) {
      log.warn({ err }, "whatsapp version lookup failed; using the bundled version");
      return undefined;
    }
  }

  async function connect(): Promise<void> {
    if (stopped || auth === null) {
      return;
    }
    setState("connecting");
    const version = await resolveVersion();
    const next = makeSocket({
      ...(version === undefined ? {} : { version }),
      logger: waLogger,
      auth: {
        creds: auth.creds,
        keys: makeCacheableSignalKeyStore(auth.keys, waLogger),
      },
      browser: ["WhatRouter", "Chrome", "120.0"],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      getMessage: async (key: WAMessageKey) => {
        const found = key.id === undefined || key.id === null ? undefined : store.get(key.id);
        return found?.message ?? { conversation: "" };
      },
      cachedGroupMetadata: async (jid: string) => cachedGroup(jid),
    });
    sock = next;

    next.ev.on("creds.update", () => {
      void saveCreds?.().catch((err: unknown) => log.error({ err }, "saving credentials failed"));
    });
    next.ev.on("connection.update", (update) => {
      try {
        handleConnectionUpdate(update);
      } catch (err) {
        log.error({ err }, "connection update handler failed");
      }
    });
    next.ev.on("messages.upsert", (upsert) => {
      void handleUpsert(upsert).catch((err: unknown) =>
        log.error({ err }, "messages.upsert handler failed")
      );
    });
    next.ev.on("groups.update", (updates) => {
      for (const update of updates) {
        if (update.id !== undefined) {
          groupCache.delete(normalizeJid(update.id));
        }
      }
    });
    next.ev.on("group-participants.update", (update) => {
      groupCache.delete(normalizeJid(update.id));
    });
  }

  // ------------------------------------------------------------------ outbound

  /** Prefer the raw jid we last saw for this chat; fall back to the canonical id. */
  function targetJid(chat: string): string {
    const canonical = normalizeJid(chat);
    return rawByCanonical.get(canonical) ?? canonical;
  }

  function keyFor(messageId: string, jid: string, fromMe: boolean): WAMessageKey {
    const stored = store.get(messageId);
    if (stored?.key !== undefined && stored.key !== null) {
      return stored.key;
    }
    return { id: messageId, remoteJid: jid, fromMe };
  }

  async function send(
    jid: string,
    payload: { content: AnyMessageContent; options: MiscMessageGenerationOptions }
  ): Promise<string> {
    const current = requireSocket();
    const sent = await queue.enqueue(
      async () => await current.sendMessage(jid, payload.content, payload.options)
    );
    const id = sent?.key?.id ?? "";
    if (id !== "") {
      store.rememberSentId(id);
      if (sent !== undefined) {
        store.remember(sent);
      }
    }
    return id;
  }

  async function sendChunks(
    jid: string,
    chunks: string[],
    replyTo: string | undefined
  ): Promise<string> {
    let lastId = "";
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) {
        await sleep(config.whatsapp.chunkDelayMs);
      }
      const body = chunks[i] ?? "";
      const quoted = i === 0 && replyTo !== undefined ? store.get(replyTo) : undefined;
      lastId = await send(jid, buildTextPayload(body, { quoted }));
    }
    return lastId;
  }

  return {
    authDir(): string {
      return dir;
    },

    onStateChange(cb: (next: WhatsAppState) => void): void {
      stateListeners.push(cb);
    },

    state(): WhatsAppState {
      return state;
    },

    botIds(): string[] {
      return [...botIds];
    },

    onMessage(next: InboundHandler): void {
      handler = next;
    },

    async start(): Promise<void> {
      stopped = false;
      const loaded = await useMultiFileAuthState(dir);
      auth = loaded.state;
      saveCreds = loaded.saveCreds;

      if (loaded.state.creds.registered !== true) {
        setState("unpaired");
        log.error(
          { authDir: dir },
          "whatsapp account is not linked; run `whatrouter pair` (or `whatrouter pair --code <phone>`) first"
        );
        return;
      }
      await connect();
    },

    async stop(): Promise<void> {
      stopped = true;
      clearReconnect();
      const current = sock;
      sock = null;
      if (current !== null) {
        try {
          await current.end(undefined);
        } catch (err) {
          log.debug({ err }, "socket end failed");
        }
        try {
          current.ws?.close();
        } catch (err) {
          log.debug({ err }, "socket close failed");
        }
      }
      setState("disconnected");
    },

    async sendText(chat, text, options): Promise<{ messageId: string }> {
      const jid = targetJid(chat);
      const chunks = chunkText(markdownToWhatsApp(text), WHATSAPP_MAX_MESSAGE_CHARS);
      if (chunks.length === 0) {
        log.warn({ chat }, "refusing to send an empty message");
        return { messageId: "" };
      }
      return { messageId: await sendChunks(jid, chunks, options?.replyTo) };
    },

    async editText(chat, messageId, text): Promise<void> {
      const jid = targetJid(chat);
      const chunks = chunkText(markdownToWhatsApp(text), WHATSAPP_MAX_MESSAGE_CHARS);
      if (chunks.length === 0) {
        return;
      }
      const [first, ...rest] = chunks;
      await send(
        jid,
        buildEditPayload(first ?? "", { id: messageId, fromMe: true, remoteJid: jid })
      );
      // WhatsApp cannot grow one message past the limit: the overflow goes out as
      // new messages.
      if (rest.length > 0) {
        await sleep(config.whatsapp.chunkDelayMs);
        await sendChunks(jid, rest, undefined);
      }
    },

    async deleteMessage(chat, messageId): Promise<void> {
      const jid = targetJid(chat);
      await send(jid, buildDeletePayload(keyFor(messageId, jid, true)));
    },

    async typing(chat, on): Promise<void> {
      const jid = targetJid(chat);
      const current = requireSocket();
      await queue.enqueue(async () => {
        await current.sendPresenceUpdate(on ? "composing" : "paused", jid);
      });
    },

    async react(chat, messageId, emoji): Promise<void> {
      const jid = targetJid(chat);
      await send(jid, buildReactPayload(emoji, keyFor(messageId, jid, false)));
    },

    async sendMedia(chat, media: OutboundMedia): Promise<{ messageId: string }> {
      const jid = targetJid(chat);
      const payload = await buildMediaPayload(media);
      const quoted = media.replyTo === undefined ? undefined : store.get(media.replyTo);
      const options = quoted === undefined ? payload.options : { ...payload.options, quoted };
      return { messageId: await send(jid, { content: payload.content, options }) };
    },

    async createGroup(subject, participantIds): Promise<GroupMetadata> {
      const current = requireSocket();
      const participants = participantIds.map(normalizeJid);
      const metadata = await current.groupCreate(subject, participants);
      const jid = normalizeJid(metadata.id);
      remember(
        groupCache,
        jid,
        { metadata, expires: Date.now() + GROUP_CACHE_TTL_MS },
        GROUP_CACHE_MAX
      );
      return normalizeGroupMetadata(metadata);
    },

    async getGroupMetadata(groupId): Promise<GroupMetadata> {
      // Deliberately no invite-code query here: it is an extra WhatsApp request per call
      // (and always fails when we are not admin). `getGroupInviteCode` is the explicit path.
      return normalizeGroupMetadata(await fetchGroupMetadata(normalizeJid(groupId)));
    },

    async updateGroupParticipants(groupId, participantIds, action) {
      const jid = normalizeJid(groupId);
      const participants = participantIds.map(normalizeJid);
      const results = await requireSocket().groupParticipantsUpdate(jid, participants, action);
      groupCache.delete(jid);
      return participantResults(results, participants);
    },

    async listPendingGroupJoinRequests(groupId): Promise<GroupJoinRequest[]> {
      const jid = normalizeJid(groupId);
      const requests = await requireSocket().groupRequestParticipantsList(jid);
      return requests.map((request) => ({
        participantId: normalizeJid(request.jid),
        method: joinRequestMethod(request.request_method),
      }));
    },

    async reviewPendingGroupJoinRequests(groupId, participantIds, action) {
      const jid = normalizeJid(groupId);
      const participants = participantIds.map(normalizeJid);
      const results = await requireSocket().groupRequestParticipantsUpdate(
        jid,
        participants,
        action
      );
      groupCache.delete(jid);
      return participantResults(results, participants);
    },

    async getGroupInviteCode(groupId): Promise<string | null> {
      return (await requireSocket().groupInviteCode(normalizeJid(groupId))) ?? null;
    },

    async revokeGroupInviteCode(groupId): Promise<string | null> {
      const jid = normalizeJid(groupId);
      const code = await requireSocket().groupRevokeInvite(jid);
      groupCache.delete(jid);
      return code ?? null;
    },

    async acceptGroupInviteCode(code): Promise<string | null> {
      const jid = await requireSocket().groupAcceptInvite(code);
      return jid === undefined ? null : normalizeJid(jid);
    },

    async leaveGroup(groupId): Promise<void> {
      const jid = normalizeJid(groupId);
      await requireSocket().groupLeave(jid);
      groupCache.delete(jid);
    },

    async updateGroupSubject(groupId, subject): Promise<void> {
      const jid = normalizeJid(groupId);
      await requireSocket().groupUpdateSubject(jid, subject);
      groupCache.delete(jid);
    },

    async updateGroupDescription(groupId, description): Promise<void> {
      const jid = normalizeJid(groupId);
      if (description === null) {
        await requireSocket().groupUpdateDescription(jid);
      } else {
        await requireSocket().groupUpdateDescription(jid, description);
      }
      groupCache.delete(jid);
    },

    async setGroupAnnouncement(groupId, enabled): Promise<void> {
      const jid = normalizeJid(groupId);
      await requireSocket().groupSettingUpdate(jid, enabled ? "announcement" : "not_announcement");
      groupCache.delete(jid);
    },

    async setGroupRestrict(groupId, enabled): Promise<void> {
      const jid = normalizeJid(groupId);
      await requireSocket().groupSettingUpdate(jid, enabled ? "locked" : "unlocked");
      groupCache.delete(jid);
    },

    async setGroupEphemeralDuration(groupId, seconds): Promise<void> {
      const jid = normalizeJid(groupId);
      await requireSocket().groupToggleEphemeral(jid, seconds);
      groupCache.delete(jid);
    },

    async setGroupMemberAddMode(groupId, mode): Promise<void> {
      const jid = normalizeJid(groupId);
      await requireSocket().groupMemberAddMode(
        jid,
        mode === "all" ? "all_member_add" : "admin_add"
      );
      groupCache.delete(jid);
    },

    async setGroupJoinApprovalMode(groupId, enabled): Promise<void> {
      const jid = normalizeJid(groupId);
      await requireSocket().groupJoinApprovalMode(jid, enabled ? "on" : "off");
      groupCache.delete(jid);
    },

    async chatInfo(chat): Promise<{ name: string; type: ChatType }> {
      const canonical = normalizeJid(chat);
      if (isGroupJid(canonical)) {
        const subject = await groupSubject(targetJid(chat));
        return {
          name: subject === null || subject === "" ? digitsOf(canonical) : subject,
          type: "group",
        };
      }
      const known = nameByChat.get(canonical);
      return {
        name: known === undefined || known === "" ? digitsOf(canonical) : known,
        type: "dm",
      };
    },
  };
}
