/**
 * The relay server: Node `http` + `ws`.
 *
 *   GET  /relay             WebSocket upgrade (HMAC bearer), one session per profile
 *   GET  /management        WebSocket upgrade (static bearer), one orchestrator client;
 *                           only when `management:` is configured, otherwise unknown path
 *   POST /relay/policy      gateway-pushed policy
 *   POST /relay/media       upload (raw body)
 *   GET  /relay/media/:id   download, scoped to the owning profile
 *   GET  /healthz           liveness + per-profile buffer depth
 *   POST /debug/inbound     only when the caller wires `debugInbound`
 *   everything else         404 (`/relay/enroll` and `/relay/provision` by design)
 *
 * Auth rejections on the upgrade are deliberately *not* HTTP 401: the gateway
 * only engages its backoff/relogin logic on WebSocket close code 4401, so we
 * complete the handshake and then close (reason `expired` vs `unauthorized`).
 * `/management` follows the same pattern (always `unauthorized`: its secret is
 * static), but its failures are deliberately not added to the relay throttle.
 *
 * Management holds: `close_profile` detaches a profile's relay session at once
 * (later inbound buffers), closes its socket 1001 `closed by management`, and
 * refuses that profile's reconnects with 1013 `profile temporarily suspended`
 * for HOLD_MS. Wake pokes are suppressed meanwhile; at expiry one regular wake
 * attempt is made if the profile is still offline with buffered work. Holds
 * live only in memory: a restart clears them. Outbound actions the closed
 * session already started cannot be cancelled; they may still reach WhatsApp,
 * but their `outbound_result` is no longer sent. `release_profile` cancels only
 * the reconnect hold; it does not wake the profile or alter the detached socket.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { parseBearer, peekPayload, verifyToken } from "./auth.js";
import { buildDescriptor } from "./descriptor.js";
import { contentDisposition } from "./content-disposition.js";
import { encodeFrame, LineAssembler, parseGatewayFrame } from "./ndjson.js";
import { Session } from "./session.js";
import { mediaUrl } from "./media-url.js";
import { secretMatches } from "../management/auth.js";
import { ManagementEndpoint, MANAGEMENT_MAX_MESSAGE_BYTES } from "../management/endpoint.js";
import { createMcpEndpoint, type McpEndpoint } from "../mcp/endpoint.js";
import type {
  CloseProfileResult,
  FailureResult,
  PendingProfile,
  ReleaseProfileResult,
} from "../management/frames.js";
import { MediaTooLargeError, type Store } from "../store/db.js";
import type { Config, ProfileConfig } from "../config/schema.js";
import type { ConfigStore } from "../config/store.js";
import type { Logger } from "../util/log.js";
import type { WhatsAppPort } from "../whatsapp/port.js";
import type { OutboundAction, OutboundResult, RelayEvent } from "./frames.js";

export interface RelayServerOptions {
  config: Config;
  /** Current snapshot for request-time auth, routing metadata, and limits. */
  getConfig?: (() => Config) | undefined;
  /** Enables persistent MCP mutation tools when provided. */
  configStore?: ConfigStore | undefined;
  /** Enables the MCP group-management tools when provided. */
  whatsapp?: WhatsAppPort | undefined;
  store: Store;
  log: Logger;
  /** Runs one outbound action against WhatsApp on behalf of `profile`. */
  execute: (
    profile: ProfileConfig,
    action: OutboundAction,
    platform?: string
  ) => Promise<OutboundResult>;
  /** Extra fields for `/healthz` (WhatsApp connection state, version, ...). */
  health: () => Record<string, unknown>;
  /** Unix seconds; injectable for tests. */
  now?: () => number;
  /** Epoch milliseconds for management hold deadlines; injectable for tests. */
  nowMs?: () => number;
  /** Schedules a hold-expiry check; returns its cancel. Injectable for tests. */
  scheduleHoldExpiry?: (fn: () => void, delayMs: number) => () => void;
  /** Unread management output tolerated before closing that client 1013. */
  managementMaxBufferedBytes?: number;
  /** Injectable for the wake poke. */
  fetchImpl?: typeof fetch;
  /** When present, enables `POST /debug/inbound` (WHATROUTER_FAKE_WHATSAPP=1). */
  debugInbound?: (body: unknown) => Promise<void>;
}

export type DeliveryOutcome = "live" | "buffered" | "unknown_profile";

export interface RelayServer {
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
  /** Never drops: an event for a disconnected profile lands in the buffer. */
  deliver(profileName: string, event: RelayEvent): DeliveryOutcome;
  isConnected(profileName: string): boolean;
  bufferedCount(profileName: string): number;
  address(): { host: string; port: number } | null;
  /** Hourly by itself; exposed so tests (and ops) can force a sweep. */
  runMaintenance(nowSeconds?: number): { bufferPurged: number; mediaPurged: number };
  closeProfile(profileName: string): CloseProfileResult | FailureResult;
  releaseProfile(profileName: string): ReleaseProfileResult | FailureResult;
  /** Permanently removes live and durable runtime state for a deleted profile. */
  removeProfile(profileName: string): void;
  /**
   * Drops a profile's live session with 4401 so a rotated secret takes effect.
   * Deliberately leaves the buffer and any hold alone: the messages are still
   * wanted, and only the credential changed.
   */
  revokeSession(profileName: string): boolean;
  health(): Record<string, unknown>;
}

const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 60_000;
const AUTH_FAIL_LIMIT = 10;
const AUTH_FAIL_WINDOW_MS = 60_000;
const WAKE_TIMEOUT_MS = 10_000;
const MAINTENANCE_INTERVAL_MS = 3_600_000;
const JSON_BODY_LIMIT = 1_048_576;
const CLOSE_GRACE_MS = 2_000;
/** Minimum time `close_profile` keeps a profile's relay reconnects refused. */
export const HOLD_MS = 20_000;
/** How long a detached relay socket gets to finish its close handshake. */
const DETACH_GRACE_MS = 5_000;

interface Hold {
  untilMs: number;
  cancel: () => void;
}

function defaultSchedule(fn: () => void, delayMs: number): () => void {
  const timer = setTimeout(fn, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

/** Closes `wss` without letting a non-cooperative client stall shutdown. */
function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  return new Promise<void>((resolvePromise) => {
    const grace = setTimeout(() => {
      for (const client of wss.clients) {
        client.terminate();
      }
    }, CLOSE_GRACE_MS);
    grace.unref?.();
    wss.close(() => {
      clearTimeout(grace);
      resolvePromise();
    });
  });
}

type AuthFailureReason =
  "missing_token" | "malformed" | "unknown_id" | "bad_signature" | "expired" | "throttled";

type AuthOutcome = { ok: true; profile: ProfileConfig } | { ok: false; reason: AuthFailureReason };

interface SessionEntry {
  ws: WebSocket;
  session: Session;
  profile: ProfileConfig;
  ping: NodeJS.Timeout;
  lastPong: number;
}

/** Per-IP sliding-ish window over authentication failures. */
class FailureThrottle {
  readonly #hits = new Map<string, { count: number; windowStart: number }>();

  record(ip: string, nowMs: number): void {
    const hit = this.#hits.get(ip);
    if (hit === undefined || nowMs - hit.windowStart > AUTH_FAIL_WINDOW_MS) {
      this.#hits.set(ip, { count: 1, windowStart: nowMs });
      return;
    }
    hit.count += 1;
  }

  isThrottled(ip: string, nowMs: number): boolean {
    const hit = this.#hits.get(ip);
    if (hit === undefined) {
      return false;
    }
    if (nowMs - hit.windowStart > AUTH_FAIL_WINDOW_MS) {
      this.#hits.delete(ip);
      return false;
    }
    return hit.count >= AUTH_FAIL_LIMIT;
  }

  prune(nowMs: number): void {
    for (const [ip, hit] of this.#hits) {
      if (nowMs - hit.windowStart > AUTH_FAIL_WINDOW_MS) {
        this.#hits.delete(ip);
      }
    }
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.byteLength),
  });
  res.end(body);
}

function rawToString(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data as ArrayBuffer).toString("utf8");
}

function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

async function readBody(
  req: IncomingMessage,
  limit: number
): Promise<{ ok: true; body: Buffer } | { ok: false; reason: "too_large" }> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) {
    return { ok: false, reason: "too_large" };
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.byteLength;
    if (total > limit) {
      return { ok: false, reason: "too_large" };
    }
    chunks.push(buf);
  }
  return { ok: true, body: Buffer.concat(chunks) };
}

export function createRelayServer(opts: RelayServerOptions): RelayServer {
  const { config, store, log } = opts;
  const currentConfig = (): Config => opts.getConfig?.() ?? config;
  const nowSeconds = opts.now ?? ((): number => Math.floor(Date.now() / 1000));
  const nowMs = opts.nowMs ?? Date.now;
  const scheduleHoldExpiry = opts.scheduleHoldExpiry ?? defaultSchedule;
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const sessions = new Map<string, SessionEntry>();
  const lastWake = new Map<string, number>();
  const holds = new Map<string, Hold>();
  /** Relay sockets detached by management, still finishing their close. */
  const detached = new Set<WebSocket>();
  const throttle = new FailureThrottle();
  let boundPort: number | null = null;
  let boundHost: string | null = null;
  let closed = false;
  let mcpEndpoint: McpEndpoint | null = null;

  // --------------------------------------------------------------------- auth

  function authenticate(req: IncomingMessage): AuthOutcome {
    const ip = clientIp(req);
    if (throttle.isThrottled(ip, Date.now())) {
      return { ok: false, reason: "throttled" };
    }

    const token = parseBearer(req.headers.authorization);
    if (token === null) {
      return fail(ip, "missing_token");
    }

    const claimed = peekPayload(token);
    if (claimed === null) {
      return fail(ip, "malformed");
    }

    const profile = currentConfig().profiles.find((candidate) => candidate.gatewayId === claimed);
    if (profile === undefined) {
      return fail(ip, "unknown_id");
    }

    const verified = verifyToken(token, profile.secret, nowSeconds());
    if (!verified.ok) {
      return fail(ip, verified.reason);
    }
    return { ok: true, profile };
  }

  function fail(ip: string, reason: AuthFailureReason): AuthOutcome {
    throttle.record(ip, Date.now());
    return { ok: false, reason };
  }

  /**
   * Static-secret check for `/management`; profile credentials never pass.
   * Deliberately outside the relay's per-IP throttle: management failures must
   * never turn into 4401s for relay reconnects sharing that IP (Hermes latches
   * a repeated 4401 as revocation). Bad attempts are simply rejected.
   */
  function authenticateManagement(req: IncomingMessage, secret: string): boolean {
    const ip = clientIp(req);
    const token = parseBearer(req.headers.authorization);
    if (token !== null && secretMatches(token, secret)) {
      return true;
    }
    // Never log the token itself.
    log.warn(
      { path: req.url, ip, reason: token === null ? "missing_token" : "bad_secret" },
      "management auth failure"
    );
    return false;
  }

  function logAuthFailure(req: IncomingMessage, reason: AuthFailureReason): void {
    // Never log the token itself.
    log.warn(
      { method: req.method, path: req.url, ip: clientIp(req), reason },
      "relay auth failure"
    );
  }

  /** HTTP-route auth; writes the error response itself on failure. */
  function authorizeHttp(req: IncomingMessage, res: ServerResponse): ProfileConfig | null {
    const outcome = authenticate(req);
    if (outcome.ok) {
      return outcome.profile;
    }
    logAuthFailure(req, outcome.reason);
    if (outcome.reason === "throttled") {
      sendJson(res, 429, { error: "too many failed attempts" });
    } else if (outcome.reason === "expired") {
      sendJson(res, 401, { error: "expired" });
    } else {
      sendJson(res, 401, { error: "unauthorized" });
    }
    // Drain the (unread) body so the client reliably sees the response.
    req.resume();
    return null;
  }

  // ----------------------------------------------------------------- upgrades

  const wss = new WebSocketServer({ noServer: true });
  // Separate server and client set: management never counts as a relay session.
  // The per-frame (per-line) limit is enforced by the endpoint; this only caps
  // one WebSocket message, which may carry several coalesced frames.
  const managementWss = new WebSocketServer({
    noServer: true,
    maxPayload: MANAGEMENT_MAX_MESSAGE_BYTES,
  });
  const management = new ManagementEndpoint({
    log: log.child({ route: "/management" }),
    pending: pendingSnapshot,
    closeProfile,
    releaseProfile,
    ...(opts.managementMaxBufferedBytes === undefined
      ? {}
      : { maxBufferedBytes: opts.managementMaxBufferedBytes }),
  });

  /**
   * Installed first thing on every upgraded socket, before any rejection path:
   * a malformed frame (possibly already in the upgrade packet) makes `ws` emit
   * `error`, and an `error` with no listener would crash the process.
   */
  function guardSocketErrors(ws: WebSocket, route: "relay" | "management"): void {
    ws.on("error", (err) => {
      log.debug({ route, err: String(err) }, "websocket error");
    });
  }

  function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://relay.invalid").pathname;
    } catch {
      pathname = "/";
    }
    const managementSecret = currentConfig().management?.secret;
    if (pathname === "/management" && managementSecret !== undefined) {
      const authorized = authenticateManagement(req, managementSecret);
      managementWss.handleUpgrade(req, socket, head, (ws) => {
        guardSocketErrors(ws, "management");
        if (!authorized) {
          ws.close(4401, "unauthorized");
          return;
        }
        management.attach(ws, clientIp(req));
      });
      return;
    }
    if (pathname !== "/relay") {
      log.warn({ path: req.url, ip: clientIp(req) }, "websocket upgrade on an unknown path");
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }

    const outcome = authenticate(req);
    // The handshake is always completed: only a 4401 *close* engages the
    // gateway's relogin path (an HTTP 401 makes it retry blindly).
    wss.handleUpgrade(req, socket, head, (ws) => {
      guardSocketErrors(ws, "relay");
      if (!outcome.ok) {
        logAuthFailure(req, outcome.reason);
        if (outcome.reason === "throttled") {
          // 1013, not 4401. A throttle is our own rate limit, and a gateway
          // reads 4401 after the handshake as revocation and stops reconnecting
          // — so being briefly throttled would lock a healthy gateway out for
          // good. 1013 is the code that means "come back", which is the truth.
          ws.close(1013, "try again later");
          return;
        }
        const reason = outcome.reason === "expired" ? "expired" : "unauthorized";
        ws.close(4401, reason);
        return;
      }
      // Checked here, right before attaching, so no auth->attach race remains.
      // 1013 = "try again later": not 4401 (Hermes latches on it) and not 1008
      // (that reads as a duplicate session).
      if (isHeld(outcome.profile.name)) {
        log.info(
          { profile: outcome.profile.name, ip: clientIp(req) },
          "relay reconnect refused: profile is held by management"
        );
        ws.close(1013, "profile temporarily suspended");
        return;
      }
      attachSession(ws, outcome.profile, req);
    });
  }

  function attachSession(ws: WebSocket, profile: ProfileConfig, req: IncomingMessage): void {
    if (sessions.has(profile.name)) {
      log.warn(
        { profile: profile.name, ip: clientIp(req) },
        "second relay connection for this profile; closing the new one"
      );
      ws.close(1008, "duplicate session");
      return;
    }

    const childLog = log.child({ profile: profile.name });
    const assembler = new LineAssembler();
    const session = new Session({
      profile: profile.name,
      store,
      descriptor: buildDescriptor(currentConfig()),
      send: (frame) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(encodeFrame(frame));
        }
      },
      execute: (action, platform) => opts.execute(profile, action, platform),
      log: childLog,
    });

    const ping = setInterval(() => {
      const entry = sessions.get(profile.name);
      if (entry === undefined) {
        return;
      }
      if (Date.now() - entry.lastPong > PONG_TIMEOUT_MS) {
        childLog.warn("no pong within 60s; terminating the relay socket");
        ws.terminate();
        return;
      }
      try {
        ws.ping();
      } catch {
        /* the socket is going away anyway */
      }
    }, PING_INTERVAL_MS);
    ping.unref?.();

    const entry: SessionEntry = { ws, session, profile, ping, lastPong: Date.now() };
    sessions.set(profile.name, entry);
    childLog.info({ ip: clientIp(req) }, "relay session connected");

    ws.on("pong", () => {
      entry.lastPong = Date.now();
    });

    ws.on("message", (data: RawData) => {
      for (const line of assembler.push(rawToString(data))) {
        const frame = parseGatewayFrame(line);
        if (frame === null) {
          childLog.warn(
            { line: line.slice(0, 200) },
            "ignoring unparseable or unknown relay frame"
          );
          continue;
        }
        void session.handleFrame(frame).catch((err: unknown) => {
          childLog.error({ err: String(err), type: frame.type }, "relay frame handler failed");
        });
      }
    });

    ws.on("error", (err) => {
      childLog.warn({ err: String(err) }, "relay socket error");
    });

    ws.on("close", (code, reasonBuf) => {
      clearInterval(ping);
      session.close();
      if (sessions.get(profile.name) === entry) {
        sessions.delete(profile.name);
      }
      childLog.info({ code, reason: reasonBuf.toString() }, "relay session disconnected");
    });
  }

  // -------------------------------------------------------------- http routes

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${req.headers.host ?? "relay.invalid"}`);
    } catch {
      sendJson(res, 400, { error: "bad request" });
      return;
    }
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";

    if (method === "GET" && path === "/healthz") {
      handleHealth(res);
      return;
    }
    if (path === "/mcp" && mcpEndpoint !== null) {
      await mcpEndpoint.handle(req, res);
      return;
    }
    if (method === "POST" && path === "/relay/policy") {
      await handlePolicy(req, res);
      return;
    }
    if (method === "POST" && path === "/relay/media") {
      await handleMediaUpload(req, res);
      return;
    }
    if (method === "GET" && path.startsWith("/relay/media/")) {
      handleMediaDownload(req, res, path.slice("/relay/media/".length));
      return;
    }
    if (method === "POST" && path === "/debug/inbound" && opts.debugInbound !== undefined) {
      await handleDebugInbound(req, res, opts.debugInbound);
      return;
    }
    // `/relay/enroll` and `/relay/provision` are 404 by design (no enrollment).
    sendJson(res, 404, { error: "not found" });
  }

  function handleHealth(res: ServerResponse): void {
    sendJson(res, 200, healthSnapshot());
  }

  async function handlePolicy(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const profile = authorizeHttp(req, res);
    if (profile === null) {
      return;
    }
    const body = await readBody(req, JSON_BODY_LIMIT);
    if (!body.ok) {
      sendJson(res, 413, { error: "payload too large" });
      return;
    }
    let parsed: unknown;
    try {
      parsed = body.body.byteLength === 0 ? {} : JSON.parse(body.body.toString("utf8"));
    } catch {
      sendJson(res, 400, { error: "invalid json" });
      return;
    }
    const stored = store.policy.set(profile.name, parsed, nowSeconds());
    log.info({ profile: profile.name, policy: stored }, "relay policy updated");
    sendJson(res, 200, {});
  }

  async function handleMediaUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const profile = authorizeHttp(req, res);
    if (profile === null) {
      return;
    }
    const body = await readBody(req, currentConfig().media.maxBytes);
    if (!body.ok) {
      sendJson(res, 413, { error: "payload too large" });
      return;
    }
    const mime = (req.headers["content-type"] ?? "application/octet-stream").split(";")[0]?.trim();
    const filenameHeader = req.headers["x-media-filename"];
    const filename = Array.isArray(filenameHeader) ? filenameHeader[0] : filenameHeader;
    try {
      const { id } = store.media.put(
        profile.name,
        body.body,
        mime === undefined || mime === "" ? "application/octet-stream" : mime,
        filename ?? null,
        nowSeconds()
      );
      log.debug({ profile: profile.name, id, size: body.body.byteLength }, "media stored");
      sendJson(res, 200, { id });
    } catch (err: unknown) {
      if (err instanceof MediaTooLargeError) {
        sendJson(res, 413, { error: "payload too large" });
        return;
      }
      log.error({ err: String(err), profile: profile.name }, "media upload failed");
      sendJson(res, 500, { error: "could not store media" });
    }
  }

  function handleMediaDownload(req: IncomingMessage, res: ServerResponse, rawId: string): void {
    const profile = authorizeHttp(req, res);
    if (profile === null) {
      return;
    }
    let id: string;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    const meta = store.media.getMeta(id);
    // Another profile's media must be indistinguishable from media that is not there.
    if (meta === null || meta.profile !== profile.name) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    const found = store.media.get(id);
    if (found === null) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    res.writeHead(200, {
      "content-type": found.meta.mime,
      "content-length": String(found.bytes.byteLength),
      "content-disposition": contentDisposition(found.meta.filename, id),
      "cache-control": "private, max-age=300",
    });
    res.end(found.bytes);
  }

  async function handleDebugInbound(
    req: IncomingMessage,
    res: ServerResponse,
    handler: (body: unknown) => Promise<void>
  ): Promise<void> {
    const body = await readBody(req, JSON_BODY_LIMIT);
    if (!body.ok) {
      sendJson(res, 413, { error: "payload too large" });
      return;
    }
    let parsed: unknown;
    try {
      parsed = body.body.byteLength === 0 ? {} : JSON.parse(body.body.toString("utf8"));
    } catch {
      sendJson(res, 400, { error: "invalid json" });
      return;
    }
    try {
      await handler(parsed);
      sendJson(res, 200, {});
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err: message }, "debug inbound failed");
      sendJson(res, 500, { error: message });
    }
  }

  const httpServer: Server = createServer((req, res) => {
    void handleRequest(req, res).catch((err: unknown) => {
      log.error({ err: String(err), path: req.url }, "request handler failed");
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal error" });
      } else {
        res.end();
      }
    });
  });
  httpServer.on("upgrade", onUpgrade);

  // ---------------------------------------------------------------- wake poke

  function maybeWake(profile: ProfileConfig): void {
    const url = profile.wakeUrl;
    if (url === null || url === "") {
      return;
    }
    if (sessions.has(profile.name)) {
      return;
    }
    // Suppressed, not spent: a held poke leaves the cooldown untouched.
    if (isHeld(profile.name)) {
      return;
    }
    const now = nowSeconds();
    const last = lastWake.get(profile.name);
    if (last !== undefined && now - last < currentConfig().buffer.wakeCooldownSeconds) {
      return;
    }
    lastWake.set(profile.name, now);

    void (async () => {
      try {
        const res = await doFetch(url, {
          method: "GET",
          signal: AbortSignal.timeout(WAKE_TIMEOUT_MS),
        });
        log.info({ profile: profile.name, status: res.status }, "wake poke sent");
      } catch (err: unknown) {
        // Best effort by design: the buffer already holds the event.
        log.info({ profile: profile.name, err: String(err) }, "wake poke failed");
      }
    })();
  }

  // --------------------------------------------------------------- management

  function isHeld(profileName: string): boolean {
    const hold = holds.get(profileName);
    return hold !== undefined && nowMs() < hold.untilMs;
  }

  function pendingSnapshot(): PendingProfile[] {
    const pending: PendingProfile[] = [];
    for (const profile of currentConfig().profiles) {
      const bufferedCount = store.buffer.count(profile.name);
      if (bufferedCount > 0) {
        pending.push({ profile: profile.name, gatewayId: profile.gatewayId, bufferedCount });
      }
    }
    return pending;
  }

  /** Arms (or re-arms) the expiry check for `profile`'s current hold. */
  function armHoldExpiry(profile: ProfileConfig, hold: Hold): void {
    hold.cancel = scheduleHoldExpiry(
      () => {
        if (closed || holds.get(profile.name) !== hold) {
          return; // replaced by a newer close_profile, or shutting down
        }
        if (nowMs() < hold.untilMs) {
          armHoldExpiry(profile, hold); // the timer fired early
          return;
        }
        holds.delete(profile.name);
        // `wasEmpty` will not fire again for a buffer that is already non-empty,
        // so this is the one chance to wake an agent that has work waiting.
        if (!sessions.has(profile.name) && store.buffer.count(profile.name) > 0) {
          maybeWake(profile);
        }
      },
      Math.max(0, hold.untilMs - nowMs())
    );
  }

  /** Gives a detached relay socket a bounded close handshake. */
  function closeDetached(ws: WebSocket, code: number, reason: string): void {
    detached.add(ws);
    const grace = setTimeout(() => ws.terminate(), DETACH_GRACE_MS);
    grace.unref?.();
    ws.once("close", () => {
      clearTimeout(grace);
      detached.delete(ws);
    });
    try {
      ws.close(code, reason);
    } catch {
      ws.terminate();
    }
  }

  /**
   * Synchronous by contract: when this returns, live delivery to the profile
   * is already off, so the orchestrator may suspend the agent on the result.
   */
  function closeProfile(profileName: string): CloseProfileResult | FailureResult {
    const profile = currentConfig().profiles.find((candidate) => candidate.name === profileName);
    if (profile === undefined) {
      return { success: false, error: "unknown profile" };
    }

    // 1. Hold first, so a reconnect racing this call is already refused.
    const untilMs = nowMs() + HOLD_MS;
    holds.get(profile.name)?.cancel();
    const hold: Hold = { untilMs, cancel: () => undefined };
    holds.set(profile.name, hold);
    armHoldExpiry(profile, hold);

    // 2-4. Detach now; the socket's own close handler keeps its identity guard.
    const entry = sessions.get(profile.name);
    if (entry !== undefined) {
      sessions.delete(profile.name);
      clearInterval(entry.ping);
      entry.session.close();
      closeDetached(entry.ws, 1001, "closed by management");
    }
    log.info(
      { profile: profile.name, wasConnected: entry !== undefined, blockedUntilMs: untilMs },
      "relay session closed by management"
    );
    return {
      success: true,
      profile: profile.name,
      wasConnected: entry !== undefined,
      blockedUntilMs: untilMs,
      retryAfterMs: HOLD_MS,
    };
  }

  /** Cancels only the reconnect hold; the orchestrator owns resume/wake policy. */
  function releaseProfile(profileName: string): ReleaseProfileResult | FailureResult {
    const profile = currentConfig().profiles.find((candidate) => candidate.name === profileName);
    if (profile === undefined) {
      return { success: false, error: "unknown profile" };
    }

    const hold = holds.get(profile.name);
    const wasHeld = hold !== undefined && nowMs() < hold.untilMs;
    if (hold !== undefined) {
      hold.cancel();
      holds.delete(profile.name);
    }
    log.info({ profile: profile.name, wasHeld }, "relay reconnect hold released by management");
    return { success: true, profile: profile.name, wasHeld };
  }

  function revokeSession(profileName: string): boolean {
    const entry = sessions.get(profileName);
    if (entry === undefined) {
      log.info({ profile: profileName, wasConnected: false }, "relay session revoked");
      return false;
    }
    sessions.delete(profileName);
    clearInterval(entry.ping);
    entry.session.close();
    // 4401, not 1001: the gateway reads 4401 as revocation and stops
    // reconnecting with the secret that is no longer valid.
    closeDetached(entry.ws, 4401, "unauthorized");
    log.info({ profile: profileName, wasConnected: true }, "relay session revoked");
    return true;
  }

  function removeProfile(profileName: string): void {
    const hold = holds.get(profileName);
    hold?.cancel();
    holds.delete(profileName);
    lastWake.delete(profileName);

    const entry = sessions.get(profileName);
    if (entry !== undefined) {
      sessions.delete(profileName);
      clearInterval(entry.ping);
      entry.session.close();
      closeDetached(entry.ws, 1001, "profile deleted");
    }
    store.buffer.purgeProfile(profileName);
    store.media.purgeProfile(profileName);
    store.policy.delete(profileName);
    log.info({ profile: profileName, wasConnected: entry !== undefined }, "profile state removed");
  }

  // -------------------------------------------------------------- maintenance

  function runMaintenance(now: number = nowSeconds()): {
    bufferPurged: number;
    mediaPurged: number;
  } {
    throttle.prune(Date.now());
    const latest = currentConfig();
    const bufferPurged = store.buffer.purgeOlderThan(latest.buffer.maxAgeSeconds, now);
    const mediaPurged = store.media.purgeOlderThan(latest.media.retentionSeconds, now);
    if (bufferPurged > 0 || mediaPurged > 0) {
      log.info({ bufferPurged, mediaPurged }, "maintenance sweep removed expired rows");
    }
    return { bufferPurged, mediaPurged };
  }

  const maintenanceTimer = setInterval(() => {
    try {
      runMaintenance();
    } catch (err: unknown) {
      log.error({ err: String(err) }, "maintenance sweep failed");
    }
  }, MAINTENANCE_INTERVAL_MS);
  maintenanceTimer.unref?.();

  if (opts.whatsapp !== undefined) {
    mcpEndpoint = createMcpEndpoint({
      getConfig: currentConfig,
      configStore: opts.configStore,
      whatsapp: opts.whatsapp,
      closeProfile,
      releaseProfile,
      removeProfile,
      revokeSession,
      health: healthSnapshot,
      log: log.child({ route: "/mcp" }),
    });
  }

  // ------------------------------------------------------------------- public

  return {
    async listen() {
      await new Promise<void>((resolvePromise, reject) => {
        const onError = (err: Error): void => reject(err);
        httpServer.once("error", onError);
        httpServer.listen(config.listen.port, config.listen.host, () => {
          httpServer.removeListener("error", onError);
          resolvePromise();
        });
      });
      const addr = httpServer.address() as AddressInfo | string | null;
      if (addr !== null && typeof addr === "object") {
        boundHost = config.listen.host;
        boundPort = addr.port;
      } else {
        boundHost = config.listen.host;
        boundPort = config.listen.port;
      }
      log.info(
        { host: boundHost, port: boundPort, profiles: config.profiles.length },
        "relay server listening"
      );
      return { host: boundHost, port: boundPort };
    },

    async close() {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(maintenanceTimer);
      for (const hold of holds.values()) {
        hold.cancel();
      }
      holds.clear();
      management.close();
      await mcpEndpoint?.close();
      for (const ws of detached) {
        ws.terminate();
      }
      detached.clear();
      for (const entry of sessions.values()) {
        clearInterval(entry.ping);
        entry.session.close();
        try {
          entry.ws.close(1001, "going away");
        } catch {
          /* already gone */
        }
      }
      sessions.clear();
      await Promise.all([closeWebSocketServer(wss), closeWebSocketServer(managementWss)]);
      await new Promise<void>((resolvePromise) => {
        let done = false;
        const finish = (): void => {
          if (done) {
            return;
          }
          done = true;
          resolvePromise();
        };
        httpServer.close(finish);
        httpServer.closeIdleConnections();
        const grace = setTimeout(() => {
          httpServer.closeAllConnections();
          finish();
        }, CLOSE_GRACE_MS);
        grace.unref?.();
      });
      boundPort = null;
      boundHost = null;
    },

    deliver(profileName, event) {
      const profile = currentConfig().profiles.find((candidate) => candidate.name === profileName);
      if (profile === undefined) {
        log.warn({ profile: profileName }, "delivery for an unknown profile");
        return "unknown_profile";
      }
      let outcome: "live" | "buffered";
      const entry = sessions.get(profileName);
      if (entry !== undefined) {
        const live = entry.session.canDeliverLive;
        entry.session.deliver(event);
        outcome = live ? "live" : "buffered";
      } else {
        const { wasEmpty } = store.buffer.append(profileName, event, nowSeconds());
        if (wasEmpty) {
          maybeWake(profile);
        }
        outcome = "buffered";
      }
      // After the outcome is settled; `publish` is best effort and never throws.
      management.publish({
        profile: profile.name,
        gatewayId: profile.gatewayId,
        messageId: event.message_id,
        delivery: outcome,
      });
      return outcome;
    },

    isConnected(profileName) {
      return sessions.has(profileName);
    },

    bufferedCount(profileName) {
      return store.buffer.count(profileName);
    },

    address() {
      if (boundPort === null || boundHost === null) {
        return null;
      }
      return { host: boundHost, port: boundPort };
    },

    runMaintenance,
    closeProfile,
    releaseProfile,
    removeProfile,
    revokeSession,
    health: healthSnapshot,
  };

  function healthSnapshot(): Record<string, unknown> {
    const profiles: Record<
      string,
      { connected: boolean; buffered: number; blockedUntilMs?: number }
    > = {};
    for (const profile of currentConfig().profiles) {
      const hold = holds.get(profile.name);
      profiles[profile.name] = {
        connected: sessions.has(profile.name),
        buffered: store.buffer.count(profile.name),
        ...(hold !== undefined && isHeld(profile.name) ? { blockedUntilMs: hold.untilMs } : {}),
      };
    }
    let extra: Record<string, unknown> = {};
    try {
      extra = opts.health();
    } catch (err: unknown) {
      log.error({ err: String(err) }, "health callback failed");
    }
    return { status: "ok", ...extra, profiles };
  }
}

/** Convenience re-export so WP4 can build event media URLs from one import. */
export { mediaUrl };
