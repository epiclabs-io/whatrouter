/**
 * The single management connection behind `GET /management`. Owns its own
 * framing, subscription and heartbeat; knows nothing about relay sessions
 * beyond the callbacks the relay server hands it.
 *
 * Guarantees:
 *   - at most one connection; a second authenticated one is closed 1008
 *   - no event before a successful `subscribe` result has been written
 *   - events are best effort: `publish` never throws, never blocks, and a
 *     client that falls behind by more than `maxBufferedBytes` is closed 1013
 *     instead of growing memory
 *   - nothing the client sends is ever echoed into results or logs
 */
import type { RawData, WebSocket } from "ws";
import type { Logger } from "../util/log.js";
import { LineAssembler } from "../relay/ndjson.js";
import {
  encodeManagementFrame,
  parseManagementRequest,
  type CloseProfileResult,
  type FailureResult,
  type ManagementEventName,
  type ManagementRequest,
  type ManagementResult,
  type ManagementServerFrame,
  type MessagePendingData,
  type PendingProfile,
  type ReleaseProfileResult,
} from "./frames.js";

/** Largest single NDJSON frame (assembled line), in UTF-8 bytes. */
export const MANAGEMENT_MAX_LINE_BYTES = 64 * 1024;
/** Largest single WebSocket message, which may coalesce several frames. */
export const MANAGEMENT_MAX_MESSAGE_BYTES = 1024 * 1024;
const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 60_000;

export interface ManagementEndpointOptions {
  log: Logger;
  /** Snapshot for `subscribe`: every profile whose durable buffer is non-empty. */
  pending: () => PendingProfile[];
  /** Detaches the profile's relay session and starts/resets its hold. */
  closeProfile: (profile: string) => CloseProfileResult | FailureResult;
  /** Cancels the profile's reconnect hold without waking or reconnecting it. */
  releaseProfile: (profile: string) => ReleaseProfileResult | FailureResult;
  /** Outgoing bytes the client may leave unread before it is closed 1013. */
  maxBufferedBytes?: number;
}

interface Connection {
  ws: WebSocket;
  assembler: LineAssembler;
  events: ReadonlySet<ManagementEventName>;
  ping: NodeJS.Timeout;
  lastPong: number;
  /** Set once we have decided to close; nothing more is read or written. */
  closing: boolean;
}

function rawToString(data: RawData): string {
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

export class ManagementEndpoint {
  readonly #opts: ManagementEndpointOptions;
  readonly #maxBuffered: number;
  #conn: Connection | null = null;
  #shutDown = false;

  constructor(opts: ManagementEndpointOptions) {
    this.#opts = opts;
    this.#maxBuffered = opts.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  }

  /** Whether a management client is currently attached. */
  get connected(): boolean {
    return this.#conn !== null;
  }

  /** Takes over an already-authenticated socket. */
  attach(ws: WebSocket, ip: string): void {
    const { log } = this.#opts;
    if (this.#shutDown) {
      ws.close(1001, "going away");
      return;
    }
    if (this.#conn !== null) {
      log.warn({ ip }, "second management connection; closing the new one");
      ws.close(1008, "duplicate management session");
      return;
    }

    const ping = setInterval(() => {
      if (Date.now() - conn.lastPong > PONG_TIMEOUT_MS) {
        log.warn("no pong within 60s; terminating the management socket");
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

    const conn: Connection = {
      ws,
      // Preserve whitespace until after the per-frame byte limit is checked.
      assembler: new LineAssembler(false),
      events: new Set(),
      ping,
      lastPong: Date.now(),
      closing: false,
    };
    this.#conn = conn;
    log.info({ ip }, "management client connected");

    ws.on("pong", () => {
      conn.lastPong = Date.now();
    });
    ws.on("message", (data: RawData, isBinary: boolean) => {
      this.#onMessage(conn, data, isBinary);
    });
    ws.on("error", (err) => {
      log.warn({ err: String(err) }, "management socket error");
    });
    ws.on("close", (code, reasonBuf) => {
      clearInterval(ping);
      conn.closing = true;
      if (this.#conn === conn) {
        this.#conn = null;
      }
      log.info({ code, reason: reasonBuf.toString() }, "management client disconnected");
    });
  }

  /** Best effort, never throws: inbound delivery must not depend on it. */
  publish(data: MessagePendingData): void {
    try {
      const conn = this.#conn;
      if (conn === null || !conn.events.has("message_pending")) {
        return;
      }
      this.#send(conn, { type: "event", event: "message_pending", data });
    } catch (err: unknown) {
      this.#opts.log.warn({ err: String(err) }, "could not publish a management event");
    }
  }

  /** Server shutdown: `1001 going away`; the caller bounds the close handshake. */
  close(): void {
    this.#shutDown = true;
    const conn = this.#conn;
    if (conn === null) {
      return;
    }
    clearInterval(conn.ping);
    this.#reject(conn, 1001, "going away");
  }

  // ------------------------------------------------------------------ internals

  #onMessage(conn: Connection, data: RawData, isBinary: boolean): void {
    if (conn.closing) {
      return;
    }
    if (isBinary) {
      this.#opts.log.warn("binary management message; closing");
      this.#reject(conn, 1003, "text frames only");
      return;
    }
    const lines = conn.assembler.push(rawToString(data));
    // A line that never ends must not grow without bound across messages.
    if (Buffer.byteLength(conn.assembler.pending, "utf8") > MANAGEMENT_MAX_LINE_BYTES) {
      this.#opts.log.warn("management frame exceeds the size limit; closing");
      this.#reject(conn, 1009, "management frame too large");
      return;
    }
    for (const line of lines) {
      if (conn.closing) {
        return;
      }
      if (Buffer.byteLength(line, "utf8") > MANAGEMENT_MAX_LINE_BYTES) {
        this.#opts.log.warn("management frame exceeds the size limit; closing");
        this.#reject(conn, 1009, "management frame too large");
        return;
      }
      const parsed = parseManagementRequest(line);
      if (parsed.kind === "fatal") {
        this.#opts.log.warn("invalid management frame; closing");
        this.#reject(conn, 1008, "invalid management frame");
        return;
      }
      if (parsed.kind === "error") {
        this.#result(conn, parsed.requestId, { success: false, error: parsed.error });
        continue;
      }
      this.#handle(conn, parsed.request);
    }
  }

  #handle(conn: Connection, request: ManagementRequest): void {
    const { log } = this.#opts;
    switch (request.type) {
      case "subscribe": {
        let pending: PendingProfile[];
        try {
          pending = this.#opts.pending();
        } catch (err: unknown) {
          log.error({ err: String(err) }, "management subscribe snapshot failed");
          this.#result(conn, request.requestId, { success: false, error: "internal error" });
          return;
        }
        // Result first, then enable publication: events can never precede it.
        this.#result(conn, request.requestId, {
          success: true,
          events: request.events,
          pending,
        });
        conn.events = new Set(request.events);
        log.info({ events: request.events }, "management subscription set");
        return;
      }
      case "close_profile": {
        let result: CloseProfileResult | FailureResult;
        try {
          result = this.#opts.closeProfile(request.profile);
        } catch (err: unknown) {
          log.error({ err: String(err) }, "management close_profile failed");
          result = { success: false, error: "internal error" };
        }
        this.#result(conn, request.requestId, result);
        return;
      }
      case "release_profile": {
        let result: ReleaseProfileResult | FailureResult;
        try {
          result = this.#opts.releaseProfile(request.profile);
        } catch (err: unknown) {
          log.error({ err: String(err) }, "management release_profile failed");
          result = { success: false, error: "internal error" };
        }
        this.#result(conn, request.requestId, result);
        return;
      }
    }
  }

  #result(conn: Connection, requestId: string, result: ManagementResult): void {
    this.#send(conn, { type: "result", requestId, result });
  }

  #send(conn: Connection, frame: ManagementServerFrame): void {
    const { ws } = conn;
    if (conn.closing || ws.readyState !== ws.OPEN) {
      return;
    }
    // Bound what this frame would leave queued, not what was queued before it:
    // otherwise one large frame could sit past the limit indefinitely.
    const encoded = encodeManagementFrame(frame);
    const queued = ws.bufferedAmount + Buffer.byteLength(encoded, "utf8");
    if (queued > this.#maxBuffered) {
      this.#opts.log.warn(
        { bufferedAmount: ws.bufferedAmount, frameBytes: queued - ws.bufferedAmount },
        "management client is not reading; closing"
      );
      this.#reject(conn, 1013, "management client too slow");
      return;
    }
    try {
      ws.send(encoded);
    } catch (err: unknown) {
      this.#opts.log.warn({ err: String(err) }, "management send failed; closing");
      conn.closing = true;
      ws.terminate();
    }
  }

  #reject(conn: Connection, code: number, reason: string): void {
    conn.closing = true;
    try {
      conn.ws.close(code, reason);
    } catch {
      conn.ws.terminate();
    }
  }
}
