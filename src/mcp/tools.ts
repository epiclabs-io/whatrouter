import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { isMap } from "yaml";
import type { ConfigStore, ConfigDocument } from "../config/store.js";
import { relayUrl, type Config, type Issue } from "../config/schema.js";
import type {
  CloseProfileResult,
  FailureResult,
  ReleaseProfileResult,
} from "../management/frames.js";
import {
  formatUserIdentity,
  isGroupJidLike,
  normalizeJid,
  parseUserIdentity,
} from "../whatsapp/jid.js";
import type { GroupMetadata, WhatsAppPort } from "../whatsapp/port.js";

export interface McpToolOptions {
  getConfig: () => Config;
  configStore?: ConfigStore | undefined;
  whatsapp: WhatsAppPort;
  closeProfile: (name: string) => CloseProfileResult | FailureResult;
  releaseProfile: (name: string) => ReleaseProfileResult | FailureResult;
  removeProfile: (name: string) => void;
  health: () => Record<string, unknown>;
}

const groupIdSchema = z.string().describe("Normalized WhatsApp group JID");
const identitySchema = z.string().describe("Bare phone number, PN JID, or LID JID");
const resultSchema = z.object({ result: z.unknown() });
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const configWrite = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const destructiveConfigWrite = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
} as const;
const externalWrite = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
const destructiveExternalWrite = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true,
} as const;

function reply(result: unknown, text: string) {
  return { structuredContent: { result }, content: [{ type: "text" as const, text }] };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    structuredContent: { result: { error: message } },
    content: [{ type: "text" as const, text: message }],
  };
}

function warningReply(result: Record<string, unknown>, text: string, warnings: readonly Issue[]) {
  const rendered = warnings.map((warning) => `${warning.path}: ${warning.message}`);
  return reply(
    { ...result, warnings },
    rendered.length === 0
      ? text
      : `${text}\nWarnings:\n${rendered.map((line) => `- ${line}`).join("\n")}`
  );
}

function groupId(raw: string): `${string}@g.us` {
  const id = normalizeJid(raw);
  if (!isGroupJidLike(id) || id !== raw.trim()) {
    throw new Error("group_id must be a normalized WhatsApp group JID");
  }
  return id as `${string}@g.us`;
}

function identities(raw: string[]): string[] {
  return raw.map((value) => {
    const parsed = parseUserIdentity(value);
    if (parsed === null) {
      throw new Error(`invalid WhatsApp identity: ${value}`);
    }
    return parsed;
  });
}

function persistedIdentities(raw: string[]): string[] {
  if (raw.includes("*")) {
    if (raw.length !== 1) {
      throw new Error('"*" must be the only listen entry');
    }
    return ["*"];
  }
  return raw.map((value) => {
    const formatted = formatUserIdentity(value);
    if (formatted === null) {
      throw new Error(`invalid WhatsApp identity: ${value}`);
    }
    return formatted;
  });
}

function registered(opts: McpToolOptions, raw: string): `${string}@g.us` {
  const id = groupId(raw);
  if (opts.getConfig().groups[id] === undefined) {
    throw new Error(`group is not registered: ${id}`);
  }
  return id;
}

function requireDocumentEntry(doc: ConfigDocument, path: string[], message: string): void {
  if (doc.getIn(path, true) === undefined) {
    throw new Error(message);
  }
}

function profileNames(doc: ConfigDocument): string[] {
  const profiles = doc.get("profiles", true);
  if (!isMap(profiles)) {
    return [];
  }
  return profiles.items.map((pair) => String(pair.key));
}

async function mutate(opts: McpToolOptions, fn: (doc: ConfigDocument) => void): Promise<Config> {
  if (opts.configStore === undefined) {
    throw new Error("configuration mutation is unavailable: no writable ConfigStore was provided");
  }
  return await opts.configStore.mutate(fn);
}

function metadataResult(metadata: GroupMetadata): Record<string, unknown> {
  return {
    id: metadata.id,
    subject: metadata.subject,
    description: metadata.description,
    owner: metadata.owner,
    size: metadata.size,
    participants: metadata.participants,
    inviteCode: metadata.inviteCode,
    announcement: metadata.announcement,
    restrict: metadata.restrict,
    ephemeralDuration: metadata.ephemeralDuration,
    memberAddMode: metadata.memberAddMode,
    joinApprovalMode: metadata.joinApprovalMode,
  };
}

const routeSchema = z.union([
  z.strictObject({ dm: identitySchema }),
  z.strictObject({
    group: groupIdSchema,
    require_mention: z.boolean().optional(),
    allowed_senders: z.array(identitySchema).optional(),
  }),
]);

function persistedRoutes(routes: z.infer<typeof routeSchema>[]): Record<string, unknown>[] {
  return routes.map((route) => {
    if ("dm" in route) {
      return { dm: formatUserIdentity(route.dm) };
    }
    return {
      group: groupId(route.group),
      ...(route.require_mention === undefined ? {} : { require_mention: route.require_mention }),
      ...(route.allowed_senders === undefined
        ? {}
        : { allowed_senders: persistedIdentities(route.allowed_senders) }),
    };
  });
}

export function createMcpServer(opts: McpToolOptions): McpServer {
  const server = new McpServer({ name: "whatrouter-management", version: "1.0.0" });
  const tool = <Shape extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: Shape,
    annotations: ToolAnnotations,
    handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<CallToolResult> | CallToolResult
  ): void => {
    const callback = async (args: z.infer<z.ZodObject<Shape>>): Promise<CallToolResult> => {
      try {
        return await handler(args);
      } catch (error) {
        return failure(error);
      }
    };
    server.registerTool(
      name,
      { description, inputSchema, outputSchema: resultSchema, annotations },
      // SDK 1.31's callback declarations conflict with exactOptionalPropertyTypes.
      callback as never
    );
  };

  tool("list_groups", "List registered groups.", {}, readOnly, () => {
    const groups = Object.entries(opts.getConfig().groups).map(([id, group]) => ({ id, ...group }));
    return reply(groups, `${groups.length} registered group(s)`);
  });
  tool(
    "get_group",
    "Get a registered group and live metadata (use get_group_invite_code for the invite code).",
    { group_id: groupIdSchema },
    readOnly,
    async ({ group_id }) => {
      const id = registered(opts, group_id);
      const data = {
        registry: opts.getConfig().groups[id],
        metadata: metadataResult(await opts.whatsapp.getGroupMetadata(id)),
      };
      return reply(data, `Group ${id}`);
    }
  );
  tool(
    "register_group",
    "Register a WhatsApp group for routing policy.",
    {
      group_id: groupIdSchema,
      display_name: z.string().nullable().optional(),
      listen: z.array(z.string()).optional(),
    },
    configWrite,
    async ({ group_id, display_name, listen }) => {
      const id = groupId(group_id);
      const metadata = await opts.whatsapp.getGroupMetadata(id);
      const admins = metadata.participants.filter((p) => p.admin !== null);
      const botIds = new Set(opts.whatsapp.botIds());
      const selected =
        listen === undefined
          ? admins.length === 1 && botIds.has(admins[0]?.id ?? "")
            ? ["*"]
            : []
          : persistedIdentities(listen);
      await mutate(opts, (doc) => {
        if (doc.getIn(["groups", id], true) !== undefined) {
          throw new Error(`group is already registered: ${id}`);
        }
        doc.setIn(["groups", id], {
          display_name: display_name === undefined ? metadata.subject : display_name,
          admins_seen: admins.length,
          listen_source: listen === undefined ? "default_admin" : "explicit",
          listen: selected,
        });
      });
      return warningReply(
        { id, listen: selected },
        `Registered ${id}`,
        opts.configStore?.warnings ?? []
      );
    }
  );
  tool(
    "update_group",
    "Update registry metadata for a registered group.",
    { group_id: groupIdSchema, display_name: z.string().nullable() },
    configWrite,
    async ({ group_id, display_name }) => {
      const id = registered(opts, group_id);
      await mutate(opts, (doc) => {
        requireDocumentEntry(doc, ["groups", id], `group is not registered: ${id}`);
        doc.setIn(["groups", id, "display_name"], display_name);
      });
      return reply({ id, displayName: display_name }, `Updated ${id}`);
    }
  );
  tool(
    "forget_group",
    "Remove a group from the registry without leaving it.",
    { group_id: groupIdSchema },
    destructiveConfigWrite,
    async ({ group_id }) => {
      const id = registered(opts, group_id);
      await mutate(opts, (doc) => {
        requireDocumentEntry(doc, ["groups", id], `group is not registered: ${id}`);
        doc.deleteIn(["groups", id]);
      });
      return reply({ id, forgotten: true }, `Forgot ${id}`);
    }
  );
  tool(
    "get_listen_list",
    "Get a registered group's sender listen list.",
    { group_id: groupIdSchema },
    readOnly,
    ({ group_id }) => {
      const id = registered(opts, group_id);
      return reply(
        { id, listen: opts.getConfig().groups[id]?.listen ?? [] },
        `Listen list for ${id}`
      );
    }
  );
  tool(
    "set_listen_list",
    "Replace a registered group's sender listen list.",
    { group_id: groupIdSchema, listen: z.array(z.string()) },
    configWrite,
    async ({ group_id, listen }) => {
      const id = registered(opts, group_id);
      const selected = persistedIdentities(listen);
      await mutate(opts, (doc) => {
        requireDocumentEntry(doc, ["groups", id], `group is not registered: ${id}`);
        doc.setIn(["groups", id, "listen"], selected);
        doc.setIn(["groups", id, "listen_source"], "explicit");
      });
      return warningReply(
        { id, listen: selected },
        `Replaced listen list for ${id}`,
        opts.configStore?.warnings ?? []
      );
    }
  );
  tool(
    "list_group_members",
    "List live members of a registered group.",
    { group_id: groupIdSchema },
    readOnly,
    async ({ group_id }) => {
      const id = registered(opts, group_id);
      const members = (await opts.whatsapp.getGroupMetadata(id)).participants;
      return reply({ id, members }, `${members.length} member(s) in ${id}`);
    }
  );
  tool(
    "modify_group_members",
    "Add, remove, promote, or demote group members.",
    {
      group_id: groupIdSchema,
      participant_ids: z.array(identitySchema).min(1),
      action: z.enum(["add", "remove", "promote", "demote"]),
    },
    destructiveExternalWrite,
    async ({ group_id, participant_ids, action }) => {
      const id = registered(opts, group_id);
      const result = await opts.whatsapp.updateGroupParticipants(
        id,
        identities(participant_ids),
        action
      );
      return reply(
        { id, action, updates: result },
        `${action} completed for ${result.length} member(s)`
      );
    }
  );
  tool(
    "list_group_join_requests",
    "List pending join requests for a registered group.",
    { group_id: groupIdSchema },
    readOnly,
    async ({ group_id }) => {
      const id = registered(opts, group_id);
      const requests = await opts.whatsapp.listPendingGroupJoinRequests(id);
      return reply({ id, requests }, `${requests.length} pending request(s)`);
    }
  );
  tool(
    "review_group_join_requests",
    "Approve or reject pending group join requests.",
    {
      group_id: groupIdSchema,
      participant_ids: z.array(identitySchema).min(1),
      action: z.enum(["approve", "reject"]),
    },
    destructiveExternalWrite,
    async ({ group_id, participant_ids, action }) => {
      const id = registered(opts, group_id);
      const updates = await opts.whatsapp.reviewPendingGroupJoinRequests(
        id,
        identities(participant_ids),
        action
      );
      return reply({ id, action, updates }, `${action} completed for ${updates.length} request(s)`);
    }
  );
  tool(
    "get_group_invite_code",
    "Get the invite code for a registered group.",
    { group_id: groupIdSchema },
    readOnly,
    async ({ group_id }) => {
      const id = registered(opts, group_id);
      const code = await opts.whatsapp.getGroupInviteCode(id);
      return reply(
        { id, code },
        code === null ? `No invite code for ${id}` : `Invite code for ${id}`
      );
    }
  );
  tool(
    "revoke_group_invite_code",
    "Revoke and replace a registered group's invite code.",
    { group_id: groupIdSchema },
    destructiveExternalWrite,
    async ({ group_id }) => {
      const id = registered(opts, group_id);
      const code = await opts.whatsapp.revokeGroupInviteCode(id);
      return reply({ id, code }, `Replaced invite code for ${id}`);
    }
  );
  tool(
    "join_group_by_invite",
    "Join a group using an invite code without registering it.",
    { code: z.string().min(1) },
    externalWrite,
    async ({ code }) => {
      const id = await opts.whatsapp.acceptGroupInviteCode(code);
      return reply({ id }, id === null ? "Invite was not accepted" : `Joined ${id}`);
    }
  );
  tool(
    "create_group",
    "Create a WhatsApp group without registering or routing it.",
    { subject: z.string().min(1), participant_ids: z.array(identitySchema).default([]) },
    externalWrite,
    async ({ subject, participant_ids }) => {
      const metadata = await opts.whatsapp.createGroup(subject, identities(participant_ids));
      return reply(metadataResult(metadata), `Created ${metadata.id}`);
    }
  );
  tool(
    "leave_group",
    "Leave a registered group and optionally forget it after success.",
    { group_id: groupIdSchema, forget: z.boolean().optional() },
    destructiveExternalWrite,
    async ({ group_id, forget }) => {
      const id = registered(opts, group_id);
      await opts.whatsapp.leaveGroup(id);
      if (forget === true) {
        await mutate(opts, (doc) => {
          requireDocumentEntry(doc, ["groups", id], `group is not registered: ${id}`);
          doc.deleteIn(["groups", id]);
        });
      }
      return reply({ id, left: true, forgotten: forget === true }, `Left ${id}`);
    }
  );
  tool(
    "update_group_settings",
    "Update one or more settings on a registered group.",
    {
      group_id: groupIdSchema,
      subject: z.string().min(1).optional(),
      description: z.string().nullable().optional(),
      announcement: z.boolean().optional(),
      restrict: z.boolean().optional(),
      ephemeral_duration: z.number().int().nonnegative().optional(),
      member_add_mode: z.enum(["admins", "all"]).optional(),
      join_approval_mode: z.boolean().optional(),
    },
    externalWrite,
    async (args) => {
      const id = registered(opts, args.group_id);
      const operations: Promise<void>[] = [];
      if (args.subject !== undefined) {
        operations.push(opts.whatsapp.updateGroupSubject(id, args.subject));
      }
      if (args.description !== undefined) {
        operations.push(opts.whatsapp.updateGroupDescription(id, args.description));
      }
      if (args.announcement !== undefined) {
        operations.push(opts.whatsapp.setGroupAnnouncement(id, args.announcement));
      }
      if (args.restrict !== undefined) {
        operations.push(opts.whatsapp.setGroupRestrict(id, args.restrict));
      }
      if (args.ephemeral_duration !== undefined) {
        operations.push(opts.whatsapp.setGroupEphemeralDuration(id, args.ephemeral_duration));
      }
      if (args.member_add_mode !== undefined) {
        operations.push(opts.whatsapp.setGroupMemberAddMode(id, args.member_add_mode));
      }
      if (args.join_approval_mode !== undefined) {
        operations.push(opts.whatsapp.setGroupJoinApprovalMode(id, args.join_approval_mode));
      }
      if (operations.length === 0) {
        throw new Error("at least one group setting is required");
      }
      await Promise.all(operations);
      return reply(
        { id, updated: Object.keys(args).filter((key) => key !== "group_id") },
        `Updated settings for ${id}`
      );
    }
  );

  tool("list_profiles", "List configured relay profiles without secrets.", {}, readOnly, () => {
    const profiles = opts.getConfig().profiles.map(({ secret: _secret, ...profile }) => profile);
    return reply(profiles, `${profiles.length} profile(s)`);
  });
  tool(
    "create_profile",
    "Create a relay profile and return its credentials.",
    {
      name: z.string().trim().min(1),
      display_name: z.string().nullable().optional(),
      wake_url: z.url().nullable().optional(),
      routes: z.array(routeSchema).default([]),
    },
    configWrite,
    async ({ name, display_name, wake_url, routes }) => {
      let secret = "";
      let gatewayId = "";
      const config = await mutate(opts, (doc) => {
        if (doc.getIn(["profiles", name], true) !== undefined) {
          throw new Error(`profile already exists: ${name}`);
        }
        const current = opts.configStore?.current;
        const usedSecrets = new Set(current?.profiles.map((profile) => profile.secret) ?? []);
        if (current?.management !== null && current?.management !== undefined) {
          usedSecrets.add(current.management.secret);
        }
        do {
          secret = randomBytes(32).toString("base64url");
        } while (usedSecrets.has(secret));
        const usedGatewayIds = new Set(current?.profiles.map((profile) => profile.gatewayId) ?? []);
        do {
          gatewayId = `gw-${randomBytes(16).toString("hex")}`;
        } while (usedGatewayIds.has(gatewayId));
        doc.setIn(["profiles", name], {
          gateway_id: gatewayId,
          secret,
          display_name: display_name ?? null,
          wake_url: wake_url ?? null,
          routes: persistedRoutes(routes),
        });
      });
      const url = relayUrl(config);
      const result = {
        name,
        gatewayId,
        secret,
        relayUrl: url,
        env: [
          `GATEWAY_RELAY_URL=${url}`,
          `GATEWAY_RELAY_ID=${gatewayId}`,
          `GATEWAY_RELAY_SECRET=${secret}`,
          "GATEWAY_RELAY_PLATFORMS=whatsapp",
        ],
      };
      return warningReply(
        result,
        `Created profile ${name}; credentials are returned once`,
        opts.configStore?.warnings ?? []
      );
    }
  );
  tool(
    "delete_profile",
    "Delete a relay profile after closing its live session.",
    { name: z.string().min(1) },
    destructiveConfigWrite,
    async ({ name }) => {
      let fallback: string | null = null;
      let wasDefault = false;
      const config = await opts.configStore?.mutate(
        (doc) => {
          const names = profileNames(doc);
          if (!names.includes(name)) {
            throw new Error(`unknown profile: ${name}`);
          }
          if (names.length === 1) {
            throw new Error("cannot delete the last profile");
          }
          fallback = names.find((candidate) => candidate !== name) ?? null;
          wasDefault = doc.get("default_profile") === name;
          doc.deleteIn(["profiles", name]);
          if (wasDefault) {
            doc.set("default_profile", fallback);
          }
        },
        () => opts.removeProfile(name)
      );
      if (config === undefined) {
        throw new Error(
          "configuration mutation is unavailable: no writable ConfigStore was provided"
        );
      }
      return reply(
        {
          name,
          deleted: true,
          defaultProfile: config.defaultProfile,
        },
        `Deleted profile ${name}`
      );
    }
  );
  tool(
    "close_profile",
    "Close a live relay session and temporarily hold reconnects.",
    { name: z.string().min(1) },
    destructiveExternalWrite,
    ({ name }) => {
      const result = opts.closeProfile(name);
      if (!result.success) {
        throw new Error(result.error);
      }
      return reply(result, `Closed profile ${name}`);
    }
  );
  tool(
    "release_profile",
    "Release a profile's temporary reconnect hold.",
    { name: z.string().min(1) },
    externalWrite,
    ({ name }) => {
      const result = opts.releaseProfile(name);
      if (!result.success) {
        throw new Error(result.error);
      }
      return reply(result, `Released profile ${name}`);
    }
  );
  tool("get_health", "Get current router, WhatsApp, relay, and buffer health.", {}, readOnly, () =>
    reply(opts.health(), "WhatRouter health")
  );

  return server;
}
