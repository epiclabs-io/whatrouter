/**
 * Config pipeline: YAML -> `${ENV}` interpolation -> zod -> cross-field checks -> `Config`.
 * Every error is collected (never throw on the first one) so operators see the whole list.
 */
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  ConfigError,
  MIN_SECRET_LENGTH,
  rawConfigSchema,
  type Config,
  type GroupConfig,
  type Issue,
  type ProfileConfig,
  type Route,
  type ValidateResult,
} from "./schema.js";
import { isGroupJidLike, isLidJidLike, parseUserIdentity, normalizeJid } from "../whatsapp/jid.js";

export interface ValidateContext {
  env?: Record<string, string | undefined>;
  /** Reads a `secret_file`. May throw; the failure is reported as a config error. */
  readFile?: (path: string) => string;
}

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function joinPath(base: string, key: string | number): string {
  if (typeof key === "number") {
    return `${base}[${key}]`;
  }
  return base === "" ? key : `${base}.${key}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Replaces `${VAR}` in every string of the tree; unset variables become errors. */
function interpolate(
  value: unknown,
  env: Record<string, string | undefined>,
  path: string,
  errors: Issue[]
): unknown {
  if (typeof value === "string") {
    return value.replace(ENV_REF, (match, name: string) => {
      const replacement = env[name];
      if (replacement === undefined) {
        errors.push({
          path: path === "" ? "(root)" : path,
          message: `environment variable ${name} is not set`,
        });
        return match;
      }
      return replacement;
    });
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => interpolate(item, env, joinPath(path, i), errors));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = interpolate(item, env, joinPath(path, key), errors);
    }
    return out;
  }
  return value;
}

function formatZodPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const segment of path) {
    out = typeof segment === "number" ? `${out}[${segment}]` : joinPath(out, String(segment));
  }
  return out === "" ? "(root)" : out;
}

const USER_ID_HINT = "expected +<digits>, <digits>@s.whatsapp.net or <digits>@lid";

function warnIfLid(raw: string, path: string, warnings: Issue[]): void {
  if (isLidJidLike(raw)) {
    warnings.push({ path, message: "LID user identities are opaque and may not be portable" });
  }
}

function duplicateChat(id: string, first: string, second: string): string {
  return first === second
    ? `chat ${id} is routed twice in profile "${first}"`
    : `chat ${id} is routed to both profile "${first}" and profile "${second}"`;
}

function parseListen(raw: string): { host: string; port: number } | null {
  const match = /^(.*):(\d{1,5})$/.exec(raw.trim());
  if (match === null) {
    return null;
  }
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  const host = (match[1] ?? "").replace(/^\[|\]$/g, "");
  return { host: host === "" ? "0.0.0.0" : host, port };
}

/**
 * `secret` vs `secret_file`: exactly one, resolved to a plain string (files are
 * trimmed) and length-checked. Returns "" when it could not be resolved; the
 * reason is already in `errors`. `path` is where further secret errors belong.
 */
function resolveSecret(
  raw: { secret?: string | undefined; secret_file?: string | undefined },
  base: string,
  ctx: ValidateContext,
  errors: Issue[]
): { secret: string; path: string } {
  let secret = "";
  let resolved = false;
  const hasSecret = raw.secret !== undefined;
  const hasSecretFile = raw.secret_file !== undefined;
  if (hasSecret && hasSecretFile) {
    errors.push({
      path: `${base}.secret`,
      message: 'set either "secret" or "secret_file", not both',
    });
  } else if (!hasSecret && !hasSecretFile) {
    errors.push({ path: `${base}.secret`, message: 'missing "secret" (or "secret_file")' });
  } else if (hasSecret) {
    secret = raw.secret ?? "";
    resolved = true;
  } else {
    const file = raw.secret_file ?? "";
    const read = ctx.readFile;
    if (read === undefined) {
      errors.push({
        path: `${base}.secret_file`,
        message: "secret_file is not supported in this context",
      });
    } else {
      try {
        secret = read(file).trim();
        resolved = true;
      } catch (err) {
        errors.push({
          path: `${base}.secret_file`,
          message: `cannot read secret_file "${file}": ${errorMessage(err)}`,
        });
      }
    }
  }

  const path = hasSecretFile && !hasSecret ? `${base}.secret_file` : `${base}.secret`;
  if (resolved && secret.trim() === "") {
    // An empty or whitespace-only value is not "no secret": it is a broken one.
    errors.push({ path, message: `secret is empty (minimum ${MIN_SECRET_LENGTH} chars)` });
  } else if (secret !== "" && secret.length < MIN_SECRET_LENGTH) {
    errors.push({
      path,
      message: `secret is too short (${secret.length} chars, minimum ${MIN_SECRET_LENGTH})`,
    });
  }
  return { secret, path };
}

/** Pure: no filesystem and no `process.env` unless the caller supplies them. */
export function validateConfig(raw: unknown, ctx: ValidateContext = {}): ValidateResult {
  const env = ctx.env ?? {};
  const errors: Issue[] = [];
  const warnings: Issue[] = [];

  const interpolated = interpolate(raw ?? {}, env, "", errors);

  const parsed = rawConfigSchema.safeParse(interpolated);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push({ path: formatZodPath(issue.path), message: issue.message });
    }
    return { ok: false, errors, warnings };
  }
  const data = parsed.data;

  const listen = parseListen(data.listen);
  if (listen === null) {
    errors.push({
      path: "listen",
      message: `invalid listen address "${data.listen}" (expected "<host>:<port>")`,
    });
  }

  let publicUrl: string | null = null;
  if (data.public_url !== null) {
    try {
      const url = new URL(data.public_url);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("not http(s)");
      }
      publicUrl = data.public_url.trim().replace(/\/+$/, "");
    } catch {
      errors.push({
        path: "public_url",
        message: `invalid public_url "${data.public_url}" (expected an http(s) URL)`,
      });
    }
  }

  const gatewayIds = new Map<string, string>();
  const secrets = new Map<string, string>();
  const chats = new Map<string, { profile: string; path: string }>();
  const profiles: ProfileConfig[] = [];
  const groups: Record<`${string}@g.us`, GroupConfig> = {};
  const routedGroups = new Set<string>();

  for (const [rawId, rawGroup] of Object.entries(data.groups)) {
    const base = `groups.${rawId}`;
    if (!isGroupJidLike(rawId) || normalizeJid(rawId) !== rawId) {
      errors.push({
        path: base,
        message: `invalid group registry key "${rawId}" (expected normalized <digits>(-<digits>)?@g.us)`,
      });
      continue;
    }

    const listen: string[] = [];
    const wildcardIndexes = rawGroup.listen
      .map((identity, index) => (identity.trim() === "*" ? index : -1))
      .filter((index) => index !== -1);
    if (
      wildcardIndexes.length > 0 &&
      (rawGroup.listen.length !== 1 || wildcardIndexes.length !== 1)
    ) {
      errors.push({
        path: `${base}.listen`,
        message: 'wildcard "*" must be the only listen entry',
      });
    }
    rawGroup.listen.forEach((identity, index) => {
      const path = `${base}.listen[${index}]`;
      if (identity.trim() === "*") {
        listen.push("*");
        return;
      }
      const parsedIdentity = parseUserIdentity(identity);
      if (parsedIdentity === null) {
        errors.push({
          path,
          message: `invalid phone number or JID "${identity}" (${USER_ID_HINT})`,
        });
        return;
      }
      warnIfLid(identity, path, warnings);
      listen.push(parsedIdentity);
    });
    groups[rawId as `${string}@g.us`] = {
      displayName: rawGroup.display_name,
      adminsSeen: rawGroup.admins_seen,
      listenSource: rawGroup.listen_source,
      listen,
    };
  }

  for (const [name, rawProfile] of Object.entries(data.profiles)) {
    const base = `profiles.${name}`;
    // A profile is addressed by its name (logs, `whatrouter env`, management).
    if (name.trim() === "") {
      errors.push({ path: "profiles", message: "profile names must not be empty" });
    }

    const previousGateway = gatewayIds.get(rawProfile.gateway_id);
    if (previousGateway !== undefined) {
      errors.push({
        path: `${base}.gateway_id`,
        message: `duplicate gateway_id "${rawProfile.gateway_id}" (also used by profile "${previousGateway}")`,
      });
    } else {
      gatewayIds.set(rawProfile.gateway_id, name);
    }

    const { secret, path: secretPath } = resolveSecret(rawProfile, base, ctx, errors);
    if (secret !== "") {
      const previousSecret = secrets.get(secret);
      if (previousSecret !== undefined) {
        errors.push({
          path: secretPath,
          message: `secret is also used by profile "${previousSecret}"`,
        });
      } else {
        secrets.set(secret, name);
      }
    }

    if (rawProfile.wake_url !== null) {
      try {
        const url = new URL(rawProfile.wake_url);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          throw new Error("not http(s)");
        }
      } catch {
        errors.push({
          path: `${base}.wake_url`,
          message: `invalid wake_url "${rawProfile.wake_url}" (expected an http(s) URL)`,
        });
      }
    }

    const routes: Route[] = [];
    rawProfile.routes.forEach((rawRoute, index) => {
      const routePath = `${base}.routes[${index}]`;

      if (rawRoute.dm !== undefined) {
        const id = parseUserIdentity(rawRoute.dm);
        if (id === null) {
          errors.push({
            path: `${routePath}.dm`,
            message: `invalid phone number or JID "${rawRoute.dm}" (${USER_ID_HINT})`,
          });
          return;
        }
        const previous = chats.get(id);
        if (previous !== undefined) {
          errors.push({
            path: `${routePath}.dm`,
            message: duplicateChat(id, previous.profile, name),
          });
          return;
        }
        chats.set(id, { profile: name, path: `${routePath}.dm` });
        warnIfLid(rawRoute.dm, `${routePath}.dm`, warnings);
        routes.push({ kind: "dm", id });
        return;
      }

      const rawGroup = rawRoute.group ?? "";
      if (!isGroupJidLike(rawGroup)) {
        errors.push({
          path: `${routePath}.group`,
          message: `invalid group JID "${rawGroup}" (expected <digits>@g.us)`,
        });
        return;
      }
      const id = normalizeJid(rawGroup) as `${string}@g.us`;
      routedGroups.add(id);
      if (!Object.hasOwn(data.groups, id)) {
        warnings.push({
          path: `${routePath}.group`,
          message: `group route "${id}" is not present in the group registry`,
        });
      }
      const previous = chats.get(id);
      if (previous !== undefined) {
        errors.push({
          path: `${routePath}.group`,
          message: duplicateChat(id, previous.profile, name),
        });
        return;
      }
      chats.set(id, { profile: name, path: `${routePath}.group` });

      let allowedSenders: string[] | undefined;
      if (rawRoute.allowed_senders !== undefined) {
        allowedSenders = [];
        rawRoute.allowed_senders.forEach((sender, senderIndex) => {
          const senderId = parseUserIdentity(sender);
          if (senderId === null) {
            errors.push({
              path: `${routePath}.allowed_senders[${senderIndex}]`,
              message: `invalid phone number or JID "${sender}" (${USER_ID_HINT})`,
            });
            return;
          }
          warnIfLid(sender, `${routePath}.allowed_senders[${senderIndex}]`, warnings);
          allowedSenders?.push(senderId);
        });
      }

      routes.push({
        kind: "group",
        id,
        requireMention: rawRoute.require_mention,
        ...(allowedSenders === undefined ? {} : { allowedSenders }),
      });
    });

    if (rawProfile.routes.length === 0) {
      warnings.push({
        path: `${base}.routes`,
        message: `profile "${name}" has no routes; it will never receive messages`,
      });
    }

    profiles.push({
      name,
      gatewayId: rawProfile.gateway_id,
      secret,
      displayName: rawProfile.display_name,
      wakeUrl: rawProfile.wake_url,
      routes,
    });
  }

  for (const id of Object.keys(groups)) {
    if (!routedGroups.has(id)) {
      warnings.push({
        path: `groups.${id}`,
        message: `registered group "${id}" has no profile route`,
      });
    }
  }

  // The management secret is a separate credential: a profile secret must never
  // authorize management access, so the two may not coincide.
  let management: Config["management"] = null;
  if (data.management !== null) {
    const { secret, path } = resolveSecret(data.management, "management", ctx, errors);
    const sharedWith = secrets.get(secret);
    if (secret !== "" && sharedWith !== undefined) {
      errors.push({
        path,
        message: `management secret must differ from every profile secret (also used by profile "${sharedWith}")`,
      });
    }
    management = { secret };
  }

  if (data.default_profile !== null && !Object.hasOwn(data.profiles, data.default_profile)) {
    errors.push({ path: "default_profile", message: `unknown profile "${data.default_profile}"` });
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }

  const config: Config = {
    listen: listen ?? { host: "0.0.0.0", port: 8466 },
    publicUrl,
    dataDir: data.data_dir,
    logLevel: data.log_level,
    whatsapp: {
      editStreaming: data.whatsapp.edit_streaming,
      sendReadReceipts: data.whatsapp.send_read_receipts,
      chunkDelayMs: data.whatsapp.chunk_delay_ms,
      sendTimeoutMs: data.whatsapp.send_timeout_ms,
    },
    buffer: {
      maxAgeSeconds: data.buffer.max_age_seconds,
      wakeCooldownSeconds: data.buffer.wake_cooldown_seconds,
    },
    media: { maxBytes: data.media.max_bytes, retentionSeconds: data.media.retention_seconds },
    defaultProfile: data.default_profile,
    allowUnroutedOutbound: data.allow_unrouted_outbound,
    management,
    groups,
    profiles,
  };
  return { ok: true, config, warnings };
}

/** Reads and validates a config file. Throws `ConfigError` with every problem found. */
export async function loadConfigFile(path: string): Promise<{ config: Config; warnings: Issue[] }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new ConfigError([{ path, message: `cannot read config file: ${errorMessage(err)}` }]);
  }

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new ConfigError([{ path, message: `invalid YAML: ${errorMessage(err)}` }]);
  }

  const result = validateConfig(raw ?? {}, {
    env: process.env,
    readFile: (p) => readFileSync(p, "utf8"),
  });
  if (!result.ok) {
    throw new ConfigError(result.errors);
  }
  return { config: result.config, warnings: result.warnings };
}

export async function loadConfig(path: string): Promise<Config> {
  return (await loadConfigFile(path)).config;
}

export { ConfigError } from "./schema.js";
