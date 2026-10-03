/**
 * Relay bearer tokens — a port of Hermes `gateway/relay/auth.py` (and the Rust
 * connector's `auth.rs`). The gateway mints them, we only verify.
 *
 *   token = base64url_nopad("{payload}:{exp}:{sig}")
 *   sig   = hex(HMAC_SHA256(key=secret, msg="{payload}:{exp}"))
 *   exp   = unix seconds, 0 = never expires
 *
 * `payload` is the `gateway_id` and may itself contain colons, so the decoded
 * string is split **from the right**. Decoding tolerates `=` padding: some
 * clients add it back.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export type VerifyFailureReason = "malformed" | "expired" | "bad_signature";

export type VerifyResult =
  { ok: true; payload: string; exp: number } | { ok: false; reason: VerifyFailureReason };

/** Hex HMAC-SHA256 of `payload` under `secret`. */
export function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

interface ParsedToken {
  payload: string;
  exp: number;
  /** Exactly the bytes the signature covers: `"{payload}:{exp}"` as written. */
  signed: string;
  sig: string;
}

const INTEGER_RE = /^[+-]?\d+$/;

function parseToken(token: string): ParsedToken | null {
  if (typeof token !== "string" || token.length === 0) {
    return null;
  }
  let decoded: string;
  try {
    // `base64url` also accepts the padded and standard-alphabet forms.
    decoded = Buffer.from(token.trim(), "base64url").toString("utf8");
  } catch {
    return null;
  }
  const sigAt = decoded.lastIndexOf(":");
  if (sigAt < 0) {
    return null;
  }
  const expAt = decoded.lastIndexOf(":", sigAt - 1);
  if (expAt < 0) {
    return null;
  } // fewer than 3 colon-separated parts

  const payload = decoded.slice(0, expAt);
  const expRaw = decoded.slice(expAt + 1, sigAt);
  const sig = decoded.slice(sigAt + 1);
  if (!INTEGER_RE.test(expRaw)) {
    return null;
  }
  const exp = Number.parseInt(expRaw, 10);
  if (!Number.isFinite(exp)) {
    return null;
  }
  return { payload, exp, signed: decoded.slice(0, sigAt), sig };
}

/**
 * The claimed gateway id, without verifying anything — the server needs it to
 * pick the profile (and therefore the secret) to verify against.
 */
export function peekPayload(token: string): string | null {
  return parseToken(token)?.payload ?? null;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // timingSafeEqual throws on a length mismatch; the length of a hex digest is
  // not a secret, so comparing it up front is fine.
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * Full verification. A bad signature is never reported as `expired` (that would
 * tell an attacker their guess was otherwise well-formed), so the signature is
 * checked before the clock.
 */
export function verifyToken(
  token: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): VerifyResult {
  const parsed = parseToken(token);
  if (parsed === null) {
    return { ok: false, reason: "malformed" };
  }
  if (!constantTimeEquals(parsed.sig, sign(parsed.signed, secret))) {
    return { ok: false, reason: "bad_signature" };
  }
  if (parsed.exp !== 0 && nowSeconds > parsed.exp) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, payload: parsed.payload, exp: parsed.exp };
}

/** `Authorization: Bearer <token>` -> `<token>`; anything else -> null. */
export function parseBearer(headerValue: string | string[] | undefined | null): string | null {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  const space = trimmed.indexOf(" ");
  if (space < 0) {
    return null;
  }
  if (trimmed.slice(0, space).toLowerCase() !== "bearer") {
    return null;
  }
  const token = trimmed.slice(space + 1).trim();
  return token === "" ? null : token;
}
