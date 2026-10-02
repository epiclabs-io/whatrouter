/**
 * Media store: bytes on disk under `<dataDir>/media/<id>`, one index row in
 * sqlite. Ownership is per profile — `GET /relay/media/:id` must 404 (never
 * 403) for a profile that does not own the row, so one Hermes instance cannot
 * probe another's media.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export interface MediaMeta {
  id: string;
  profile: string;
  mime: string;
  filename: string | null;
  size: number;
  createdAt: number;
}

export interface MediaPutResult {
  id: string;
  size: number;
  /** Present when the store was given a URL builder (see `mediaUrl`). */
  url?: string;
}

export interface MediaStore {
  /** Directory the bytes live in. */
  readonly dir: string;
  readonly maxBytes: number;
  put(
    profile: string,
    bytes: Uint8Array,
    mime: string,
    filename?: string | null,
    nowSeconds?: number
  ): MediaPutResult;
  get(id: string): { meta: MediaMeta; bytes: Buffer } | null;
  getMeta(id: string): MediaMeta | null;
  delete(id: string): boolean;
  /** Deletes all metadata and files owned by one profile. */
  purgeProfile(profile: string): number;
  purgeOlderThan(retentionSeconds: number, nowSeconds?: number): number;
}

export class MediaTooLargeError extends Error {
  readonly code = "media_too_large";
  readonly size: number;
  readonly limit: number;
  constructor(size: number, limit: number) {
    super(`media is ${size} bytes, limit is ${limit}`);
    this.name = "MediaTooLargeError";
    this.size = size;
    this.limit = limit;
  }
}

export interface MediaStoreOptions {
  dir: string;
  maxBytes: number;
  /** Optional: makes `put` return a ready-to-embed public URL. */
  urlFor?: (id: string) => string;
}

const ID_RE = /^[0-9a-f]{32}$/;

const DEFAULT_MIME = "application/octet-stream";

function rowToMeta(row: Record<string, unknown>): MediaMeta {
  return {
    id: String(row["id"]),
    profile: String(row["profile"]),
    mime: String(row["mime"]),
    filename:
      row["filename"] === null || row["filename"] === undefined ? null : String(row["filename"]),
    size: Number(row["size"]),
    createdAt: Number(row["created_at"]),
  };
}

export function createMediaStore(db: DatabaseSync, opts: MediaStoreOptions): MediaStore {
  const insert = db.prepare(
    "INSERT INTO media(id, profile, mime, filename, size, created_at) VALUES(?, ?, ?, ?, ?, ?)"
  );
  const selectOne = db.prepare("SELECT * FROM media WHERE id = ?");
  const deleteOne = db.prepare("DELETE FROM media WHERE id = ?");
  const selectExpired = db.prepare("SELECT id FROM media WHERE created_at < ?");
  const selectProfile = db.prepare("SELECT id FROM media WHERE profile = ?");

  let dirReady = false;
  function ensureDir(): void {
    if (dirReady) {
      return;
    }
    mkdirSync(opts.dir, { recursive: true });
    dirReady = true;
  }

  function pathOf(id: string): string | null {
    return ID_RE.test(id) ? join(opts.dir, id) : null;
  }

  function unlink(id: string): void {
    const path = pathOf(id);
    if (path === null) {
      return;
    }
    try {
      rmSync(path, { force: true });
    } catch {
      /* best effort: the row goes away either way */
    }
  }

  return {
    dir: opts.dir,
    maxBytes: opts.maxBytes,

    put(profile, bytes, mime, filename, nowSeconds = Math.floor(Date.now() / 1000)) {
      if (bytes.byteLength > opts.maxBytes) {
        throw new MediaTooLargeError(bytes.byteLength, opts.maxBytes);
      }
      ensureDir();
      const id = randomBytes(16).toString("hex");
      const path = join(opts.dir, id);
      writeFileSync(path, bytes);
      try {
        insert.run(
          id,
          profile,
          mime === "" ? DEFAULT_MIME : mime,
          filename === undefined || filename === null || filename === "" ? null : filename,
          bytes.byteLength,
          Math.floor(nowSeconds)
        );
      } catch (err) {
        try {
          rmSync(path, { force: true });
        } catch {
          /* ignore */
        }
        throw err;
      }
      const url = opts.urlFor?.(id);
      return url === undefined
        ? { id, size: bytes.byteLength }
        : { id, size: bytes.byteLength, url };
    },

    getMeta(id) {
      if (!ID_RE.test(id)) {
        return null;
      }
      const row = selectOne.get(id) as Record<string, unknown> | undefined;
      return row === undefined ? null : rowToMeta(row);
    },

    get(id) {
      if (!ID_RE.test(id)) {
        return null;
      }
      const row = selectOne.get(id) as Record<string, unknown> | undefined;
      if (row === undefined) {
        return null;
      }
      const meta = rowToMeta(row);
      const path = join(opts.dir, meta.id);
      if (!existsSync(path)) {
        // Index and disk disagree (manual cleanup, lost volume): drop the row.
        deleteOne.run(meta.id);
        return null;
      }
      return { meta, bytes: readFileSync(path) };
    },

    delete(id) {
      if (!ID_RE.test(id)) {
        return false;
      }
      const removed = Number(deleteOne.run(id).changes) > 0;
      if (removed) {
        unlink(id);
      }
      return removed;
    },

    purgeProfile(profile) {
      const rows = selectProfile.all(profile) as Array<{ id?: unknown }>;
      let removed = 0;
      for (const row of rows) {
        const id = String(row.id ?? "");
        if (id !== "" && Number(deleteOne.run(id).changes) > 0) {
          removed += 1;
        }
        unlink(id);
      }
      return removed;
    },

    purgeOlderThan(retentionSeconds, nowSeconds = Math.floor(Date.now() / 1000)) {
      const cutoff = Math.floor(nowSeconds) - Math.floor(retentionSeconds);
      const rows = selectExpired.all(cutoff) as Array<{ id?: unknown }>;
      let removed = 0;
      for (const row of rows) {
        const id = String(row.id ?? "");
        if (id === "") {
          continue;
        }
        if (Number(deleteOne.run(id).changes) > 0) {
          removed += 1;
        }
        unlink(id);
      }
      return removed;
    },
  };
}
