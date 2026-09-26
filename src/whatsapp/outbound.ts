/**
 * Outbound side of the adapter: pure payload builders plus the send queue.
 *
 * The builders are separated from the socket so every op can be unit-tested without
 * Baileys. The queue exists because overlapping `sendMessage` calls have caused
 * cross-chat misdelivery upstream: every send in the process goes through one
 * serialized lane with a per-call timeout.
 */
import { spawn } from "node:child_process";
import type {
  AnyMessageContent,
  MiscMessageGenerationOptions,
  WAMessage,
  WAMessageKey,
} from "@whiskeysockets/baileys";
import type { OutboundMedia } from "./port.js";

/** What `sock.sendMessage(jid, content, options)` needs. */
export interface SendPayload {
  content: AnyMessageContent;
  options: MiscMessageGenerationOptions;
}

export interface TextPayloadOptions {
  /** The stored message to quote (native reply). */
  quoted?: WAMessage | undefined;
  mentions?: string[] | undefined;
}

export const OPUS_MIME = "audio/ogg; codecs=opus";
const FFMPEG_TIMEOUT_MS = 30_000;

export function buildTextPayload(text: string, opts: TextPayloadOptions = {}): SendPayload {
  const mentions = opts.mentions ?? [];
  return {
    content: { text, ...(mentions.length === 0 ? {} : { mentions }) },
    options: opts.quoted === undefined ? {} : { quoted: opts.quoted },
  };
}

/** WhatsApp only accepts edits of our own messages, hence `fromMe: true` in the key. */
export function buildEditPayload(text: string, key: WAMessageKey): SendPayload {
  return { content: { text, edit: key }, options: {} };
}

export function buildDeletePayload(key: WAMessageKey): SendPayload {
  return { content: { delete: key }, options: {} };
}

/** An empty emoji removes the reaction, which is how the `react` op models `remove`. */
export function buildReactPayload(emoji: string, key: WAMessageKey): SendPayload {
  return { content: { react: { text: emoji, key } }, options: {} };
}

function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function isOpus(mime: string): boolean {
  const m = mime.toLowerCase();
  return m.includes("ogg") || m.includes("opus");
}

/**
 * Re-encodes arbitrary audio to what WhatsApp wants for a voice note. Resolves to
 * null when ffmpeg is missing or fails: the caller then sends a plain audio file.
 */
export async function transcodeToOpus(bytes: Uint8Array): Promise<Uint8Array | null> {
  return await new Promise<Uint8Array | null>((resolve) => {
    let child;
    try {
      child = spawn("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-ar",
        "48000",
        "-ac",
        "1",
        "-c:a",
        "libopus",
        "-f",
        "ogg",
        "pipe:1",
      ]);
    } catch {
      resolve(null);
      return;
    }

    const parts: Buffer[] = [];
    let settled = false;
    const finish = (value: Uint8Array | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, FFMPEG_TIMEOUT_MS);
    timer.unref?.();

    child.stdout.on("data", (chunk: Buffer) => parts.push(chunk));
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      const out = Buffer.concat(parts);
      finish(code === 0 && out.length > 0 ? out : null);
    });
    child.stdin.on("error", () => finish(null));
    child.stdin.end(toBuffer(bytes));
  });
}

export interface MediaPayloadDeps {
  /** Injected in tests; defaults to the ffmpeg pipe above. */
  transcode?: ((bytes: Uint8Array) => Promise<Uint8Array | null>) | undefined;
}

export async function buildMediaPayload(
  media: OutboundMedia,
  deps: MediaPayloadDeps = {}
): Promise<SendPayload> {
  const buffer = toBuffer(media.bytes);
  const caption = media.caption ?? "";
  const withCaption = caption === "" ? {} : { caption };

  switch (media.kind) {
    case "image":
      return { content: { image: buffer, mimetype: media.mime, ...withCaption }, options: {} };
    case "video":
      return { content: { video: buffer, mimetype: media.mime, ...withCaption }, options: {} };
    case "document":
      return {
        content: {
          document: buffer,
          mimetype: media.mime,
          fileName: media.filename ?? "file",
          ...withCaption,
        },
        options: {},
      };
    case "audio":
      return { content: { audio: buffer, mimetype: media.mime }, options: {} };
    case "voice": {
      if (isOpus(media.mime)) {
        return { content: { audio: buffer, ptt: true, mimetype: OPUS_MIME }, options: {} };
      }
      const transcode = deps.transcode ?? transcodeToOpus;
      const converted = await transcode(media.bytes);
      if (converted !== null) {
        return {
          content: { audio: toBuffer(converted), ptt: true, mimetype: OPUS_MIME },
          options: {},
        };
      }
      // No ffmpeg: a playable attachment beats a failed send.
      return { content: { audio: buffer, ptt: false, mimetype: media.mime }, options: {} };
    }
  }
}

export interface SendQueue {
  /** Runs `fn` after every previously queued call, with a timeout of its own. */
  enqueue<T>(fn: () => Promise<T>): Promise<T>;
  /** Calls queued but not yet settled (tests). */
  depth(): number;
}

export interface SendQueueOptions {
  timeoutMs: number;
}

export class SendTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`sendMessage timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = "SendTimeoutError";
  }
}

export function createSendQueue(opts: SendQueueOptions): SendQueue {
  const timeoutMs = Math.max(1, opts.timeoutMs);
  let tail: Promise<void> = Promise.resolve();
  let depth = 0;

  async function withTimeout<T>(fn: () => Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new SendTimeoutError(timeoutMs)), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  return {
    enqueue<T>(fn: () => Promise<T>): Promise<T> {
      depth += 1;
      const result = tail.then(async () => await withTimeout(fn));
      // The lane moves on whether the call resolved, rejected or timed out.
      tail = result.then(
        () => {
          depth -= 1;
        },
        () => {
          depth -= 1;
        }
      );
      return result;
    },

    depth(): number {
      return depth;
    },
  };
}
