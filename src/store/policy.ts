/**
 * Per-profile relay policy, pushed by the gateway over `POST /relay/policy`.
 * The router reads it for the mention-gating precedence (route > policy > default).
 * Validation is deliberately loose: unknown keys are dropped, wrong types are
 * ignored, and a policy that says nothing useful is still stored.
 */
import type { DatabaseSync } from "node:sqlite";

export interface RelayPolicy {
  requireAddress?: boolean;
}

export interface PolicyStore {
  set(profile: string, policy: unknown, nowSeconds?: number): RelayPolicy;
  get(profile: string): RelayPolicy | null;
  delete(profile: string): boolean;
  /** Every profile that still has a policy, deduplicated. */
  profiles(): string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pick(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

/** Keeps only the field the router reads, and only when it has the right type. */
export function normalizePolicy(value: unknown): RelayPolicy {
  if (!isRecord(value)) {
    return {};
  }
  const out: RelayPolicy = {};

  // Hermes speaks camelCase here; snake_case is accepted defensively.
  const requireAddress = pick(value, "requireAddress", "require_address");
  if (typeof requireAddress === "boolean") {
    out.requireAddress = requireAddress;
  }

  return out;
}

export function createPolicyStore(db: DatabaseSync): PolicyStore {
  const upsert = db.prepare(
    `INSERT INTO policies(profile, policy, updated_at) VALUES(?, ?, ?)
       ON CONFLICT(profile) DO UPDATE SET policy = excluded.policy, updated_at = excluded.updated_at`
  );
  const select = db.prepare("SELECT policy FROM policies WHERE profile = ?");
  const remove = db.prepare("DELETE FROM policies WHERE profile = ?");
  const distinctProfiles = db.prepare("SELECT DISTINCT profile FROM policies");

  return {
    set(profile, policy, nowSeconds = Math.floor(Date.now() / 1000)) {
      const normalized = normalizePolicy(policy);
      upsert.run(profile, JSON.stringify(normalized), Math.floor(nowSeconds));
      return normalized;
    },

    get(profile) {
      const row = select.get(profile) as { policy?: string } | undefined;
      if (row?.policy === undefined) {
        return null;
      }
      try {
        return normalizePolicy(JSON.parse(row.policy));
      } catch {
        return null;
      }
    },

    delete(profile) {
      return Number(remove.run(profile).changes) > 0;
    },

    profiles() {
      return (distinctProfiles.all() as Array<{ profile?: string }>)
        .map((row) => row.profile)
        .filter((p): p is string => typeof p === "string");
    },
  };
}
