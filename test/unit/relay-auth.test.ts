import { describe, expect, it } from "vitest";
import { makeToken, parseBearer, peekPayload, sign, verifyToken } from "../../src/relay/auth.js";

// Vectors generated from the real Hermes `gateway/relay/auth.py` at time.time() = NOW.
const NOW = 1754700000;
const VEC_SIMPLE =
  "Z3ctdGVzdDoxNzU0NzAwMzAwOjQ0OGNlNjE1NjY2MzU0MGM3YzY5NjZhMzRjZGJkMWMzNDAwOGNjMDU2OGEyODgzMWJiZjZjMjkxZWRmOWU5ZDA";
const VEC_COLONS =
  "Z3c6d2l0aDpjb2xvbnM6MDpkOWEyNGQyNThmNDM1YjQ1ZTJhOWM1MDNmNzBmODY2M2ZjYzNhNzAyOWYzNDc3ZmZhZjkxZTJkZDY4OTRjNWUz";

describe("sign", () => {
  it("matches the Python HMAC-SHA256 vector", () => {
    expect(sign("abc", "key")).toBe(
      "9c196e32dc0175f86f4b1cb89289d6619de6bee699e4c378e68309ed97a1a6ab"
    );
  });
});

describe("makeToken", () => {
  it("matches the TTL vector", () => {
    expect(makeToken("gw-test", "topsecret", 300, NOW)).toBe(VEC_SIMPLE);
  });

  it("matches the never-expires vector with colons in the payload", () => {
    expect(makeToken("gw:with:colons", "s2", 0, NOW)).toBe(VEC_COLONS);
  });

  it("is base64url without padding", () => {
    const token = makeToken("gw-test", "topsecret", 300, NOW);
    expect(token).not.toContain("=");
    expect(token).not.toContain("+");
    expect(token).not.toContain("/");
  });
});

describe("peekPayload", () => {
  it("splits from the right so colons survive in the gateway id", () => {
    expect(peekPayload(VEC_COLONS)).toBe("gw:with:colons");
    expect(peekPayload(VEC_SIMPLE)).toBe("gw-test");
  });

  it("returns null for garbage and for too few parts", () => {
    expect(peekPayload("")).toBeNull();
    expect(peekPayload("not-a-token!!")).toBeNull();
    expect(peekPayload(Buffer.from("only:two", "utf8").toString("base64url"))).toBeNull();
    expect(peekPayload(Buffer.from("noseparators", "utf8").toString("base64url"))).toBeNull();
  });

  it("rejects a non-integer exp", () => {
    const bad = Buffer.from("gw:notanumber:deadbeef", "utf8").toString("base64url");
    expect(peekPayload(bad)).toBeNull();
  });
});

describe("verifyToken", () => {
  it("accepts a fresh token at mint time", () => {
    const result = verifyToken(VEC_SIMPLE, "topsecret", NOW);
    expect(result).toEqual({ ok: true, payload: "gw-test", exp: 1754700300 });
  });

  it("reports expired one second past the TTL", () => {
    expect(verifyToken(VEC_SIMPLE, "topsecret", NOW + 301)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("treats exp=0 as never expiring", () => {
    expect(verifyToken(VEC_COLONS, "s2", NOW + 999_999_999)).toEqual({
      ok: true,
      payload: "gw:with:colons",
      exp: 0,
    });
  });

  it("accepts a padded token", () => {
    expect(verifyToken(`${VEC_SIMPLE}=`, "topsecret", NOW).ok).toBe(true);
  });

  it('reports bad_signature for the wrong secret (never "expired")', () => {
    expect(verifyToken(VEC_SIMPLE, "not-the-secret", NOW)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    // An expired token signed with the wrong secret must not leak that it expired.
    expect(verifyToken(VEC_SIMPLE, "not-the-secret", NOW + 10_000)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("reports malformed for garbage and short tokens", () => {
    expect(verifyToken("", "topsecret", NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyToken("!!!!", "topsecret", NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(
      verifyToken(Buffer.from("gw:1754700300", "utf8").toString("base64url"), "topsecret", NOW)
    ).toEqual({ ok: false, reason: "malformed" });
  });

  it("round-trips freshly minted tokens", () => {
    const token = makeToken("gw:work:1", "a".repeat(40), 300, NOW);
    expect(verifyToken(token, "a".repeat(40), NOW + 299)).toEqual({
      ok: true,
      payload: "gw:work:1",
      exp: NOW + 300,
    });
    expect(verifyToken(token, "a".repeat(40), NOW + 301).ok).toBe(false);
  });
});

describe("parseBearer", () => {
  it("extracts the token case-insensitively", () => {
    expect(parseBearer("Bearer abc.def")).toBe("abc.def");
    expect(parseBearer("bearer   abc")).toBe("abc");
    expect(parseBearer(["Bearer xyz"])).toBe("xyz");
  });

  it("returns null for anything else", () => {
    expect(parseBearer(undefined)).toBeNull();
    expect(parseBearer(null)).toBeNull();
    expect(parseBearer("")).toBeNull();
    expect(parseBearer("Basic abc")).toBeNull();
    expect(parseBearer("Bearer")).toBeNull();
    expect(parseBearer("Bearer   ")).toBeNull();
  });
});
