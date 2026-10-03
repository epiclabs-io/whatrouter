import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openStore, type Store } from "../../src/store/db.js";
import { testEvent } from "../helpers/relay.js";

const temps: string[] = [];
const stores: Store[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "whatrouter-store-"));
  temps.push(dir);
  return dir;
}

function memStore(): Store {
  const store = openStore(":memory:", { mediaDir: tempDir() });
  stores.push(store);
  return store;
}

afterEach(() => {
  while (stores.length > 0) {
    try {
      stores.pop()?.close();
    } catch {
      /* already closed by the test */
    }
  }
  while (temps.length > 0) {
    rmSync(temps.pop() as string, { recursive: true, force: true });
  }
});

describe("buffer append/next/ack", () => {
  it("reports wasEmpty only for the first row of a profile", () => {
    const store = memStore();
    expect(store.buffer.append("work", testEvent("one"))).toMatchObject({ wasEmpty: true });
    expect(store.buffer.append("work", testEvent("two"))).toMatchObject({ wasEmpty: false });
    // Other profiles have their own emptiness.
    expect(store.buffer.append("home", testEvent("three"))).toMatchObject({ wasEmpty: true });
    expect(store.buffer.count("work")).toBe(2);
    expect(store.buffer.count("home")).toBe(1);
  });

  it("hands out the oldest unacked row and only removes it on ack", () => {
    const store = memStore();
    const first = store.buffer.append("work", testEvent("one"));
    store.buffer.append("work", testEvent("two"));

    const next = store.buffer.nextUnacked("work");
    expect(next?.seq).toBe(first.seq);
    expect(next?.event.text).toBe("one");
    // Still there until acked: replay is ack-gated.
    expect(store.buffer.nextUnacked("work")?.seq).toBe(first.seq);

    expect(store.buffer.ack("work", first.seq)).toBe(true);
    expect(store.buffer.ack("work", first.seq)).toBe(false);
    expect(store.buffer.nextUnacked("work")?.event.text).toBe("two");
    expect(store.buffer.count("work")).toBe(1);
  });

  it("keeps profiles isolated", () => {
    const store = memStore();
    store.buffer.append("work", testEvent("w"));
    store.buffer.append("home", testEvent("h"));
    expect(store.buffer.nextUnacked("work")?.event.text).toBe("w");
    expect(store.buffer.nextUnacked("home")?.event.text).toBe("h");
    expect(store.buffer.profiles().sort()).toEqual(["home", "work"]);
    expect(store.buffer.nextUnacked("nobody")).toBeNull();
  });
});

describe("purge", () => {
  it("purges one profile's events without touching another", () => {
    const store = memStore();
    store.buffer.append("work", testEvent("work"));
    store.buffer.append("home", testEvent("home"));
    expect(store.buffer.purgeProfile("work")).toBe(1);
    expect(store.buffer.count("work")).toBe(0);
    expect(store.buffer.count("home")).toBe(1);
  });

  it("removes rows older than the max age and leaves fresh ones", () => {
    const store = memStore();
    const now = 1_754_700_000;
    store.buffer.append("work", testEvent("old"), now - 100);
    store.buffer.append("work", testEvent("new"), now - 1);
    expect(store.buffer.purgeOlderThan(50, now)).toBe(1);
    expect(store.buffer.count("work")).toBe(1);
    expect(store.buffer.nextUnacked("work")?.event.text).toBe("new");
    expect(store.buffer.purgeOlderThan(50, now)).toBe(0);
  });
});

describe("policies", () => {
  it("stores loosely-validated policies and drops unknown keys", () => {
    const store = memStore();
    store.policy.set("work", {
      platform: "whatsapp",
      requireAddress: false,
      freeResponseScopes: ["dm", 7],
      allowOtherBots: true,
      somethingNew: "ignored",
    });
    expect(store.policy.get("work")).toEqual({ requireAddress: false });
  });

  it("overwrites on repeat and returns null for unknown profiles", () => {
    const store = memStore();
    store.policy.set("work", { requireAddress: true });
    store.policy.set("work", { requireAddress: false });
    expect(store.policy.get("work")).toEqual({ requireAddress: false });
    expect(store.policy.get("home")).toBeNull();
    expect(store.policy.set("work", "not an object")).toEqual({});
  });
});

describe("durability", () => {
  it("drops the obsolete flips table when upgrading a version-1 database", () => {
    const dir = tempDir();
    const path = join(dir, "whatrouter.sqlite");
    openStore(path, { mediaDir: join(dir, "media") }).close();

    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE flips (profile TEXT PRIMARY KEY, buffered_only INTEGER NOT NULL);
      INSERT INTO flips(profile, buffered_only) VALUES ('work', 1);
      UPDATE schema_version SET version = 1;
    `);
    legacy.close();

    const migrated = openStore(path, { mediaDir: join(dir, "media") });
    stores.push(migrated);
    expect(
      migrated.db.prepare("SELECT name FROM sqlite_master WHERE name = 'flips'").get()
    ).toBeUndefined();
    expect(
      (migrated.db.prepare("SELECT version FROM schema_version").get() as { version: number })
        .version
    ).toBe(2);
  });

  it("survives a reopen of the same file (buffer, policy)", () => {
    const dir = tempDir();
    const path = join(dir, "nested", "whatrouter.sqlite");

    const first = openStore(path, { mediaDir: join(dir, "media") });
    const row = first.buffer.append("work", testEvent("survivor"));
    first.buffer.append("work", testEvent("second"));
    first.policy.set("work", { requireAddress: true });
    first.close();

    const second = openStore(path, { mediaDir: join(dir, "media") });
    stores.push(second);
    expect(second.buffer.count("work")).toBe(2);
    expect(second.buffer.nextUnacked("work")).toMatchObject({ seq: row.seq });
    expect(second.buffer.nextUnacked("work")?.event.text).toBe("survivor");
    expect(second.policy.get("work")).toEqual({ requireAddress: true });

    // Migrations are idempotent: a third open must not throw or reset anything.
    second.close();
    const third = openStore(path, { mediaDir: join(dir, "media") });
    stores.push(third);
    expect(third.buffer.count("work")).toBe(2);
    expect(
      (third.db.prepare("SELECT version FROM schema_version").get() as { version: number }).version
    ).toBeGreaterThan(0);
  });
});
