/** Fixtures for the WP4 router tests (not a test file itself). */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../src/store/db.js';
import type { Config, ProfileConfig, Route } from '../../src/config/schema.js';
import type { InboundMessage } from '../../src/whatsapp/port.js';
import { testConfig, testProfile } from './relay.js';

export const ALICE = '34600000001@s.whatsapp.net';
export const BOB = '34600000002@s.whatsapp.net';
export const CAROL = '34600000009@s.whatsapp.net';
export const GROUP = '120363000000000001@g.us';

/** A DM from Alice, text "hola" — override anything that matters to the test. */
export function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: 'wa-1',
    chatId: ALICE,
    chatIdRaw: ALICE,
    chatType: 'dm',
    chatName: 'Alice',
    senderId: ALICE,
    senderIdAlt: null,
    senderName: 'Alice',
    text: 'hola',
    kind: 'text',
    timestamp: 1_758_000_000,
    mentionsBot: false,
    mentionedIds: [],
    quoted: null,
    media: null,
    downloadFailed: false,
    ...overrides,
  };
}

export function dmRoute(id: string): Route {
  return { kind: 'dm', id };
}

export function groupRoute(
  id: string,
  overrides: { requireMention?: boolean; allowedSenders?: string[] } = {},
): Route {
  return {
    kind: 'group',
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
    profiles: [
      profileWith('a', [dmRoute(ALICE), groupRoute(GROUP)]),
      profileWith('b', [dmRoute(BOB)]),
    ],
    ...overrides,
  });
}

/** An on-disk store in a throwaway directory (node:sqlite has no shared cache). */
export function tempStore(): { store: Store; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'whatrouter-router-'));
  const store = openStore(join(dir, 'whatrouter.sqlite'), { mediaDir: join(dir, 'media') });
  return { store, dir };
}
