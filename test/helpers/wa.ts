/**
 * Shared scaffolding for the WhatsApp adapter tests: fixtures, a silent logger, a
 * throwaway config, a fake Baileys socket and a pre-registered auth folder.
 *
 * Nothing here touches the network; the only filesystem writes go to a temp dir.
 */
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BufferJSON,
  initAuthCreds,
  type AnyMessageContent,
  type GroupMetadata,
  type MiscMessageGenerationOptions,
  type WAMessage,
  type WAMessageKey,
  type WAPresence,
} from "@whiskeysockets/baileys";
import { readFileSync } from "node:fs";
import type { Config } from "../../src/config/schema.js";
import { createLogger, type Logger } from "../../src/util/log.js";
import type { SocketLike } from "../../src/whatsapp/baileys-client.js";

export const BOT_PN = "34600000099@s.whatsapp.net";
export const BOT_LID = "111222333444555@lid";
export const BOT_IDS = [BOT_PN, BOT_LID];

export function fixture(name: string): WAMessage {
  const url = new URL(`../fixtures/baileys/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as WAMessage;
}

export function silentLog(): Logger {
  return createLogger({ level: "silent" });
}

export function testConfig(overrides: Partial<Config["whatsapp"]> = {}): Config {
  return {
    listen: { host: "127.0.0.1", port: 8466 },
    publicUrl: null,
    dataDir: "/nonexistent",
    logLevel: "info",
    whatsapp: {
      editStreaming: false,
      sendReadReceipts: false,
      chunkDelayMs: 0,
      sendTimeoutMs: 1000,
      ...overrides,
    },
    buffer: { maxAgeSeconds: 1209600, wakeCooldownSeconds: 60 },
    media: { maxBytes: 26214400, retentionSeconds: 604800 },
    defaultProfile: null,
    allowUnroutedOutbound: false,
    management: null,
    groups: {},
    profiles: [],
  };
}

export interface FakeSend {
  jid: string;
  content: AnyMessageContent;
  options: MiscMessageGenerationOptions | undefined;
}

export interface FakeSocket {
  socket: SocketLike;
  ev: EventEmitter;
  sends: FakeSend[];
  presence: { type: WAPresence; jid: string | undefined }[];
  reads: WAMessageKey[][];
  pairingRequests: string[];
  ended: number;
  setUser(user: { id: string; lid?: string }): void;
}

export interface FakeSocketOptions {
  /** Id returned by the next send; defaults to `sent-1`, `sent-2`, ... */
  sendIds?: string[];
  groupSubject?: string;
  pairingCode?: string;
  onSend?: (send: FakeSend) => void | Promise<void>;
}

export function createFakeSocket(opts: FakeSocketOptions = {}): FakeSocket {
  const ev = new EventEmitter();
  const sends: FakeSend[] = [];
  const presence: { type: WAPresence; jid: string | undefined }[] = [];
  const reads: WAMessageKey[][] = [];
  const pairingRequests: string[] = [];
  const queuedIds = [...(opts.sendIds ?? [])];
  let counter = 0;
  let user: { id: string; lid?: string } | undefined;

  const state: FakeSocket = {
    ev,
    sends,
    presence,
    reads,
    pairingRequests,
    ended: 0,
    setUser(next) {
      user = next;
    },
    socket: {
      ev: ev as unknown as SocketLike["ev"],
      get user() {
        return user;
      },
      signalRepository: {
        lidMapping: { getPNForLID: async () => null },
      },
      async sendMessage(jid, content, options): Promise<WAMessage> {
        const send: FakeSend = { jid, content, options };
        sends.push(send);
        await opts.onSend?.(send);
        counter += 1;
        const id = queuedIds.shift() ?? `sent-${counter}`;
        return {
          key: { remoteJid: jid, fromMe: true, id },
          message: { conversation: "outbound" },
          messageTimestamp: 1758000000,
        } as WAMessage;
      },
      async sendPresenceUpdate(type, jid): Promise<void> {
        presence.push({ type, jid });
      },
      async readMessages(keys): Promise<void> {
        reads.push(keys);
      },
      async groupMetadata(jid): Promise<GroupMetadata> {
        return {
          id: jid,
          subject: opts.groupSubject ?? "Test Group",
          owner: undefined,
          participants: [],
        } as unknown as GroupMetadata;
      },
      async groupCreate(subject, participants): Promise<GroupMetadata> {
        return {
          id: "120363009999999999@g.us",
          subject,
          owner: BOT_PN,
          participants: participants.map((id) => ({ id, admin: null })),
        };
      },
      async groupLeave(): Promise<void> {},
      async groupUpdateSubject(): Promise<void> {},
      async groupRequestParticipantsList(): Promise<Record<string, string>[]> {
        return [];
      },
      async groupRequestParticipantsUpdate(_jid, participants) {
        return participants.map((jid) => ({ jid, status: "200" }));
      },
      async groupParticipantsUpdate(_jid, participants) {
        return participants.map((jid) => ({ jid, status: "200", content: {} }));
      },
      async groupUpdateDescription(): Promise<void> {},
      async groupInviteCode(): Promise<string> {
        return "invite-code";
      },
      async groupRevokeInvite(): Promise<string> {
        return "new-invite-code";
      },
      async groupAcceptInvite(): Promise<string> {
        return "120363009999999999@g.us";
      },
      async groupToggleEphemeral(): Promise<void> {},
      async groupSettingUpdate(): Promise<void> {},
      async groupMemberAddMode(): Promise<void> {},
      async groupJoinApprovalMode(): Promise<void> {},
      async updateMediaMessage(msg): Promise<WAMessage> {
        return msg;
      },
      async requestPairingCode(phoneNumber): Promise<string> {
        pairingRequests.push(phoneNumber);
        return opts.pairingCode ?? "ABCD1234";
      },
      async end(): Promise<void> {
        state.ended += 1;
      },
    },
  };

  return state;
}

/** A temp dir with credentials that look like a completed pairing. */
export async function makeRegisteredAuthDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "whatrouter-auth-"));
  const creds = initAuthCreds();
  creds.registered = true;
  creds.me = {
    id: "34600000099:12@s.whatsapp.net",
    lid: "111222333444555:12@lid",
    name: "WhatRouter",
  };
  await writeFile(join(dir, "creds.json"), JSON.stringify(creds, BufferJSON.replacer));
  return dir;
}

export async function makeEmptyAuthDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "whatrouter-auth-"));
}

export interface CapturedIo {
  out: string[];
  err: string[];
  io: { out(line: string): void; err(line: string): void };
}

export function captureIo(): CapturedIo {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (line) => out.push(line), err: (line) => err.push(line) } };
}
