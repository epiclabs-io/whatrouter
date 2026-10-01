/**
 * Management wire contract (`GET /management`). Deliberately separate from
 * `relay/frames.ts`, which is the Hermes contract and must not change.
 *
 * NDJSON over WebSocket text messages: every frame is one JSON object followed
 * by `\n`; a frame may be split across, or share, WebSocket messages.
 *
 *   client -> server  {"type":"subscribe","requestId":"…","events":["message_pending"]}
 *                     {"type":"close_profile","requestId":"…","profile":"work"}
 *                     {"type":"release_profile","requestId":"…","profile":"work"}
 *   server -> client  {"type":"result","requestId":"…","result":{"success":…}}
 *                     {"type":"event","event":"message_pending","data":{…}}
 *
 * Parsing is strict. A line that is not a JSON object with a usable
 * `requestId` cannot be answered and is fatal to the connection; anything
 * else that is wrong gets a correlated `{success:false}` result. Error strings
 * are fixed: arbitrary client input is never reflected back.
 */

export const MANAGEMENT_EVENTS = ["message_pending"] as const;
export type ManagementEventName = (typeof MANAGEMENT_EVENTS)[number];

export const MAX_REQUEST_ID_LENGTH = 128;
const MAX_SUBSCRIBE_EVENTS = 16;

// ------------------------------------------------------------------ requests

export interface SubscribeRequest {
  type: "subscribe";
  requestId: string;
  /** Deduplicated, in first-seen order. */
  events: ManagementEventName[];
}

export interface CloseProfileRequest {
  type: "close_profile";
  requestId: string;
  profile: string;
}

export interface ReleaseProfileRequest {
  type: "release_profile";
  requestId: string;
  profile: string;
}

export type ManagementRequest = SubscribeRequest | CloseProfileRequest | ReleaseProfileRequest;

export type ParseOutcome =
  | { kind: "ok"; request: ManagementRequest }
  /** Answerable: reply with `{success:false, error}` under `requestId`. */
  | { kind: "error"; requestId: string; error: string }
  /** Unanswerable: close the connection with 1008. */
  | { kind: "fatal" };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(obj: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(obj).every((key) => allowed.includes(key));
}

function isSupportedEvent(value: unknown): value is ManagementEventName {
  return typeof value === "string" && (MANAGEMENT_EVENTS as readonly string[]).includes(value);
}

/** Parses one assembled line. Never throws. */
export function parseManagementRequest(line: string): ParseOutcome {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { kind: "fatal" };
  }
  if (!isPlainObject(value)) {
    return { kind: "fatal" };
  }
  const { requestId } = value;
  if (
    typeof requestId !== "string" ||
    requestId.length === 0 ||
    requestId.length > MAX_REQUEST_ID_LENGTH
  ) {
    return { kind: "fatal" };
  }
  const fail = (error: string): ParseOutcome => ({ kind: "error", requestId, error });

  switch (value.type) {
    case "subscribe": {
      if (!hasOnlyKeys(value, ["type", "requestId", "events"])) {
        return fail("unexpected field");
      }
      const { events } = value;
      if (!Array.isArray(events) || events.length > MAX_SUBSCRIBE_EVENTS) {
        return fail("events must be an array of event names");
      }
      const wanted: ManagementEventName[] = [];
      for (const event of events) {
        if (!isSupportedEvent(event)) {
          return fail("unsupported event");
        }
        if (!wanted.includes(event)) {
          wanted.push(event);
        }
      }
      return { kind: "ok", request: { type: "subscribe", requestId, events: wanted } };
    }
    case "close_profile": {
      if (!hasOnlyKeys(value, ["type", "requestId", "profile"])) {
        return fail("unexpected field");
      }
      const { profile } = value;
      // No length cap beyond the frame limit: any configured name must be addressable.
      if (typeof profile !== "string" || profile.length === 0) {
        return fail("profile must be a non-empty string");
      }
      return { kind: "ok", request: { type: "close_profile", requestId, profile } };
    }
    case "release_profile": {
      if (!hasOnlyKeys(value, ["type", "requestId", "profile"])) {
        return fail("unexpected field");
      }
      const { profile } = value;
      if (typeof profile !== "string" || profile.length === 0) {
        return fail("profile must be a non-empty string");
      }
      return { kind: "ok", request: { type: "release_profile", requestId, profile } };
    }
    default:
      return fail("unsupported request type");
  }
}

// ------------------------------------------------------------------- results

export interface PendingProfile {
  profile: string;
  gatewayId: string;
  bufferedCount: number;
}

export interface SubscribeResult {
  success: true;
  events: ManagementEventName[];
  /** Every configured profile with a non-empty durable buffer right now. */
  pending: PendingProfile[];
}

export interface CloseProfileResult {
  success: true;
  profile: string;
  wasConnected: boolean;
  /** Epoch milliseconds; relay reconnects are refused before this instant. */
  blockedUntilMs: number;
  retryAfterMs: number;
}

export interface ReleaseProfileResult {
  success: true;
  profile: string;
  /** Whether an active reconnect hold was cancelled by this request. */
  wasHeld: boolean;
}

export interface FailureResult {
  success: false;
  error: string;
}

export type ManagementResult =
  SubscribeResult | CloseProfileResult | ReleaseProfileResult | FailureResult;

export interface ResultFrame {
  type: "result";
  requestId: string;
  result: ManagementResult;
}

// -------------------------------------------------------------------- events

export interface MessagePendingData {
  profile: string;
  gatewayId: string;
  /** WhatsApp message id; never text, sender, chat or media. */
  messageId: string;
  delivery: "live" | "buffered";
}

export interface MessagePendingEvent {
  type: "event";
  event: "message_pending";
  data: MessagePendingData;
}

export type ManagementServerFrame = ResultFrame | MessagePendingEvent;

/** JSON + a mandatory trailing newline. */
export function encodeManagementFrame(frame: ManagementServerFrame): string {
  return `${JSON.stringify(frame)}\n`;
}
