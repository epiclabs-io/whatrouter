/**
 * Who is allowed onto the relay, and what a refusal looks like on the wire.
 *
 * The gate answers two questions and nothing else: does this request carry a
 * credential for a profile that currently exists, and given that it does not,
 * how should the socket or the HTTP response say so. It holds the per-IP
 * failure throttle, which is why `prune` exists — the sweep is hourly and lives
 * with the rest of the maintenance.
 *
 * A throttled client is deliberately not told "unauthorized": Hermes reads a
 * 4401 after the handshake as a revoked credential and stops reconnecting, so
 * our own rate limit would lock a healthy gateway out for good.
 */
import type { IncomingMessage } from "node:http";
import type { Config, ProfileConfig } from "../config/schema.js";
import type { Logger } from "../util/log.js";
import { parseBearer, peekPayload, verifyToken } from "./auth.js";

export type AuthFailureReason =
  "missing_token" | "malformed" | "unknown_id" | "bad_signature" | "expired" | "throttled";

export type AuthOutcome =
  { ok: true; profile: ProfileConfig } | { ok: false; reason: AuthFailureReason };

export interface RelayGate {
  /** Records failures in the throttle. */
  authenticate(req: IncomingMessage): AuthOutcome;
  /** 1013 for a throttle, 4401 "expired"/"unauthorized" otherwise. */
  wsClose(reason: AuthFailureReason): { code: number; reason: string };
  /** 429 for a throttle, 401 otherwise. */
  httpError(reason: AuthFailureReason): { status: number; error: string };
  /** Drops IPs whose window has passed. */
  prune(nowMs: number): void;
}

export interface RelayGateOptions {
  getConfig: () => Config;
  log: Logger;
  /** Unix seconds; injectable for tests. */
  now?: () => number;
}

/** Failed attempts from one IP before the rest are told to come back later. */
const AUTH_FAIL_LIMIT = 10;
const AUTH_FAIL_WINDOW_MS = 60_000;

export function createRelayGate(opts: RelayGateOptions): RelayGate {
  const { getConfig, log } = opts;
  const nowSeconds = opts.now ?? ((): number => Math.floor(Date.now() / 1000));

  /** Per-IP sliding-ish window over authentication failures. */
  const hits = new Map<string, { count: number; windowStart: number }>();

  function isThrottled(ip: string, at: number): boolean {
    const hit = hits.get(ip);
    if (hit === undefined) {
      return false;
    }
    if (at - hit.windowStart > AUTH_FAIL_WINDOW_MS) {
      hits.delete(ip);
      return false;
    }
    return hit.count >= AUTH_FAIL_LIMIT;
  }

  /** Records the attempt against the throttle and reports it. */
  function fail(ip: string, reason: AuthFailureReason, req: IncomingMessage): AuthOutcome {
    const hit = hits.get(ip);
    if (hit === undefined || Date.now() - hit.windowStart > AUTH_FAIL_WINDOW_MS) {
      hits.set(ip, { count: 1, windowStart: Date.now() });
    } else {
      hit.count += 1;
    }
    report(ip, reason, req);
    return { ok: false, reason };
  }

  /** Never logs the token itself. */
  function report(ip: string, reason: AuthFailureReason, req: IncomingMessage): void {
    log.warn({ method: req.method, path: req.url, ip, reason }, "relay auth failure");
  }

  return {
    authenticate(req) {
      const ip = req.socket.remoteAddress ?? "unknown";
      if (isThrottled(ip, Date.now())) {
        report(ip, "throttled", req);
        return { ok: false, reason: "throttled" };
      }

      const token = parseBearer(req.headers.authorization);
      if (token === null) {
        return fail(ip, "missing_token", req);
      }

      const claimed = peekPayload(token);
      if (claimed === null) {
        return fail(ip, "malformed", req);
      }

      // Read live: a profile may have been added or removed since boot, and a
      // gateway that just appeared should not have to wait for a restart.
      const profile = getConfig().profiles.find((candidate) => candidate.gatewayId === claimed);
      if (profile === undefined) {
        return fail(ip, "unknown_id", req);
      }

      const verified = verifyToken(token, profile.secret, nowSeconds());
      if (!verified.ok) {
        return fail(ip, verified.reason, req);
      }
      return { ok: true, profile };
    },

    wsClose(reason) {
      if (reason === "throttled") {
        // 1013, not 4401: a gateway latches a repeated 4401 as revocation and
        // stops reconnecting, so being briefly throttled would lock out a
        // healthy gateway for good. 1013 means "come back", which is the truth.
        return { code: 1013, reason: "try again later" };
      }
      return { code: 4401, reason: reason === "expired" ? "expired" : "unauthorized" };
    },

    httpError(reason) {
      if (reason === "throttled") {
        return { status: 429, error: "too many failed attempts" };
      }
      return { status: 401, error: reason === "expired" ? "expired" : "unauthorized" };
    },

    prune(at) {
      for (const [ip, hit] of hits) {
        if (at - hit.windowStart > AUTH_FAIL_WINDOW_MS) {
          hits.delete(ip);
        }
      }
    },
  };
}
