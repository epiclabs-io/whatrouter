/**
 * Reconnect holds: the window after `close_profile` during which a profile's
 * relay socket is refused.
 *
 * The hold is a timer and a predicate, and it is the only place the relay and
 * management meet. The hub is handed an `isHeld` predicate and holds is handed
 * the hub's `detach`/`isConnected`/`maybeWake`, so neither imports the other and
 * `serve.ts` can wire the two together without either knowing about a cycle.
 *
 * `closeProfile` is synchronous by contract. Management suspends the agent on the
 * result, so by the time it returns, live delivery for that profile has to be
 * off and the reconnect has to be refused — a hold armed after the socket closes
 * would leave a window where both were still true.
 */
import type { Config } from "../config/schema.js";
import type { CloseProfileResult, FailureResult, ReleaseProfileResult } from "./frames.js";
import type { RelayHub } from "../relay/hub.js";
import type { Logger } from "../util/log.js";

/** Minimum time `close_profile` keeps a profile's relay reconnects refused. */
export const HOLD_MS = 20_000;

export interface Holds {
  isHeld(profileName: string): boolean;
  /** For `/healthz`; null when not held. */
  blockedUntilMs(profileName: string): number | null;
  closeProfile(profileName: string): CloseProfileResult | FailureResult;
  releaseProfile(profileName: string): ReleaseProfileResult | FailureResult;
  /** Profile deleted: cancel any hold silently. */
  forget(profileName: string): void;
  /** Shutdown: cancel every timer. */
  close(): void;
}

export interface HoldsOptions {
  getConfig: () => Config;
  hub: Pick<RelayHub, "detach" | "isConnected" | "maybeWake">;
  bufferedCount: (profileName: string) => number;
  log: Logger;
  nowMs?: () => number;
  scheduleHoldExpiry?: (fn: () => void, delayMs: number) => () => void;
}

interface Hold {
  untilMs: number;
  cancel: () => void;
}

function defaultSchedule(fn: () => void, delayMs: number): () => void {
  const timer = setTimeout(fn, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

export function createHolds(opts: HoldsOptions): Holds {
  const { getConfig, hub, log } = opts;
  const nowMs = opts.nowMs ?? Date.now;
  const scheduleHoldExpiry = opts.scheduleHoldExpiry ?? defaultSchedule;
  const holds = new Map<string, Hold>();
  let closed = false;

  function liveHold(profileName: string): Hold | undefined {
    const hold = holds.get(profileName);
    return hold !== undefined && nowMs() < hold.untilMs ? hold : undefined;
  }

  function isHeld(profileName: string): boolean {
    return liveHold(profileName) !== undefined;
  }

  /** Arms (or re-arms) the expiry check for `profile`'s current hold. */
  function armHoldExpiry(profileName: string, hold: Hold): void {
    hold.cancel = scheduleHoldExpiry(
      () => {
        if (closed || holds.get(profileName) !== hold) {
          return; // replaced by a newer close_profile, or shutting down
        }
        if (nowMs() < hold.untilMs) {
          armHoldExpiry(profileName, hold); // the timer fired early
          return;
        }
        holds.delete(profileName);
        // `wasEmpty` will not fire again for a buffer that is already non-empty,
        // so this is the one chance to wake an agent that has work waiting.
        if (!hub.isConnected(profileName) && opts.bufferedCount(profileName) > 0) {
          hub.maybeWake(profileName);
        }
      },
      Math.max(0, hold.untilMs - nowMs())
    );
  }

  return {
    isHeld,

    blockedUntilMs(profileName) {
      return liveHold(profileName)?.untilMs ?? null;
    },

    closeProfile(profileName) {
      const profile = getConfig().profiles.find((candidate) => candidate.name === profileName);
      if (profile === undefined) {
        return { success: false, error: "unknown profile" };
      }

      // 1. Hold first, so a reconnect racing this call is already refused.
      const untilMs = nowMs() + HOLD_MS;
      holds.get(profileName)?.cancel();
      const hold: Hold = { untilMs, cancel: () => undefined };
      holds.set(profileName, hold);
      armHoldExpiry(profileName, hold);

      // 2. Detach now; the socket's own close handler keeps its identity guard.
      const wasConnected = hub.detach(profileName, 1001, "closed by management");
      log.info(
        { profile: profileName, wasConnected, blockedUntilMs: untilMs },
        "relay session closed by management"
      );
      return {
        success: true,
        profile: profileName,
        wasConnected,
        blockedUntilMs: untilMs,
        retryAfterMs: HOLD_MS,
      };
    },

    releaseProfile(profileName) {
      const profile = getConfig().profiles.find((candidate) => candidate.name === profileName);
      if (profile === undefined) {
        return { success: false, error: "unknown profile" };
      }

      const hold = holds.get(profileName);
      const wasHeld = isHeld(profileName);
      if (hold !== undefined) {
        hold.cancel();
        holds.delete(profileName);
      }
      log.info({ profile: profileName, wasHeld }, "relay reconnect hold released by management");
      return { success: true, profile: profileName, wasHeld };
    },

    forget(profileName) {
      holds.get(profileName)?.cancel();
      holds.delete(profileName);
    },

    close() {
      closed = true;
      for (const hold of holds.values()) {
        hold.cancel();
      }
      holds.clear();
    },
  };
}
