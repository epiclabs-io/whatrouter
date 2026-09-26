/**
 * Raw YAML shape (zod) + the normalized `Config` the rest of the program uses.
 * Everything downstream of `loadConfig` sees canonical JIDs and camelCase fields.
 */
import { z } from "zod";

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const DEFAULT_LISTEN = "0.0.0.0:8466";
export const DEFAULT_DATA_DIR = "./data";
export const MIN_SECRET_LENGTH = 32;

// ------------------------------------------------------------------ raw shape

const routeSchema = z
  .strictObject({
    dm: z.string().optional(),
    group: z.string().optional(),
    require_mention: z.boolean().optional(),
    allowed_senders: z.array(z.string()).optional(),
  })
  .refine((r) => (r.dm === undefined) !== (r.group === undefined), {
    message: 'a route needs exactly one of "dm" or "group"',
  });

const profileSchema = z.strictObject({
  gateway_id: z.string().min(1),
  secret: z.string().optional(),
  secret_file: z.string().optional(),
  display_name: z.string().nullable().default(null),
  wake_url: z.string().nullable().default(null),
  routes: z.array(routeSchema).default([]),
});

export const rawConfigSchema = z.strictObject({
  listen: z.string().default(DEFAULT_LISTEN),
  public_url: z.string().nullable().default(null),
  data_dir: z.string().default(DEFAULT_DATA_DIR),
  log_level: z.enum(LOG_LEVELS).default("info"),
  whatsapp: z
    .strictObject({
      edit_streaming: z.boolean().default(false),
      send_read_receipts: z.boolean().default(false),
      chunk_delay_ms: z.number().int().nonnegative().default(300),
      send_timeout_ms: z.number().int().positive().default(60000),
    })
    .prefault({}),
  buffer: z
    .strictObject({
      max_age_seconds: z.number().int().positive().default(1209600),
      wake_cooldown_seconds: z.number().int().nonnegative().default(60),
    })
    .prefault({}),
  media: z
    .strictObject({
      max_bytes: z.number().int().positive().default(26214400),
      retention_seconds: z.number().int().positive().default(604800),
    })
    .prefault({}),
  default_profile: z.string().nullable().default(null),
  allow_unrouted_outbound: z.boolean().default(false),
  profiles: z
    .record(z.string(), profileSchema)
    .refine((v) => Object.keys(v).length > 0, { message: "at least one profile is required" }),
});

export type RawConfig = z.infer<typeof rawConfigSchema>;

// ------------------------------------------------------------ normalized shape

export interface DmRoute {
  kind: "dm";
  /** `<digits>@s.whatsapp.net` or `<digits>@lid`. */
  id: string;
}

export interface GroupRoute {
  kind: "group";
  id: `${string}@g.us`;
  /** `undefined` = not configured, so the router can apply policy precedence. */
  requireMention: boolean | undefined;
  /** Canonical JIDs. */
  allowedSenders?: string[];
}

export type Route = DmRoute | GroupRoute;

export interface ProfileConfig {
  /** The key under `profiles:`. */
  name: string;
  gatewayId: string;
  secret: string;
  displayName: string | null;
  wakeUrl: string | null;
  routes: Route[];
}

export interface Config {
  listen: { host: string; port: number };
  /** Trailing slash stripped; null = fall back to `http://localhost:<port>`. */
  publicUrl: string | null;
  dataDir: string;
  logLevel: LogLevel;
  whatsapp: {
    editStreaming: boolean;
    sendReadReceipts: boolean;
    chunkDelayMs: number;
    sendTimeoutMs: number;
  };
  buffer: { maxAgeSeconds: number; wakeCooldownSeconds: number };
  media: { maxBytes: number; retentionSeconds: number };
  defaultProfile: string | null;
  allowUnroutedOutbound: boolean;
  profiles: ProfileConfig[];
}

export interface Issue {
  /** Dotted config path, e.g. `profiles.work.routes[0].dm`. */
  path: string;
  message: string;
}

export type ValidateResult =
  | { ok: true; config: Config; warnings: Issue[] }
  | { ok: false; errors: Issue[]; warnings: Issue[] };

export class ConfigError extends Error {
  readonly errors: Issue[];
  constructor(errors: Issue[]) {
    super(errors.map((e) => `${e.path}: ${e.message}`).join("; ") || "invalid configuration");
    this.name = "ConfigError";
    this.errors = errors;
  }
}

/** The `GATEWAY_RELAY_URL` a Hermes instance should dial. */
export function relayUrl(config: Config): string {
  if (config.publicUrl !== null) {
    const base = new URL(config.publicUrl);
    const scheme = base.protocol === "https:" ? "wss" : "ws";
    const path = base.pathname.replace(/\/+$/, "");
    return `${scheme}://${base.host}${path}/relay`;
  }
  const { host, port } = config.listen;
  // A wildcard bind address is not dialable; the operator most likely means this host.
  const target = host === "0.0.0.0" || host === "::" || host === "" ? "localhost" : host;
  return `ws://${target}:${port}/relay`;
}
