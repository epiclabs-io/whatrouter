import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isScalar, parseDocument } from "yaml";
import { ConfigError } from "../../src/config/schema.js";
import { ConfigStore } from "../../src/config/store.js";

const SECRET = "a".repeat(32);
const directories: string[] = [];

async function fixture(): Promise<{ path: string; store: ConfigStore }> {
  const directory = await mkdtemp(join(tmpdir(), "whatrouter-config-store-"));
  directories.push(directory);
  const path = join(directory, "config.yaml");
  await writeFile(
    path,
    `# top-level comment
listen: 127.0.0.1:8466 # listen comment
profiles:
  work: # profile comment
    gateway_id: gw-work
    secret: ${SECRET}
    routes: []
`,
    { mode: 0o644 }
  );
  return { path, store: await ConfigStore.load(path) };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("ConfigStore", () => {
  it("preserves comments, atomically replaces with mode 0600, and formats PN identities", async () => {
    const { path, store } = await fixture();
    const before = await stat(path);

    const config = await store.mutate((document) => {
      document.setIn(
        ["groups", "1@g.us"],
        document.createNode({
          display_name: "Test group",
          admins_seen: 2,
          listen_source: "explicit",
          listen: ["34600000000@s.whatsapp.net", "999888777@lid"],
        })
      );
    });

    const text = await readFile(path, "utf8");
    const after = await stat(path);
    expect(text).toContain("# top-level comment");
    expect(text).toContain("# listen comment");
    expect(text).toContain("# profile comment");
    expect(text).toContain('- "34600000000"');
    expect(text).toContain('- "999888777@lid"');
    expect(after.mode & 0o777).toBe(0o600);
    expect(after.ino).not.toBe(before.ino);
    expect(config.groups["1@g.us"]?.listen).toEqual([
      "34600000000@s.whatsapp.net",
      "999888777@lid",
    ]);
    expect(store.get()).toBe(config);
    expect((await readdir(join(path, ".."))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("does not replace the live file or snapshot when candidate validation fails", async () => {
    const { path, store } = await fixture();
    const text = await readFile(path, "utf8");
    const before = await stat(path);
    const snapshot = store.get();

    await expect(
      store.mutate((document) => {
        document.set("profiles", document.createNode({}));
      })
    ).rejects.toBeInstanceOf(ConfigError);

    expect(await readFile(path, "utf8")).toBe(text);
    expect((await stat(path)).ino).toBe(before.ino);
    expect(store.get()).toBe(snapshot);
  });

  it("serializes concurrent mutations against the latest file", async () => {
    const { store } = await fixture();
    await Promise.all([
      store.mutate((document) => document.set("default_profile", "work")),
      store.mutate((document) => document.set("allow_unrouted_outbound", true)),
    ]);
    expect(store.get().defaultProfile).toBe("work");
    expect(store.get().allowUnroutedOutbound).toBe(true);
  });

  it("preserves comments attached to formatted identity scalars", async () => {
    const { path, store } = await fixture();
    await store.mutate((document) => {
      document.setIn(
        ["profiles", "work", "routes"],
        [
          { dm: "34600000000@s.whatsapp.net" },
          { group: "1@g.us", allowed_senders: ["34600000001@s.whatsapp.net"] },
        ]
      );
      document.setIn(["groups", "1@g.us"], {
        listen_source: "explicit",
        listen: ["34600000002@s.whatsapp.net"],
      });
    });
    const commented = parseDocument(await readFile(path, "utf8"));
    const dm = commented.getIn(["profiles", "work", "routes", 0, "dm"], true);
    const allowed = commented.getIn(["profiles", "work", "routes", 1, "allowed_senders", 0], true);
    const listen = commented.getIn(["groups", "1@g.us", "listen", 0], true);
    if (!isScalar(dm) || !isScalar(allowed) || !isScalar(listen)) {
      throw new Error("identity fixture did not produce scalar nodes");
    }
    dm.comment = " dm identity";
    allowed.commentBefore = " allowed identity";
    listen.comment = " listen identity";
    await writeFile(path, commented.toString());
    await store.reload();

    await store.mutate((document) => document.set("allow_unrouted_outbound", true));

    const text = await readFile(path, "utf8");
    expect(text).toContain('dm: "34600000000" # dm identity');
    expect(text).toContain("# allowed identity");
    expect(text).toContain('- "34600000001"');
    expect(text).toContain('- "34600000002" # listen identity');
  });
});
