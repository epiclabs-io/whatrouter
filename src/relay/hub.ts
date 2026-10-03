/**
 * The live half of the relay: one WebSocket session per profile, and delivery.
 *
 * The hub owns the sockets and nothing else. It does not decide who may connect
 * (that is `gate.ts`), it does not answer HTTP (`relay/http.ts`), and it does not
 * know that management exists — it calls the `isHeld` predicate it was handed, so
 * a reconnect hold is something this module observes rather than something it
 * implements.
 *
 * Delivery never drops. An event for a profile with no session lands in the
 * durable buffer, and the first event to do that may poke the profile's wake URL
 * so a disconnected agent finds out it has work.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { Config, ProfileConfig } from "../config/schema.js";
import { rawToString } from "../http/server.js";
import type { Store } from "../store/db.js";
import type { Logger } from "../util/log.js";
import type { CapabilityDescriptor, OutboundAction, OutboundResult, RelayEvent } from "./frames.js";
import { encodeFrame, LineAssembler, parseGatewayFrame } from "./ndjson.js";
import { Session } from "./session.js";

export type DeliveryOutcome = "live" | "buffered" | "unknown_profile";

/** What the gate decided about an upgrade, in the shape the hub needs. */
export type RelayAdmission =
  { ok: true; profile: ProfileConfig } | { ok: false; code: number; reason: string };

export interface DeliveredEvent {
  profile: ProfileConfig;
  messageId: string;
  delivery: "live" | "buffered";
}

export interface RelayHub {
  /**
   * The `/relay` upgrade, from a raw socket to a session.
   *
   * The caller has already had the gate decide, and passes that decision in: the
   * handshake is completed either way, because only a close code after the
   * handshake engages the gateway's relogin path, and an HTTP error makes it
   * retry blindly.
   */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, admission: RelayAdmission): void;
  /** Live when possible, else buffered. Never throws. */
  deliver(profileName: string, event: RelayEvent): DeliveryOutcome;
  isConnected(profileName: string): boolean;
  /**
   * Detaches now, so later inbound buffers rather than racing a socket on its
   * way out, then closes it with a bounded grace. Whether a session was there
   * is returned.
   */
  detach(profileName: string, code: number, reason: string): boolean;
  /** The profile is gone: forget its wake cooldown and drop any socket. */
  forget(profileName: string): boolean;
  /** Configured, not connected, not held, and outside the cooldown. */
  maybeWake(profileName: string): void;
  /** 1001 "going away" to every session; detached sockets are terminated. */
  close(): Promise<void>;
}

export interface RelayHubOptions {
  getConfig: () => Config;
  store: Store;
  log: Logger;
  descriptor: CapabilityDescriptor;
  execute: (
    profile: ProfileConfig,
    action: OutboundAction,
    platform?: string
  ) => Promise<OutboundResult>;
  /** Whether management currently refuses this profile's reconnects. */
  isHeld: (profileName: string) => boolean;
  /** Told after a delivery settles; best effort and must not throw. */
  onDelivered?: (delivered: DeliveredEvent) => void;
  wakeCooldownSeconds: number;
  fetchImpl?: typeof fetch;
  /** Unix seconds; injectable for tests. */
  now?: () => number;
}

const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 60_000;
const WAKE_TIMEOUT_MS = 10_000;
/** How long a detached relay socket gets to finish its close handshake. */
const DETACH_GRACE_MS = 5_000;
/** How long a closing hub waits before terminating sockets that linger. */
const CLOSE_GRACE_MS = 2_000;

interface SessionEntry {
  ws: WebSocket;
  session: Session;
  profile: ProfileConfig;
  ping: NodeJS.Timeout;
  lastPong: number;
}

export function createRelayHub(opts: RelayHubOptions): RelayHub {
  const { store, log } = opts;
  const nowSeconds = opts.now ?? ((): number => Math.floor(Date.now() / 1000));
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const sessions = new Map<string, SessionEntry>();
  const lastWake = new Map<string, number>();
  /** Relay sockets detached by management, still finishing their close. */
  const detached = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true });
  let closed = false;

  /**
   * Installed first thing on every upgraded socket, before any rejection path:
   * a malformed frame (possibly already in the upgrade packet) makes `ws` emit
   * `error`, and an `error` with no listener would crash the process.
   */
  function guardSocketErrors(ws: WebSocket): void {
    ws.on("error", (err) => {
      log.debug({ route: "relay", err: String(err) }, "websocket error");
    });
  }

  function attach(ws: WebSocket, profile: ProfileConfig, ip: string): void {
    if (sessions.has(profile.name)) {
      log.warn(
        { profile: profile.name, ip },
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
      descriptor: opts.descriptor,
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
    childLog.info({ ip }, "relay session connected");

    ws.on("pong", () => {
      entry.lastPong = Date.now();
    });

    ws.on("message", (data) => {
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

  function maybeWake(profileName: string): void {
    const profile = opts.getConfig().profiles.find((candidate) => candidate.name === profileName);
    if (profile === undefined) {
      return;
    }
    const url = profile.wakeUrl;
    if (url === null || url === "") {
      return;
    }
    if (sessions.has(profileName)) {
      return;
    }
    // Suppressed, not spent: a held poke leaves the cooldown untouched.
    if (opts.isHeld(profileName)) {
      return;
    }
    const now = nowSeconds();
    const last = lastWake.get(profileName);
    if (last !== undefined && now - last < opts.wakeCooldownSeconds) {
      return;
    }
    lastWake.set(profileName, now);

    void (async () => {
      try {
        const res = await doFetch(url, {
          method: "GET",
          signal: AbortSignal.timeout(WAKE_TIMEOUT_MS),
        });
        log.info({ profile: profileName, status: res.status }, "wake poke sent");
      } catch (err: unknown) {
        // Best effort by design: the buffer already holds the event.
        log.info({ profile: profileName, err: String(err) }, "wake poke failed");
      }
    })();
  }

  function detach(profileName: string, code: number, reason: string): boolean {
    const entry = sessions.get(profileName);
    if (entry === undefined) {
      return false;
    }
    sessions.delete(profileName);
    clearInterval(entry.ping);
    entry.session.close();
    closeDetached(entry.ws, code, reason);
    return true;
  }

  return {
    upgrade(req, socket, head, admission) {
      const ip = req.socket.remoteAddress ?? "unknown";
      wss.handleUpgrade(req, socket, head, (ws) => {
        guardSocketErrors(ws);
        if (!admission.ok) {
          ws.close(admission.code, admission.reason);
          return;
        }
        // Checked here, right before attaching, so no auth->attach race remains.
        // 1013 = "try again later": not 4401 (Hermes latches on it) and not 1008
        // (that reads as a duplicate session).
        if (opts.isHeld(admission.profile.name)) {
          log.info(
            { profile: admission.profile.name, ip },
            "relay reconnect refused: profile is held by management"
          );
          ws.close(1013, "profile temporarily suspended");
          return;
        }
        attach(ws, admission.profile, ip);
      });
    },

    deliver(profileName, event) {
      const profile = opts.getConfig().profiles.find((candidate) => candidate.name === profileName);
      if (profile === undefined) {
        log.warn({ profile: profileName }, "delivery for an unknown profile");
        return "unknown_profile";
      }
      let outcome: "live" | "buffered";
      const entry = sessions.get(profileName);
      if (entry !== undefined) {
        const wasLive = entry.session.canDeliverLive;
        entry.session.deliver(event);
        outcome = wasLive ? "live" : "buffered";
      } else {
        const { wasEmpty } = store.buffer.append(profileName, event, nowSeconds());
        if (wasEmpty) {
          maybeWake(profileName);
        }
        outcome = "buffered";
      }
      // After the outcome is settled; the listener is best effort.
      opts.onDelivered?.({
        profile,
        messageId: event.message_id,
        delivery: outcome,
      });
      return outcome;
    },

    isConnected(profileName) {
      return sessions.has(profileName);
    },

    detach,

    forget(profileName) {
      lastWake.delete(profileName);
      return detach(profileName, 1001, "profile deleted");
    },

    maybeWake,

    async close() {
      if (closed) {
        return;
      }
      closed = true;
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
      await new Promise<void>((resolvePromise) => {
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
    },
  };
}
