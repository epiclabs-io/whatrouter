/**
 * `whatrouter serve`: the composition root.
 *
 *   sqlite store  ->  WhatsApp port (Baileys, or the fake one)
 *                 ->  router (routes + relevance + event building)
 *                 ->  relay hub (WS sessions, delivery, buffer, media)
 *                 ->  http server (health, relay routes, /mcp, /management)
 *
 * This is the only module that knows all of those exist. Each of them takes what
 * it needs and nothing else: the hub does not know that management exists, it
 * calls the `isHeld` predicate it is handed; the MCP endpoint does not know that
 * sessions exist, it is handed `closeProfile`/`revokeSession` and calls them.
 *
 * Two indirections are unavoidable and are spelled out rather than hidden:
 * the router needs the hub to deliver and the hub needs the router to execute,
 * and the hub needs the holds that management places. Each is one `let` assigned
 * a line later, in the order the calls happen.
 *
 * Nothing here prints a QR code: `serve` refuses to start unpaired and points at
 * `whatrouter pair`, which is the only command allowed to touch the link flow.
 */
import type { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";
import { WebSocketServer } from "ws";
import { ConfigStore } from "./config/store.js";
import { debugInboundRoute } from "./debug-inbound.js";
import { EXIT_CONFIG, EXIT_FAILURE, EXIT_OK } from "./exit-codes.js";
import { closeWebSocketServer, createHttpServer, type HttpServer } from "./http/server.js";
import { secretMatches } from "./management/auth.js";
import { createHolds } from "./management/holds.js";
import { ManagementEndpoint, MANAGEMENT_MAX_MESSAGE_BYTES } from "./management/endpoint.js";
import type { PendingProfile } from "./management/frames.js";
import { createMcpEndpoint } from "./mcp/endpoint.js";
import { createRouter, type RelayDeliverer, type Router } from "./router/router.js";
import { buildDescriptor } from "./relay/descriptor.js";
import { parseBearer } from "./relay/auth.js";
import { createRelayGate } from "./relay/gate.js";
import { createRelayHub } from "./relay/hub.js";
import { relayRoutes } from "./relay/http.js";
import { mediaUrl } from "./relay/media-url.js";
import { openStoreFromConfig, type Store } from "./store/db.js";
import { createBaileysClient } from "./whatsapp/baileys-client.js";
import { createFakeWhatsAppPort, type FakeWhatsAppPort } from "./whatsapp/fake.js";
import type { Config } from "./config/schema.js";
import type { Logger } from "./util/log.js";
import { packageVersion } from "./version.js";
import type { WhatsAppPort } from "./whatsapp/port.js";

export const PAIRING_HINT =
  "WhatsApp account is not linked. Run: whatrouter pair   (or whatrouter pair --code +<phone>)";

export interface ServeIo {
  out(line: string): void;
  err(line: string): void;
}

export interface ServeOptions {
  getConfig: () => Config;
  /** Writable live config used by production and MCP mutation tools. */
  configStore?: ConfigStore | undefined;
  log: Logger;
  io: ServeIo;
  /** Defaults to `WHATROUTER_FAKE_WHATSAPP=1`. */
  fake?: boolean | undefined;
  /** `false` skips the SIGINT/SIGTERM wait (tests drive `close()` themselves). */
  signals?: boolean | undefined;
  /** Outgoing bytes an operator's management client may leave unread. */
  managementMaxBufferedBytes?: number | undefined;
  /** Injectable for tests: the clock holds and expiry timers run on. */
  nowMs?: (() => number) | undefined;
  scheduleHoldExpiry?: ((fn: () => void, delayMs: number) => () => void) | undefined;
  /** Injectable for the wake poke. */
  fetchImpl?: typeof fetch | undefined;
}

export interface ServeHandle {
  /** The address actually bound (`listen: …:0` resolves to a real port here). */
  address: { host: string; port: number };
  server: HttpServer;
  hub: ReturnType<typeof createRelayHub>;
  holds: ReturnType<typeof createHolds>;
  router: Router;
  store: Store;
  whatsapp: WhatsAppPort;
  /** Non-null only in fake mode; what `POST /debug/inbound` injects into. */
  fake: FakeWhatsAppPort | null;
  /** The same document `GET /healthz` returns. */
  health(): Record<string, unknown>;
  /** Hourly by itself; exposed so tests (and ops) can force a sweep. */
  runMaintenance(nowSeconds?: number): { bufferPurged: number; mediaPurged: number };
  close(): Promise<void>;
}

export type StartServeResult = { ok: true; handle: ServeHandle } | { ok: false; code: number };

const MAINTENANCE_INTERVAL_MS = 3_600_000;

/**
 * Drops per-profile state for names the config no longer has (D6).
 *
 * The buffer, media and policy tables are keyed by profile name, so a profile
 * renamed by hand leaves its rows behind: they occupy the queue and the disk
 * until they expire, and if the old name is ever used again the new agent
 * inherits the old one's queued messages and media. Purging at startup means
 * the only state a profile has is state its own name produced.
 *
 * Reconciling rather than trusting is deliberate: MCP deletes purge through
 * `removeProfile`, but a hand-edited config is exactly the case that needs
 * this, and it has no other cleanup path.
 */
function reconcileProfileState(store: Store, configured: readonly string[], log: Logger): void {
  const live = new Set(configured);
  const ghosts = new Set([
    ...store.buffer.profiles(),
    ...store.media.profiles(),
    ...store.policy.profiles(),
  ]);
  for (const profile of ghosts) {
    if (live.has(profile)) {
      continue;
    }
    const buffered = store.buffer.purgeProfile(profile);
    const media = store.media.purgeProfile(profile);
    const hadPolicy = store.policy.delete(profile);
    log.warn(
      { profile, buffered, media, hadPolicy },
      "dropped runtime state for a profile that is not in the config"
    );
  }
}

/**
 * Boots everything and returns a handle (address + `close`). Exposed separately
 * from `runServe` so tests can bind port 0 and still find out where we landed.
 */
export async function startServe(opts: ServeOptions): Promise<StartServeResult> {
  const { configStore, getConfig } = opts;
  const config = getConfig();
  const { log, io } = opts;
  const fake = opts.fake ?? process.env["WHATROUTER_FAKE_WHATSAPP"] === "1";
  if (fake) {
    log.warn(
      "################  WHATROUTER_FAKE_WHATSAPP=1  ################\n" +
        "No WhatsApp connection: inbound is injected through POST /debug/inbound\n" +
        "and every outbound action is recorded in memory. Never run this in production.\n" +
        "##############################################################"
    );
  }

  // The boot snapshot. Each value below is read exactly once, here, and handed
  // to the module that needs it as its own option. Only `profiles`, `groups` and
  // `default_profile` are read live, through `getConfig`; anything else arriving
  // live would let a hand edit half-apply, with the store enforcing one cap
  // while the HTTP layer enforced another.
  const boot = {
    listen: config.listen,
    descriptor: buildDescriptor(config),
    maxMediaBytes: config.media.maxBytes,
    allowUnroutedOutbound: config.allowUnroutedOutbound,
    wakeCooldownSeconds: config.buffer.wakeCooldownSeconds,
    bufferMaxAgeSeconds: config.buffer.maxAgeSeconds,
    mediaRetentionSeconds: config.media.retentionSeconds,
    /** Absent means no `/management` and no `/mcp` auth. */
    managementSecret: config.management?.secret,
  };

  // A `const` local, because a property of `boot` cannot stay narrowed inside
  // the upgrade handler below (it could, in principle, change).
  const { managementSecret } = boot;

  const store = openStoreFromConfig(config);
  // Before anything can read a profile's rows, drop the rows of profiles the
  // config no longer has.
  reconcileProfileState(
    store,
    getConfig().profiles.map((p) => p.name),
    log
  );
  const fakePort = fake ? createFakeWhatsAppPort() : null;
  const whatsapp: WhatsAppPort =
    fakePort ?? createBaileysClient({ config, log: log.child({ component: "whatsapp" }) });

  // `listen: …:0` only resolves to a real port after `listen()`, and media URLs
  // must carry that port, so the builder reads a mutable binding.
  let boundPort = boot.listen.port;
  const mediaUrlFor = (id: string): string => mediaUrl(config, id, { port: boundPort, log });

  const gate = createRelayGate({
    getConfig,
    log: log.child({ component: "relay" }),
  });

  const management = new ManagementEndpoint({
    log: log.child({ route: "/management" }),
    pending: (): PendingProfile[] => {
      const pending: PendingProfile[] = [];
      for (const profile of getConfig().profiles) {
        const bufferedCount = store.buffer.count(profile.name);
        if (bufferedCount > 0) {
          pending.push({ profile: profile.name, gatewayId: profile.gatewayId, bufferedCount });
        }
      }
      return pending;
    },
    closeProfile: (profile) => holds.closeProfile(profile),
    releaseProfile: (profile) => holds.releaseProfile(profile),
    ...(opts.managementMaxBufferedBytes === undefined
      ? {}
      : { maxBufferedBytes: opts.managementMaxBufferedBytes }),
  });

  // The hub and the holds refer to each other: the hub refuses a reconnect the
  // holds place, and a hold detaches through the hub. Neither imports the other,
  // so the cycle is these two declarations and the closures inside them.
  const hub = createRelayHub({
    getConfig,
    store,
    log: log.child({ component: "relay" }),
    descriptor: boot.descriptor,
    execute: (profile, action, platform) => router.execute(profile, action, platform),
    isHeld: (profile) => holds.isHeld(profile),
    onDelivered: (delivered) =>
      management.publish({
        profile: delivered.profile.name,
        gatewayId: delivered.profile.gatewayId,
        messageId: delivered.messageId,
        delivery: delivered.delivery,
      }),
    wakeCooldownSeconds: boot.wakeCooldownSeconds,
    ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
  });

  const holds = createHolds({
    getConfig,
    hub,
    bufferedCount: (profile) => store.buffer.count(profile),
    log: log.child({ component: "management" }),
    ...(opts.nowMs === undefined ? {} : { nowMs: opts.nowMs }),
    ...(opts.scheduleHoldExpiry === undefined
      ? {}
      : { scheduleHoldExpiry: opts.scheduleHoldExpiry }),
  });

  const router = createRouter({
    getConfig,
    maxMediaBytes: boot.maxMediaBytes,
    allowUnroutedOutbound: boot.allowUnroutedOutbound,
    store,
    log: log.child({ component: "router" }),
    whatsapp,
    relay: {
      deliver: (profileName, event) => hub.deliver(profileName, event),
    } satisfies RelayDeliverer,
    mediaUrlFor,
  });

  function healthSnapshot(): Record<string, unknown> {
    const profiles: Record<
      string,
      { connected: boolean; buffered: number; blockedUntilMs?: number }
    > = {};
    for (const profile of getConfig().profiles) {
      const blockedUntilMs = holds.blockedUntilMs(profile.name);
      profiles[profile.name] = {
        connected: hub.isConnected(profile.name),
        buffered: store.buffer.count(profile.name),
        ...(blockedUntilMs === null ? {} : { blockedUntilMs }),
      };
    }
    return {
      status: "ok",
      whatsapp: whatsapp.state(),
      version: packageVersion(),
      profiles,
    };
  }

  const mcp = createMcpEndpoint({
    getConfig,
    configStore,
    whatsapp,
    management: managementSecret === undefined ? null : { secret: managementSecret },
    closeProfile: (profile) => holds.closeProfile(profile),
    releaseProfile: (profile) => holds.releaseProfile(profile),
    removeProfile: (name) => {
      holds.forget(name);
      hub.forget(name);
      store.buffer.purgeProfile(name);
      store.media.purgeProfile(name);
      store.policy.delete(name);
      log.info({ profile: name }, "profile state removed");
    },
    revokeSession: (name) => {
      // 4401, not 1001: the gateway reads 4401 as revocation and stops
      // reconnecting with the secret that is no longer valid.
      const wasConnected = hub.detach(name, 4401, "unauthorized");
      log.info({ profile: name, wasConnected }, "relay session revoked");
      return wasConnected;
    },
    health: healthSnapshot,
    log: log.child({ route: "/mcp" }),
  });

  // Separate server and client set from the hub's: management never counts as a
  // relay session. The per-frame (per-line) limit is enforced by the endpoint;
  // this only caps one WebSocket message, which may carry several coalesced
  // frames.
  const managementWss = new WebSocketServer({
    noServer: true,
    maxPayload: MANAGEMENT_MAX_MESSAGE_BYTES,
  });

  const server = createHttpServer({
    listen: boot.listen,
    log: log.child({ component: "http" }),
    routes: [
      ...relayRoutes({
        gate,
        store,
        log: log.child({ component: "relay" }),
        maxMediaBytes: boot.maxMediaBytes,
        health: healthSnapshot,
      }),
      // Any method, as before: the endpoint answers what it can and 405s the rest.
      { path: "/mcp", handle: (req, res) => mcp.handle(req, res) },
      ...(fakePort === null
        ? []
        : [
            debugInboundRoute(
              (message) => fakePort.inject(message),
              log.child({ route: "/debug" })
            ),
          ]),
    ],
    upgrades: {
      "/relay": (req, socket, head) => {
        const outcome = gate.authenticate(req);
        hub.upgrade(
          req,
          socket,
          head,
          outcome.ok
            ? { ok: true, profile: outcome.profile }
            : { ok: false, ...gate.wsClose(outcome.reason) }
        );
      },
      ...(managementSecret === undefined
        ? {}
        : {
            "/management": (req: IncomingMessage, socket: Duplex, head: Buffer) => {
              const authorized = managementAuthorized(req, managementSecret, log);
              managementWss.handleUpgrade(req, socket, head, (ws) => {
                ws.on("error", (err) => {
                  log.debug({ route: "management", err: String(err) }, "websocket error");
                });
                if (!authorized) {
                  ws.close(4401, "unauthorized");
                  return;
                }
                management.attach(ws, req.socket.remoteAddress ?? "unknown");
              });
            },
          }),
    },
  });

  whatsapp.onMessage(router.onInbound);

  function runMaintenance(now: number = Math.floor(Date.now() / 1000)): {
    bufferPurged: number;
    mediaPurged: number;
  } {
    gate.prune(Date.now());
    const bufferPurged = store.buffer.purgeOlderThan(boot.bufferMaxAgeSeconds, now);
    const mediaPurged = store.media.purgeOlderThan(boot.mediaRetentionSeconds, now);
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

  let closed = false;
  const shutdown = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(maintenanceTimer);
    try {
      holds.close();
      management.close();
      await mcp.close();
      await hub.close();
      await closeWebSocketServer(managementWss);
      await server.close();
    } catch (err: unknown) {
      log.warn({ err: String(err) }, "relay shutdown failed");
    }
    try {
      await whatsapp.stop();
    } catch (err: unknown) {
      log.warn({ err: String(err) }, "whatsapp shutdown failed");
    }
    try {
      store.close();
    } catch (err: unknown) {
      log.warn({ err: String(err) }, "store close failed");
    }
  };

  try {
    await whatsapp.start();
  } catch (err: unknown) {
    log.error({ err: String(err) }, "could not start the WhatsApp client");
    await shutdown();
    return { ok: false, code: EXIT_FAILURE };
  }

  // Refuse to listen unpaired: a Hermes instance that connects would silently
  // never receive anything.
  if (whatsapp.state() === "unpaired") {
    io.err(PAIRING_HINT);
    await shutdown();
    return { ok: false, code: EXIT_CONFIG };
  }

  let address: { host: string; port: number };
  try {
    address = await server.listen();
  } catch (err: unknown) {
    log.error({ err: String(err) }, "could not bind the relay server");
    await shutdown();
    return { ok: false, code: EXIT_FAILURE };
  }
  boundPort = address.port;

  log.info(
    {
      profiles: config.profiles.map((p) => ({
        name: p.name,
        gatewayId: p.gatewayId,
        routes: p.routes.length,
      })),
      defaultProfile: config.defaultProfile,
    },
    "whatrouter is serving; run `whatrouter env <profile>` for each Hermes instance"
  );

  return {
    ok: true,
    handle: {
      address,
      server,
      hub,
      holds,
      router,
      store,
      whatsapp,
      fake: fakePort,
      health: healthSnapshot,
      runMaintenance,
      close: shutdown,
    },
  };
}

/**
 * Static-secret check for `/management`; profile credentials never pass.
 *
 * Deliberately outside the relay's per-IP throttle: management failures must
 * never turn into 4401s for relay reconnects sharing that IP (Hermes latches a
 * repeated 4401 as revocation). Bad attempts are simply rejected.
 */
function managementAuthorized(req: IncomingMessage, secret: string, log: Logger): boolean {
  const token = parseBearer(req.headers.authorization);
  if (token !== null && secretMatches(token, secret)) {
    return true;
  }
  // Never log the token itself.
  log.warn(
    {
      path: req.url,
      ip: req.socket.remoteAddress ?? "unknown",
      reason: token === null ? "missing_token" : "bad_secret",
    },
    "management auth failure"
  );
  return false;
}

/** The CLI entry point: boots, then waits for a signal and shuts down cleanly. */
export async function runServe(opts: ServeOptions): Promise<number> {
  const started = await startServe(opts);
  if (!started.ok) {
    return started.code;
  }
  const { handle } = started;

  if (opts.signals === false) {
    await handle.close();
    return EXIT_OK;
  }

  const signal = await new Promise<NodeJS.Signals>((resolve) => {
    const onSignal = (received: NodeJS.Signals): void => {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      resolve(received);
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
  opts.log.info({ signal }, "shutting down");
  await handle.close();
  return EXIT_OK;
}
