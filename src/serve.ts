/**
 * `whatrouter serve`: the composition root.
 *
 *   sqlite store  ->  WhatsApp port (Baileys, or the fake one)
 *                 ->  router (routes + relevance + event building)
 *                 ->  relay server (WS sessions, buffer, media, /healthz)
 *
 * The router needs the relay to deliver and the relay needs the router to
 * execute, so the relay is handed to the router behind a tiny indirection that
 * is filled in a line later — no lazy-init framework, just one `let`.
 *
 * Nothing here prints a QR code: `serve` refuses to start unpaired and points at
 * `whatrouter pair`, which is the only command allowed to touch the link flow.
 */
import { createRequire } from "node:module";
import { createRouter, type RelayDeliverer, type Router } from "./router/router.js";
import { canonicalChatId } from "./router/routes.js";
import { mediaUrl } from "./relay/media-url.js";
import { createRelayServer, type RelayServer } from "./relay/server.js";
import { openStoreFromConfig, type Store } from "./store/db.js";
import { createBaileysClient } from "./whatsapp/baileys-client.js";
import { createFakeWhatsAppPort, type FakeWhatsAppPort } from "./whatsapp/fake.js";
import { digitsOf, isGroupJid, normalizeJid } from "./whatsapp/jid.js";
import type { Config } from "./config/schema.js";
import type { Logger } from "./util/log.js";
import type {
  ChatType,
  InboundMedia,
  InboundMessage,
  MediaKind,
  MessageKind,
  QuotedMessage,
  WhatsAppPort,
} from "./whatsapp/port.js";

/** Mirrors the exit codes in `cli.ts` (kept local to avoid an import cycle). */
const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_CONFIG = 2;

export const PAIRING_HINT =
  "WhatsApp account is not linked. Run: whatrouter pair   (or whatrouter pair --code +<phone>)";

export interface ServeIo {
  out(line: string): void;
  err(line: string): void;
}

export interface ServeOptions {
  config: Config;
  log: Logger;
  io: ServeIo;
  /** Defaults to `WHATROUTER_FAKE_WHATSAPP=1`. */
  fake?: boolean | undefined;
  /** `false` skips the SIGINT/SIGTERM wait (tests drive `close()` themselves). */
  signals?: boolean | undefined;
}

export interface ServeHandle {
  /** The address actually bound (`listen: …:0` resolves to a real port here). */
  address: { host: string; port: number };
  relay: RelayServer;
  router: Router;
  store: Store;
  whatsapp: WhatsAppPort;
  /** Non-null only in fake mode; what `POST /debug/inbound` injects into. */
  fake: FakeWhatsAppPort | null;
  close(): Promise<void>;
}

export type StartServeResult = { ok: true; handle: ServeHandle } | { ok: false; code: number };

function packageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Boots everything and returns a handle (address + `close`). Exposed separately
 * from `runServe` so tests can bind port 0 and still find out where we landed.
 */
export async function startServe(opts: ServeOptions): Promise<StartServeResult> {
  const { config, log, io } = opts;
  const fake = opts.fake ?? process.env["WHATROUTER_FAKE_WHATSAPP"] === "1";
  if (fake) {
    log.warn(
      "################  WHATROUTER_FAKE_WHATSAPP=1  ################\n" +
        "No WhatsApp connection: inbound is injected through POST /debug/inbound\n" +
        "and every outbound action is recorded in memory. Never run this in production.\n" +
        "##############################################################"
    );
  }

  const store = openStoreFromConfig(config);
  const fakePort = fake ? createFakeWhatsAppPort() : null;
  const whatsapp: WhatsAppPort =
    fakePort ?? createBaileysClient({ config, log: log.child({ component: "whatsapp" }) });

  // `listen: …:0` only resolves to a real port after `listen()`, and media URLs
  // must carry that port, so the builder reads a mutable binding.
  let boundPort = config.listen.port;
  const mediaUrlFor = (id: string): string => mediaUrl(config, id, { port: boundPort, log });

  let relay: RelayServer | null = null;
  const deliverer: RelayDeliverer = {
    deliver(profileName, event) {
      if (relay === null) {
        throw new Error("relay server is not running");
      }
      return relay.deliver(profileName, event);
    },
  };

  const router = createRouter({
    config,
    store,
    log: log.child({ component: "router" }),
    whatsapp,
    relay: deliverer,
    mediaUrlFor,
  });

  const server = createRelayServer({
    config,
    store,
    log: log.child({ component: "relay" }),
    execute: router.execute,
    health: () => ({ whatsapp: whatsapp.state(), version: packageVersion() }),
    ...(fakePort === null
      ? {}
      : {
          debugInbound: async (body: unknown): Promise<void> => {
            await fakePort.inject(inboundFromDebugBody(body));
          },
        }),
  });
  relay = server;

  whatsapp.onMessage(router.onInbound);

  const shutdown = async (): Promise<void> => {
    try {
      await server.close();
    } catch (err: unknown) {
      log.warn({ err: String(err) }, "relay shutdown failed");
    }
    try {
      await whatsapp.stop();
    } catch (err: unknown) {
      log.warn({ err: String(err) }, "whatsapp shutdown failed");
    }
    try {
      store.close();
    } catch (err: unknown) {
      log.warn({ err: String(err) }, "store close failed");
    }
  };

  try {
    await whatsapp.start();
  } catch (err: unknown) {
    log.error({ err: String(err) }, "could not start the WhatsApp client");
    await shutdown();
    return { ok: false, code: EXIT_FAILURE };
  }

  // Refuse to listen unpaired: a Hermes instance that connects would silently
  // never receive anything.
  if (whatsapp.state() === "unpaired") {
    io.err(PAIRING_HINT);
    await shutdown();
    return { ok: false, code: EXIT_CONFIG };
  }

  let address: { host: string; port: number };
  try {
    address = await server.listen();
  } catch (err: unknown) {
    log.error({ err: String(err) }, "could not bind the relay server");
    await shutdown();
    return { ok: false, code: EXIT_FAILURE };
  }
  boundPort = address.port;

  log.info(
    {
      profiles: config.profiles.map((p) => ({
        name: p.name,
        gatewayId: p.gatewayId,
        routes: p.routes.length,
      })),
      defaultProfile: config.defaultProfile,
    },
    "whatrouter is serving; run `whatrouter env <profile>` for each Hermes instance"
  );

  return {
    ok: true,
    handle: {
      address,
      relay: server,
      router,
      store,
      whatsapp,
      fake: fakePort,
      close: shutdown,
    },
  };
}

/** The CLI entry point: boots, then waits for a signal and shuts down cleanly. */
export async function runServe(opts: ServeOptions): Promise<number> {
  const started = await startServe(opts);
  if (!started.ok) {
    return started.code;
  }
  const { handle } = started;

  if (opts.signals === false) {
    await handle.close();
    return EXIT_OK;
  }

  const signal = await new Promise<NodeJS.Signals>((resolve) => {
    const onSignal = (received: NodeJS.Signals): void => {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      resolve(received);
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
  opts.log.info({ signal }, "shutting down");
  await handle.close();
  return EXIT_OK;
}

// ------------------------------------------------------- POST /debug/inbound

const MESSAGE_KINDS = new Set<string>([
  "text",
  "image",
  "video",
  "voice",
  "audio",
  "document",
  "sticker",
  "location",
  "other",
]);
const MEDIA_KINDS = new Set<string>(["image", "video", "voice", "audio", "document", "sticker"]);

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function mediaKindFor(kind: string | undefined, mime: string): MediaKind {
  if (kind !== undefined && MEDIA_KINDS.has(kind)) {
    return kind as MediaKind;
  }
  if (mime.startsWith("image/")) {
    return "image";
  }
  if (mime.startsWith("video/")) {
    return "video";
  }
  if (mime.startsWith("audio/")) {
    return "audio";
  }
  return "document";
}

/**
 * Turns the tiny `POST /debug/inbound` body into a full `InboundMessage`.
 *
 * ```jsonc
 * {
 *   "chatId": "34600000001@s.whatsapp.net",   // required
 *   "text": "hola",                            // default ""
 *   "chatType": "dm" | "group",               // default: inferred from chatId
 *   "senderId": "…", "senderIdAlt": "…",      // default: chatId / null
 *   "senderName": "…", "chatName": "…",       // default: the id's digits
 *   "messageId": "…",                          // default: debug-<n>
 *   "mentionsBot": false, "mentionedIds": [],
 *   "quoted": {"messageId","text","senderId","isFromBot"},
 *   "kind": "text|image|…",                    // default: from the media, else text
 *   "mediaBase64": "…", "mediaMime": "…", "mediaFilename": "…", "mediaCaption": "…",
 *   "timestamp": 1758000000
 * }
 * ```
 */
let debugCounter = 0;

export function inboundFromDebugBody(body: unknown): InboundMessage {
  const raw = asRecord(body);

  const chatIdRaw = optionalString(raw["chatId"]);
  if (chatIdRaw === undefined) {
    throw new Error("chatId is required");
  }
  // `+34600000001`, `34600000001` and `…@s.whatsapp.net` all land on the same id.
  const chatId = canonicalChatId(chatIdRaw);

  const chatTypeRaw = optionalString(raw["chatType"]);
  const chatType: ChatType =
    chatTypeRaw === "group" || chatTypeRaw === "dm"
      ? chatTypeRaw
      : isGroupJid(chatId)
        ? "group"
        : "dm";

  const senderId = canonicalChatId(optionalString(raw["senderId"]) ?? chatId);
  const senderIdAltRaw = optionalString(raw["senderIdAlt"]);
  const senderIdAlt = senderIdAltRaw === undefined ? null : canonicalChatId(senderIdAltRaw);
  const senderName = optionalString(raw["senderName"]) ?? digitsOf(senderId);
  const chatName =
    optionalString(raw["chatName"]) ?? (chatType === "group" ? digitsOf(chatId) : senderName);

  const text = typeof raw["text"] === "string" ? raw["text"] : "";

  let media: InboundMedia | null = null;
  const base64 = optionalString(raw["mediaBase64"]);
  const kindRaw = optionalString(raw["kind"]);
  if (base64 !== undefined) {
    const bytes = new Uint8Array(Buffer.from(base64, "base64"));
    const mime = optionalString(raw["mediaMime"]) ?? "application/octet-stream";
    const filename = optionalString(raw["mediaFilename"]);
    const caption = optionalString(raw["mediaCaption"]);
    media = {
      kind: mediaKindFor(kindRaw, mime),
      mime,
      bytes,
      size: bytes.byteLength,
      ...(filename === undefined ? {} : { filename }),
      ...(caption === undefined ? {} : { caption }),
    };
  }

  const kind: MessageKind =
    kindRaw !== undefined && MESSAGE_KINDS.has(kindRaw)
      ? (kindRaw as MessageKind)
      : media !== null
        ? (media.kind as MessageKind)
        : "text";

  const quotedRaw = asRecord(raw["quoted"]);
  const quotedId = optionalString(quotedRaw["messageId"]);
  const quoted: QuotedMessage | null =
    quotedId === undefined
      ? null
      : {
          messageId: quotedId,
          text: typeof quotedRaw["text"] === "string" ? quotedRaw["text"] : "",
          senderId: normalizeJid(optionalString(quotedRaw["senderId"]) ?? ""),
          isFromBot: quotedRaw["isFromBot"] === true,
        };

  const mentionedIds = Array.isArray(raw["mentionedIds"])
    ? raw["mentionedIds"]
        .filter((v): v is string => typeof v === "string")
        .map((v) => normalizeJid(v))
    : [];

  debugCounter += 1;

  return {
    messageId: optionalString(raw["messageId"]) ?? `debug-${debugCounter}`,
    chatId,
    chatIdRaw: optionalString(raw["chatIdRaw"]) ?? chatIdRaw,
    chatType,
    chatName,
    senderId,
    senderIdAlt,
    senderName,
    text,
    kind,
    timestamp:
      typeof raw["timestamp"] === "number" && Number.isFinite(raw["timestamp"])
        ? Math.floor(raw["timestamp"])
        : Math.floor(Date.now() / 1000),
    mentionsBot: raw["mentionsBot"] === true,
    mentionedIds,
    quoted,
    media,
    downloadFailed: raw["downloadFailed"] === true,
  };
}
