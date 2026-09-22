import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MediaTooLargeError, openStore, type Store } from '../../src/store/db.js';

const temps: string[] = [];
const stores: Store[] = [];

function fixture(opts: { maxBytes?: number; urlFor?: boolean } = {}): { store: Store; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'whatrouter-media-'));
  temps.push(dir);
  const store = openStore(join(dir, 'db.sqlite'), {
    mediaDir: join(dir, 'media'),
    maxMediaBytes: opts.maxBytes ?? 1024,
    ...(opts.urlFor === true
      ? { mediaUrlFor: (id: string): string => `https://wr.example/relay/media/${id}` }
      : {}),
  });
  stores.push(store);
  return { store, dir };
}

afterEach(() => {
  while (stores.length > 0) {
    try {
      stores.pop()?.close();
    } catch {
      /* already closed */
    }
  }
  while (temps.length > 0) rmSync(temps.pop() as string, { recursive: true, force: true });
});

describe('media put/get', () => {
  it('writes bytes to disk and indexes them', () => {
    const { store, dir } = fixture();
    const bytes = Buffer.from('hello media', 'utf8');
    const put = store.media.put('work', bytes, 'text/plain', 'note.txt');

    expect(put.id).toMatch(/^[0-9a-f]{32}$/);
    expect(put.size).toBe(bytes.byteLength);
    expect(existsSync(join(dir, 'media', put.id))).toBe(true);

    const got = store.media.get(put.id);
    expect(got?.bytes.toString('utf8')).toBe('hello media');
    expect(got?.meta).toMatchObject({
      id: put.id,
      profile: 'work',
      mime: 'text/plain',
      filename: 'note.txt',
      size: bytes.byteLength,
    });
    expect(store.media.getMeta(put.id)?.profile).toBe('work');
  });

  it('returns a public URL when the store knows how to build one', () => {
    const { store } = fixture({ urlFor: true });
    const put = store.media.put('work', Buffer.from('x'), 'image/png');
    expect(put.url).toBe(`https://wr.example/relay/media/${put.id}`);
  });

  it('rejects oversized media and leaves nothing behind', () => {
    const { store, dir } = fixture({ maxBytes: 8 });
    expect(() => store.media.put('work', Buffer.alloc(9), 'application/octet-stream')).toThrow(
      MediaTooLargeError,
    );
    const mediaDir = join(dir, 'media');
    expect(existsSync(mediaDir) ? readdirSync(mediaDir).length : 0).toBe(0);
  });

  it('returns null for unknown or malformed ids (no path traversal)', () => {
    const { store } = fixture();
    expect(store.media.get('0'.repeat(32))).toBeNull();
    expect(store.media.get('../../etc/passwd')).toBeNull();
    expect(store.media.getMeta('not-hex')).toBeNull();
  });

  it('drops the row when the file disappeared underneath it', () => {
    const { store, dir } = fixture();
    const put = store.media.put('work', Buffer.from('bye'), 'text/plain');
    rmSync(join(dir, 'media', put.id));
    expect(store.media.get(put.id)).toBeNull();
    expect(store.media.getMeta(put.id)).toBeNull();
  });
});

describe('media purge', () => {
  it('deletes expired rows and their files, keeping fresh ones', () => {
    const { store, dir } = fixture();
    const now = 1_754_700_000;
    const old = store.media.put('work', Buffer.from('old'), 'text/plain', null, now - 1000);
    const fresh = store.media.put('work', Buffer.from('fresh'), 'text/plain', null, now - 10);

    expect(store.media.purgeOlderThan(100, now)).toBe(1);
    expect(store.media.getMeta(old.id)).toBeNull();
    expect(existsSync(join(dir, 'media', old.id))).toBe(false);
    expect(store.media.getMeta(fresh.id)).not.toBeNull();
    expect(existsSync(join(dir, 'media', fresh.id))).toBe(true);
    expect(store.media.purgeOlderThan(100, now)).toBe(0);
  });

  it('deletes one object explicitly', () => {
    const { store, dir } = fixture();
    const put = store.media.put('work', Buffer.from('gone'), 'text/plain');
    expect(store.media.delete(put.id)).toBe(true);
    expect(store.media.delete(put.id)).toBe(false);
    expect(existsSync(join(dir, 'media', put.id))).toBe(false);
  });
});
