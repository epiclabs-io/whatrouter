/**
 * Management auth is a static bearer secret — intentionally *not* the Hermes
 * HMAC token format in `relay/auth.ts`, and never satisfied by a profile secret.
 */
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time equality. Both sides are hashed first so neither the content
 * nor the length of the configured secret leaks through timing.
 */
export function secretMatches(supplied: string, expected: string): boolean {
  const left = createHash("sha256").update(supplied, "utf8").digest();
  const right = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(left, right);
}
