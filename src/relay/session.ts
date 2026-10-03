/**
 * Per-profile relay session: a pure state machine over the NDJSON frames.
 * No sockets, no timers, no I/O beyond the store - the server owns the
 * WebSocket and hands frames in and gets frames out, making the delivery
 * semantics unit-testable.
 *
 * A new session buffers until `hello` arrives and the durable buffer has
 * drained or been confirmed empty. The pump sends the oldest unacknowledged row
 * with a `bufferId`, waits for its matching `inbound_ack`, deletes it, and
 * repeats. Once drained, new events are delivered live while no row is awaiting
 * acknowledgement. `going_idle` disables live delivery for the rest of that
 * session; a reconnect creates a fresh session that drains the durable buffer.
 */
import type { Logger } from "../util/log.js";
import type { Store } from "../store/db.js";
import type {
  CapabilityDescriptor,
  ConnectorFrame,
  GatewayFrame,
  OutboundAction,
  OutboundFrame,
  OutboundResult,
  RelayEvent,
} from "./frames.js";

export interface SessionDeps {
  profile: string;
  store: Store;
  descriptor: CapabilityDescriptor;
  send: (frame: ConnectorFrame) => void;
  execute: (action: OutboundAction, platform: string | undefined) => Promise<OutboundResult>;
  log: Logger;
  onIdentity?: (platform: string, botId: string) => void;
}

/** Platforms a `hello` may legitimately claim; anything else is only a warning. */
const KNOWN_PLATFORMS = new Set(["whatsapp", "relay"]);

export class Session {
  readonly #deps: SessionDeps;
  #helloed = false;
  #idleFlipped = false;
  #liveOk = false;
  #pending: number | null = null;
  #closed = false;
  readonly #inflight = new Set<Promise<void>>();

  constructor(deps: SessionDeps) {
    this.#deps = deps;
  }

  /** A `hello` has been seen, so frames may flow. */
  get helloed(): boolean {
    return this.#helloed;
  }

  /** The gateway said `going_idle` on this connection. */
  get idleFlipped(): boolean {
    return this.#idleFlipped;
  }

  /** The buffer has drained at least once, so live delivery is allowed. */
  get liveOk(): boolean {
    return this.#liveOk;
  }

  /** The `bufferId` we are waiting an ack for, if any. */
  get pending(): number | null {
    return this.#pending;
  }

  /** Whether `deliver` would go straight out instead of buffering. */
  get canDeliverLive(): boolean {
    return this.#liveOk && !this.#idleFlipped && this.#pending === null;
  }

  /** Number of outbound actions still executing. */
  get inflight(): number {
    return this.#inflight.size;
  }

  async handleFrame(frame: GatewayFrame): Promise<void> {
    if (this.#closed) {
      return;
    }
    switch (frame.type) {
      case "hello":
        this.#onHello(frame.platform, frame.botId);
        return;
      case "inbound_ack":
        this.#onAck(frame.bufferId);
        return;
      case "going_idle":
        this.#onGoingIdle();
        return;
      case "outbound":
        // Deliberately not awaited: a slow send must not stall the frame loop
        // (acks and further outbounds keep flowing while it runs).
        this.#startOutbound(frame);
        return;
      case "interrupt":
        this.#deps.log.info(
          { profile: this.#deps.profile, sessionKey: frame.session_key, reason: frame.reason },
          "relay interrupt (no connector-side turns to cancel)"
        );
        return;
      default:
        // Unknown frame types are ignored by contract (additive-only evolution).
        this.#deps.log.debug({ profile: this.#deps.profile }, "ignoring unknown relay frame");
    }
  }

  /**
   * Hand an inbound event to the gateway: live when allowed, otherwise durably
   * buffered. Never throws and never drops.
   */
  deliver(event: RelayEvent): void {
    if (this.#closed) {
      this.#deps.store.buffer.append(this.#deps.profile, event);
      return;
    }
    if (this.canDeliverLive) {
      this.#deps.send({ type: "inbound", event });
      return;
    }
    this.#deps.store.buffer.append(this.#deps.profile, event);
    this.#pump();
  }

  /** Stops emitting frames (the socket went away). Buffer state stays durable. */
  close(): void {
    this.#closed = true;
  }

  /** Resolves once every in-flight outbound action has answered (tests). */
  async settled(): Promise<void> {
    while (this.#inflight.size > 0) {
      await Promise.all([...this.#inflight]);
    }
  }

  // ------------------------------------------------------------------ internals

  #onHello(platform: string, botId: string | undefined): void {
    if (!KNOWN_PLATFORMS.has(platform)) {
      this.#deps.log.warn(
        { profile: this.#deps.profile, platform },
        "hello for an unexpected platform; answering with the WhatsApp descriptor anyway"
      );
    }
    this.#deps.onIdentity?.(platform, botId ?? "");
    // One descriptor per hello: the gateway sends one hello per fronted identity.
    this.#deps.send({ type: "descriptor", descriptor: this.#deps.descriptor });
    const first = !this.#helloed;
    this.#helloed = true;
    if (first) {
      this.#pump();
    }
  }

  #onAck(bufferId: string): void {
    if (this.#pending === null || bufferId !== String(this.#pending)) {
      this.#deps.log.debug(
        { profile: this.#deps.profile, bufferId, pending: this.#pending },
        "ignoring inbound_ack that does not match the in-flight bufferId"
      );
      return;
    }
    this.#deps.store.buffer.ack(this.#deps.profile, this.#pending);
    this.#pending = null;
    this.#pump();
  }

  #onGoingIdle(): void {
    // In memory only, and never cleared: this session does not deliver live
    // again. The next handshake builds a new Session, which starts the same way.
    this.#idleFlipped = true;
    this.#liveOk = false;
    this.#deps.send({ type: "going_idle_ack" });
  }

  #startOutbound(frame: OutboundFrame): void {
    const { requestId, action, platform } = frame;
    const run = async (): Promise<OutboundResult> => {
      if (platform !== undefined && platform !== "" && platform !== "whatsapp") {
        return { success: false, error: "platform not fronted" };
      }
      return this.#deps.execute(action, platform);
    };

    const task = (async (): Promise<void> => {
      let result: OutboundResult;
      try {
        result = await run();
      } catch (err: unknown) {
        // An adapter that throws must still produce a result frame, or the
        // gateway waits for its requestId forever.
        const message = err instanceof Error ? err.message : String(err);
        this.#deps.log.error(
          { profile: this.#deps.profile, requestId, op: action.op, err: message },
          "outbound action threw"
        );
        result = { success: false, error: message };
      }
      if (this.#closed) {
        return;
      }
      try {
        this.#deps.send({ type: "outbound_result", requestId, result });
      } catch (err: unknown) {
        this.#deps.log.warn(
          { profile: this.#deps.profile, requestId, err: String(err) },
          "could not send outbound_result"
        );
      }
    })();

    this.#inflight.add(task);
    void task.finally(() => this.#inflight.delete(task));
  }

  #pump(): void {
    if (this.#closed) {
      return;
    }
    // Loops because an append can race the "buffer is empty" check below.
    for (;;) {
      if (!this.#helloed || this.#idleFlipped || this.#pending !== null) {
        return;
      }
      const next = this.#deps.store.buffer.nextUnacked(this.#deps.profile);
      if (next !== null) {
        this.#pending = next.seq;
        this.#deps.send({ type: "inbound", event: next.event, bufferId: String(next.seq) });
        return;
      }
      if (this.#deps.store.buffer.count(this.#deps.profile) === 0) {
        this.#liveOk = true;
        return;
      }
    }
  }
}
