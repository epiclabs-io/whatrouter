/**
 * Durable, ack-gated per-profile inbound buffer (docs/DESIGN.md §"Buffer /
 * delivery state machine"). Rows survive restarts; a row is deleted only when
 * the gateway acks its `bufferId`, which is what makes replay exactly-once as
 * observed by the gateway.
 *
 */
import type { DatabaseSync } from "node:sqlite";
import type { RelayEvent } from "../relay/frames.js";

export interface BufferedEvent {
  seq: number;
  event: RelayEvent;
}

export interface AppendResult {
  seq: number;
  /** True when this row is the only one for the profile (wake-poke trigger). */
  wasEmpty: boolean;
}

export interface BufferStore {
  append(profile: string, event: RelayEvent, nowSeconds?: number): AppendResult;
  nextUnacked(profile: string): BufferedEvent | null;
  ack(profile: string, seq: number): boolean;
  count(profile: string): number;
  /** Deletes all buffered events for one profile. */
  purgeProfile(profile: string): number;
  purgeOlderThan(maxAgeSeconds: number, nowSeconds?: number): number;
  profiles(): string[];
}

export function createBufferStore(db: DatabaseSync): BufferStore {
  const insert = db.prepare("INSERT INTO buffer(profile, event, created_at) VALUES(?, ?, ?)");
  const selectNext = db.prepare(
    "SELECT seq, event FROM buffer WHERE profile = ? ORDER BY seq ASC LIMIT 1"
  );
  const deleteRow = db.prepare("DELETE FROM buffer WHERE profile = ? AND seq = ?");
  const countRows = db.prepare("SELECT COUNT(*) AS n FROM buffer WHERE profile = ?");
  const purge = db.prepare("DELETE FROM buffer WHERE created_at < ?");
  const purgeProfileRows = db.prepare("DELETE FROM buffer WHERE profile = ?");
  const distinctProfiles = db.prepare("SELECT DISTINCT profile FROM buffer");

  function countOf(profile: string): number {
    const row = countRows.get(profile) as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  }

  function transaction<T>(fn: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* the transaction was already rolled back */
      }
      throw err;
    }
  }

  return {
    append(profile, event, nowSeconds = Math.floor(Date.now() / 1000)) {
      return transaction(() => {
        const info = insert.run(profile, JSON.stringify(event), Math.floor(nowSeconds));
        return { seq: Number(info.lastInsertRowid), wasEmpty: countOf(profile) === 1 };
      });
    },

    nextUnacked(profile) {
      const row = selectNext.get(profile) as { seq?: number; event?: string } | undefined;
      if (row?.seq === undefined || row.event === undefined) {
        return null;
      }
      try {
        return { seq: Number(row.seq), event: JSON.parse(row.event) as RelayEvent };
      } catch {
        // A row we can never deliver would block the queue forever: drop it.
        deleteRow.run(profile, row.seq);
        return null;
      }
    },

    ack(profile, seq) {
      return Number(deleteRow.run(profile, seq).changes) > 0;
    },

    count: countOf,

    purgeProfile(profile) {
      return Number(purgeProfileRows.run(profile).changes);
    },

    purgeOlderThan(maxAgeSeconds, nowSeconds = Math.floor(Date.now() / 1000)) {
      const cutoff = Math.floor(nowSeconds) - Math.floor(maxAgeSeconds);
      return Number(purge.run(cutoff).changes);
    },

    profiles() {
      return (distinctProfiles.all() as Array<{ profile?: string }>)
        .map((r) => r.profile)
        .filter((p): p is string => typeof p === "string");
    },
  };
}
