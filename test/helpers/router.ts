/** Fixtures for the router tests (not a test file itself). */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../../src/store/db.js";
import type { Config, ProfileConfig, Route } from "../../src/config/schema.js";
import { MediaTooLargeError } from "../../src/store/media.js";
import type { InboundMedia, InboundMessage } from "../../src/whatsapp/port.js";
import { testConfig, testProfile } from "./relay.js";

export const ALICE = "34600000001@s.whatsapp.net";
export const BOB = "34600000002@s.whatsapp.net";
export const CAROL = "34600000009@s.whatsapp.net";
export const GROUP = "120363000000000001@g.us";
/** A group that is deliberately absent from the config's registry. */
export const ROGUE = "120363000000000099@g.us";

/** A DM from Alice, text "hola" — override anything that matters to the test. */
export function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: "wa-1",
    chatId: ALICE,
    chatIdRaw: ALICE,
    chatType: "dm",
    chatName: "Alice",
    senderId: ALICE,
    senderIdAlt: null,
    senderName: "Alice",
    text: "hola",
    kind: "text",
    timestamp: 1_758_000_000,
    mentionsBot: false,
    mentionedIds: [],
    quoted: null,
    media: null,
    ...overrides,
  };
}

export interface MediaFixture {
  media: InboundMedia;
  /** Counts calls and records the cap it was asked for. */
  download: (maxBytes: number) => Promise<Uint8Array>;
  calls: number[];
}

/**
 * Inbound media backed by bytes already in memory, standing in for a WhatsApp
 * download. `behaviour` decides what the download does, so a test can make it
 * overrun the cap without a socket.
 */
export function inboundMedia(
  overrides: {
    kind?: InboundMedia["kind"];
    mime?: string;
    filename?: string;
    caption?: string;
    declaredSize?: number | null;
    bytes?: Uint8Array;
    behaviour?: (maxBytes: number) => Promise<Uint8Array>;
  } = {}
): MediaFixture {
  const bytes = overrides.bytes ?? new Uint8Array([1, 2, 3, 4]);
  const calls: number[] = [];
  const download = async (maxBytes: number): Promise<Uint8Array> => {
    calls.push(maxBytes);
    if (overrides.behaviour !== undefined) {
      return await overrides.behaviour(maxBytes);
    }
    if (bytes.byteLength > maxBytes) {
      throw new MediaTooLargeError(bytes.byteLength, maxBytes);
    }
    return bytes;
  };
  const media: InboundMedia = {
    kind: overrides.kind ?? "image",
    mime: overrides.mime ?? "image/jpeg",
    declaredSize: overrides.declaredSize === undefined ? bytes.byteLength : overrides.declaredSize,
    download,
    ...(overrides.filename === undefined ? {} : { filename: overrides.filename }),
    ...(overrides.caption === undefined ? {} : { caption: overrides.caption }),
  };
  return { media, download, calls };
}

export function dmRoute(id: string): Route {
  return { kind: "dm", id };
}

export function groupRoute(
  id: string,
  overrides: { requireMention?: boolean; allowedSenders?: string[] } = {}
): Route {
  return {
    kind: "group",
    id: id as `${string}@g.us`,
    requireMention: overrides.requireMention,
    ...(overrides.allowedSenders === undefined ? {} : { allowedSenders: overrides.allowedSenders }),
  };
}

export function profileWith(name: string, routes: Route[]): ProfileConfig {
  return testProfile(name, { routes });
}

/** Two profiles: `a` owns Alice's DM and the group, `b` owns Bob's DM. */
export function routerConfig(overrides: Partial<Config> = {}): Config {
  return testConfig({
    groups: {
      [GROUP]: {
        displayName: "Team",
        adminsSeen: null,
        listenSource: "explicit",
        listen: ["*"],
      },
    },
    profiles: [
      profileWith("a", [dmRoute(ALICE), groupRoute(GROUP)]),
      profileWith("b", [dmRoute(BOB)]),
    ],
    ...overrides,
  });
}

/** An on-disk store in a throwaway directory (node:sqlite has no shared cache). */
/** A store in a throwaway directory, with the boot-time media cap if asked. */
export function tempStore(maxMediaBytes?: number): { store: Store; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "whatrouter-router-"));
  const store = openStore(join(dir, "whatrouter.sqlite"), {
    mediaDir: join(dir, "media"),
    ...(maxMediaBytes === undefined ? {} : { maxMediaBytes }),
  });
  return { store, dir };
}
