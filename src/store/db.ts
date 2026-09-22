/**
 * sqlite (Node 24 built-in `node:sqlite`) — the only durable state WhatRouter
 * keeps besides the Baileys auth files: the inbound buffer, the per-profile
 * "buffered only" flips, gateway-pushed policies and the media index.
 *
 * Migrations are idempotent and forward-only, tracked in `schema_version`.
 */
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createBufferStore, type BufferStore } from './buffer.js';
import { createMediaStore, type MediaStore } from './media.js';
import { createPolicyStore, type PolicyStore } from './policy.js';
import type { Config } from '../config/schema.js';

export type { BufferStore, BufferedEvent, AppendResult } from './buffer.js';
export type { MediaStore, MediaMeta, MediaPutResult } from './media.js';
export { MediaTooLargeError } from './media.js';
export type { PolicyStore, RelayPolicy } from './policy.js';

export interface Store {
  readonly db: DatabaseSync;
  readonly path: string;
  readonly buffer: BufferStore;
  readonly policy: PolicyStore;
  readonly media: MediaStore;
  close(): void;
}

export interface OpenStoreOptions {
  /** Where media bytes live. Default: `<dir of the db file>/media`. */
  mediaDir?: string;
  /** Hard cap enforced by `media.put`. Default: 25 MiB (the config default). */
  maxMediaBytes?: number;
  /** Lets `media.put` return a public URL straight away. */
  mediaUrlFor?: (id: string) => string;
}

export const DEFAULT_MAX_MEDIA_BYTES = 26_214_400;

const MIGRATIONS: string[] = [
  // 1: buffer + flips + policies + media
  `
  CREATE TABLE IF NOT EXISTS buffer (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    profile    TEXT    NOT NULL,
    event      TEXT    NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS buffer_profile_seq ON buffer(profile, seq);
  CREATE INDEX IF NOT EXISTS buffer_created_at ON buffer(created_at);

  CREATE TABLE IF NOT EXISTS flips (
    profile       TEXT    PRIMARY KEY,
    buffered_only INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS policies (
    profile    TEXT    PRIMARY KEY,
    policy     TEXT    NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS media (
    id         TEXT    PRIMARY KEY,
    profile    TEXT    NOT NULL,
    mime       TEXT    NOT NULL,
    filename   TEXT,
    size       INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS media_profile ON media(profile);
  CREATE INDEX IF NOT EXISTS media_created_at ON media(created_at);
  `,
];

function migrate(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
    | { version?: number }
    | undefined;
  let current = Number(row?.version ?? 0);
  if (row === undefined) db.prepare('INSERT INTO schema_version(version) VALUES(0)').run();

  const setVersion = db.prepare('UPDATE schema_version SET version = ?');
  while (current < MIGRATIONS.length) {
    const sql = MIGRATIONS[current];
    if (sql === undefined) break;
    db.exec(sql);
    current += 1;
    setVersion.run(current);
  }
}

function defaultMediaDir(path: string): string {
  if (path === ':memory:' || path === '') {
    // In-memory stores are for tests; give them a scratch directory that is
    // only created if media is actually written.
    return join(tmpdir(), `whatrouter-media-${process.pid}`);
  }
  return join(dirname(resolve(path)), 'media');
}

export function openStore(path: string, opts: OpenStoreOptions = {}): Store {
  if (path !== ':memory:' && path !== '') {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);

  const mediaDir = opts.mediaDir ?? defaultMediaDir(path);
  const media = createMediaStore(db, {
    dir: mediaDir,
    maxBytes: opts.maxMediaBytes ?? DEFAULT_MAX_MEDIA_BYTES,
    ...(opts.mediaUrlFor === undefined ? {} : { urlFor: opts.mediaUrlFor }),
  });

  return {
    db,
    path,
    buffer: createBufferStore(db),
    policy: createPolicyStore(db),
    media,
    close() {
      db.close();
    },
  };
}

/** `<data_dir>/whatrouter.sqlite` + `<data_dir>/media`, as documented. */
export function storePathsFor(config: Config): { dbPath: string; mediaDir: string } {
  const dataDir = isAbsolute(config.dataDir) ? config.dataDir : resolve(config.dataDir);
  return { dbPath: join(dataDir, 'whatrouter.sqlite'), mediaDir: join(dataDir, 'media') };
}

/** The `serve` path: opens the store the config points at. */
export function openStoreFromConfig(config: Config, opts: OpenStoreOptions = {}): Store {
  const { dbPath, mediaDir } = storePathsFor(config);
  return openStore(dbPath, {
    mediaDir,
    maxMediaBytes: config.media.maxBytes,
    ...opts,
  });
}
