import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigStore } from "../../src/config/store.js";
import { startServe, type ServeHandle } from "../../src/serve.js";
import { silentLogger, testConfig } from "../helpers/relay.js";

const MANAGEMENT_SECRET = "mcp-management-secret-0123456789abcdef";
const PROFILE_SECRET = "profile-secret-0123456789abcdef012345";
const io = { out: (): void => undefined, err: (): void => undefined };

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("could not reserve a port");
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

describe("Streamable HTTP MCP management API", () => {
  let directory: string;
  let configPath: string;
  let handle: ServeHandle;
  let base: string;
  let client: Client;
  let transport: StreamableHTTPClientTransport;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "whatrouter-mcp-"));
    configPath = join(directory, "config.yaml");
    const port = await unusedPort();
    await writeFile(
      configPath,
      `# preserved top comment
listen: 127.0.0.1:${port} # preserved listen comment
data_dir: ${JSON.stringify(directory)}
management:
  secret: ${MANAGEMENT_SECRET}
profiles:
  work: # preserved profile comment
    gateway_id: gw-work
    secret: ${PROFILE_SECRET}
    routes: []
`
    );
    const configStore = await ConfigStore.load(configPath);
    const started = await startServe({
      config: configStore.get(),
      configStore,
      log: silentLogger(),
      io,
      fake: true,
      signals: false,
    });
    if (!started.ok) {
      throw new Error(`startServe failed with ${started.code}`);
    }
    handle = started.handle;
    base = `http://127.0.0.1:${handle.address.port}`;
  });

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await handle?.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("requires the management bearer and rejects foreign origins", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });
    const missing = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe("Bearer");
    expect(missing.headers.has("access-control-allow-origin")).toBe(false);

    const profileToken = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${PROFILE_SECRET}`, "content-type": "application/json" },
      body,
    });
    expect(profileToken.status).toBe(401);

    const foreign = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${MANAGEMENT_SECRET}`,
        origin: "https://evil.example",
        "content-type": "application/json",
      },
      body,
    });
    expect(foreign.status).toBe(403);

    const unsupported = await fetch(`${base}/mcp`, {
      method: "PUT",
      headers: { authorization: `Bearer ${MANAGEMENT_SECRET}` },
    });
    expect(unsupported.status).toBe(405);
    expect(unsupported.headers.get("allow")).toBe("GET, POST, DELETE");
  });

  it("initializes once, reuses its session, and exposes exactly the management tools", async () => {
    transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${MANAGEMENT_SECRET}` } },
    });
    client = new Client({ name: "whatrouter-test", version: "1.0.0" });
    await client.connect(transport as Transport);
    const sessionId = transport.sessionId;
    expect(sessionId).toBeTruthy();
    const listed = await client.listTools();
    expect(transport.sessionId).toBe(sessionId);
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(
      [
        "close_profile",
        "create_group",
        "create_profile",
        "delete_profile",
        "forget_group",
        "get_group",
        "get_group_invite_code",
        "get_health",
        "get_listen_list",
        "join_group_by_invite",
        "leave_group",
        "list_group_join_requests",
        "list_group_members",
        "list_groups",
        "list_profiles",
        "modify_group_members",
        "register_group",
        "release_profile",
        "review_group_join_requests",
        "revoke_group_invite_code",
        "set_listen_list",
        "update_group",
        "update_group_settings",
      ].sort()
    );
    expect(listed.tools.every((tool) => tool.outputSchema !== undefined)).toBe(true);
  });

  it("evicts the least recently used session instead of refusing new ones", async () => {
    const headers = {
      authorization: `Bearer ${MANAGEMENT_SECRET}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    const initialize = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "abandoned", version: "1" },
      },
    });
    const listTools = (sessionId: string): Promise<Response> =>
      fetch(`${base}/mcp`, {
        method: "POST",
        headers: { ...headers, "mcp-session-id": sessionId },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      });

    // More abandoned sessions than the cap; the real client stays the most recently used.
    const abandoned: string[] = [];
    for (let i = 0; i < 33; i += 1) {
      const response = await fetch(`${base}/mcp`, { method: "POST", headers, body: initialize });
      expect(response.status).toBe(200);
      await response.text();
      abandoned.push(response.headers.get("mcp-session-id") ?? "");
      await client.listTools();
    }

    expect((await listTools(abandoned[0] ?? "")).status).toBe(404);
    expect((await listTools(abandoned[32] ?? "")).status).toBe(200);
    await expect(client.listTools()).resolves.toBeDefined();

    for (const sessionId of abandoned) {
      await fetch(`${base}/mcp`, {
        method: "DELETE",
        headers: { ...headers, "mcp-session-id": sessionId },
      });
    }
  });

  it("performs fake group operations and preserves YAML comments during mutation", async () => {
    const created = await client.callTool({
      name: "create_group",
      arguments: { subject: "MCP group", participant_ids: ["34600000000"] },
    });
    const groupId = (created.structuredContent as { result: { id: string } }).result.id;
    expect(groupId).toMatch(/@g\.us$/);

    const registered = await client.callTool({
      name: "register_group",
      arguments: { group_id: groupId },
    });
    expect(
      (registered.structuredContent as { result: { listen: string[] } }).result.listen
    ).toEqual(["*"]);
    const listenResult = await client.callTool({
      name: "set_listen_list",
      arguments: { group_id: groupId, listen: ["34600000001@s.whatsapp.net", "999888777@lid"] },
    });
    expect(
      (listenResult.structuredContent as { result: { warnings: Array<{ message: string }> } })
        .result.warnings
    ).toContainEqual(expect.objectContaining({ message: expect.stringContaining("opaque") }));
    expect(listenResult.content).toContainEqual(
      expect.objectContaining({ text: expect.stringContaining("opaque") })
    );
    const members = await client.callTool({
      name: "list_group_members",
      arguments: { group_id: groupId },
    });
    expect(
      (members.structuredContent as { result: { members: unknown[] } }).result.members.length
    ).toBe(2);

    const yaml = await readFile(configPath, "utf8");
    expect(yaml).toContain("# preserved top comment");
    expect(yaml).toContain("# preserved listen comment");
    expect(yaml).toContain("# preserved profile comment");
    expect(yaml).toContain('- "34600000001"');
    expect(yaml).toContain("- 999888777@lid");

    const invalid = await client.callTool({
      name: "get_group",
      arguments: { group_id: "not-a-group" },
    });
    expect(invalid.isError).toBe(true);
  });

  it("registers with an explicit listen list without a live WhatsApp lookup", async () => {
    // Not a fake group: any metadata lookup would fail, and WhatsApp is down anyway.
    const groupId = "120363999999999999@g.us";
    handle.fake?.setState("disconnected");
    try {
      const registered = await client.callTool({
        name: "register_group",
        arguments: { group_id: groupId, listen: ["34600000002"], display_name: "Offline" },
      });
      expect(registered.isError).not.toBe(true);
      const listed = await client.callTool({ name: "list_groups", arguments: {} });
      expect(
        (listed.structuredContent as { result: Array<Record<string, unknown>> }).result
      ).toContainEqual({
        id: groupId,
        displayName: "Offline",
        adminsSeen: null,
        listenSource: "explicit",
        listen: ["34600000002@s.whatsapp.net"],
      });
      const defaulted = await client.callTool({
        name: "register_group",
        arguments: { group_id: "120363999999999998@g.us" },
      });
      expect(defaulted.isError).toBe(true);
    } finally {
      handle.fake?.setState("connected");
      await client.callTool({ name: "forget_group", arguments: { group_id: groupId } });
    }
  });

  it("applies group settings in order and reports a partial failure precisely", async () => {
    const fake = handle.fake;
    if (fake === null) {
      throw new Error("fake WhatsApp port expected");
    }
    const created = await client.callTool({
      name: "create_group",
      arguments: { subject: "Settings group", participant_ids: [] },
    });
    const groupId = (created.structuredContent as { result: { id: string } }).result.id;
    await client.callTool({ name: "register_group", arguments: { group_id: groupId } });

    const original = fake.setGroupRestrict;
    fake.setGroupRestrict = async () => {
      throw new Error("not an admin");
    };
    try {
      const failed = await client.callTool({
        name: "update_group_settings",
        arguments: {
          group_id: groupId,
          subject: "Renamed",
          restrict: true,
          member_add_mode: "all",
        },
      });
      expect(failed.isError).toBe(true);
      expect((failed.structuredContent as { result: unknown }).result).toEqual({
        id: groupId,
        updated: ["subject"],
        failed: { setting: "restrict", error: "not an admin" },
        notAttempted: ["member_add_mode"],
      });
      const metadata = await fake.getGroupMetadata(groupId);
      expect(metadata.subject).toBe("Renamed");
      expect(metadata.memberAddMode).toBe("admins");
    } finally {
      fake.setGroupRestrict = original;
    }

    const succeeded = await client.callTool({
      name: "update_group_settings",
      arguments: { group_id: groupId, restrict: true, member_add_mode: "all" },
    });
    expect(succeeded.isError).not.toBe(true);
    expect((succeeded.structuredContent as { result: unknown }).result).toEqual({
      id: groupId,
      updated: ["restrict", "member_add_mode"],
    });
    await client.callTool({ name: "forget_group", arguments: { group_id: groupId } });
  });

  it("serializes duplicate registration and profile creation across MCP sessions", async () => {
    const otherTransport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${MANAGEMENT_SECRET}` } },
    });
    const otherClient = new Client({ name: "concurrent-test", version: "1.0.0" });
    await otherClient.connect(otherTransport as Transport);
    try {
      const created = await client.callTool({
        name: "create_group",
        arguments: { subject: "Race group", participant_ids: [] },
      });
      const groupId = (created.structuredContent as { result: { id: string } }).result.id;
      const registrations = await Promise.all([
        client.callTool({ name: "register_group", arguments: { group_id: groupId } }),
        otherClient.callTool({ name: "register_group", arguments: { group_id: groupId } }),
      ]);
      expect(registrations.filter((result) => result.isError === true)).toHaveLength(1);
      const forgets = await Promise.all([
        client.callTool({ name: "forget_group", arguments: { group_id: groupId } }),
        otherClient.callTool({ name: "forget_group", arguments: { group_id: groupId } }),
      ]);
      expect(forgets.filter((result) => result.isError === true)).toHaveLength(1);

      const profiles = await Promise.all([
        client.callTool({ name: "create_profile", arguments: { name: "raced" } }),
        otherClient.callTool({ name: "create_profile", arguments: { name: "raced" } }),
      ]);
      expect(profiles.filter((result) => result.isError === true)).toHaveLength(1);
      expect(
        handle.store.db.prepare("SELECT COUNT(*) AS n FROM policies WHERE profile = ?").get("raced")
      ).toEqual({ n: 0 });
    } finally {
      await otherClient.close();
    }
  });

  it("purges profile runtime state before allowing delete and same-name recreation", async () => {
    const created = await client.callTool({
      name: "create_profile",
      arguments: { name: "ephemeral", routes: [{ dm: "123456789@lid" }] },
    });
    expect(created.isError).not.toBe(true);
    expect(created.content).toContainEqual(
      expect.objectContaining({ text: expect.stringContaining("opaque") })
    );
    handle.store.buffer.append("ephemeral", {
      text: "old",
      message_type: "text",
      message_id: "old-1",
      reply_to_message_id: null,
      source: {
        platform: "whatsapp",
        chat_id: "1@s.whatsapp.net",
        chat_type: "dm",
        chat_name: "Old",
        user_id: "1@s.whatsapp.net",
        user_name: "Old",
        thread_id: null,
        chat_topic: null,
        message_id: "old-1",
      },
    });
    handle.store.buffer.setBufferedOnly("ephemeral", true);
    handle.store.policy.set("ephemeral", { requireAddress: false });
    const media = handle.store.media.put("ephemeral", Buffer.from("old"), "text/plain");
    expect(existsSync(join(directory, "media", media.id))).toBe(true);
    expect(handle.relay.closeProfile("ephemeral").success).toBe(true);

    const deleted = await client.callTool({
      name: "delete_profile",
      arguments: { name: "ephemeral" },
    });
    expect(deleted.isError).not.toBe(true);
    const recreated = await client.callTool({
      name: "create_profile",
      arguments: { name: "ephemeral" },
    });
    expect(recreated.isError).not.toBe(true);

    expect(handle.store.buffer.count("ephemeral")).toBe(0);
    expect(handle.store.buffer.isBufferedOnly("ephemeral")).toBe(false);
    expect(handle.store.policy.get("ephemeral")).toBeNull();
    expect(handle.store.media.getMeta(media.id)).toBeNull();
    expect(existsSync(join(directory, "media", media.id))).toBe(false);
    expect(
      (handle.relay.health().profiles as Record<string, { blockedUntilMs?: number }>).ephemeral
    ).not.toHaveProperty("blockedUntilMs");
  });

  it("keeps direct-Config serving available with clear read-only mutation errors", async () => {
    const direct = await startServe({
      config: testConfig({
        dataDir: join(directory, "direct-data"),
        management: { secret: MANAGEMENT_SECRET },
      }),
      log: silentLogger(),
      io,
      fake: true,
      signals: false,
    });
    if (!direct.ok) {
      throw new Error(`direct startServe failed with ${direct.code}`);
    }
    const directTransport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${direct.handle.address.port}/mcp`),
      { requestInit: { headers: { authorization: `Bearer ${MANAGEMENT_SECRET}` } } }
    );
    const directClient = new Client({ name: "direct-config-test", version: "1.0.0" });
    try {
      await directClient.connect(directTransport as Transport);
      const result = await directClient.callTool({
        name: "create_profile",
        arguments: { name: "unavailable" },
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContainEqual(
        expect.objectContaining({ text: expect.stringContaining("no writable ConfigStore") })
      );
    } finally {
      await directClient.close().catch(() => undefined);
      await direct.handle.close();
    }
  });

  it("deletes the session and shuts down cleanly", async () => {
    const sessionId = transport.sessionId;
    expect(sessionId).toBeTruthy();
    await transport.terminateSession();
    const stale = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${MANAGEMENT_SECRET}`,
        "mcp-session-id": sessionId!,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }),
    });
    expect(stale.status).toBe(404);
    await handle.close();
    await expect(fetch(`${base}/healthz`)).rejects.toThrow();
  });
});
