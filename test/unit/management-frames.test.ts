import { describe, expect, it } from "vitest";
import {
  encodeManagementFrame,
  MAX_REQUEST_ID_LENGTH,
  parseManagementRequest,
} from "../../src/management/frames.js";
import { secretMatches } from "../../src/management/auth.js";

const line = (value: unknown): string => JSON.stringify(value);

describe("parseManagementRequest", () => {
  it("parses subscribe, deduplicating events", () => {
    expect(
      parseManagementRequest(
        line({ type: "subscribe", requestId: "s1", events: ["message_pending", "message_pending"] })
      )
    ).toEqual({
      kind: "ok",
      request: { type: "subscribe", requestId: "s1", events: ["message_pending"] },
    });
    expect(
      parseManagementRequest(line({ type: "subscribe", requestId: "s2", events: [] }))
    ).toEqual({ kind: "ok", request: { type: "subscribe", requestId: "s2", events: [] } });
  });

  it("accepts any non-empty profile name, however long", () => {
    const profile = "p".repeat(1000);
    expect(
      parseManagementRequest(line({ type: "close_profile", requestId: "c", profile }))
    ).toEqual({ kind: "ok", request: { type: "close_profile", requestId: "c", profile } });
  });

  it("parses close_profile", () => {
    expect(
      parseManagementRequest(line({ type: "close_profile", requestId: "c1", profile: "work" }))
    ).toEqual({
      kind: "ok",
      request: { type: "close_profile", requestId: "c1", profile: "work" },
    });
  });

  it("answers bad fields under the request id without echoing input", () => {
    const cases: Array<[unknown, string]> = [
      [{ type: "nope<script>", requestId: "r" }, "unsupported request type"],
      [{ requestId: "r" }, "unsupported request type"],
      [{ type: "subscribe", requestId: "r", events: ["evil-event"] }, "unsupported event"],
      [
        { type: "subscribe", requestId: "r", events: "message_pending" },
        "events must be an array of event names",
      ],
      [{ type: "subscribe", requestId: "r", events: [], extra: 1 }, "unexpected field"],
      [
        { type: "close_profile", requestId: "r", profile: "" },
        "profile must be a non-empty string",
      ],
      [{ type: "close_profile", requestId: "r", profile: 7 }, "profile must be a non-empty string"],
      [{ type: "close_profile", requestId: "r" }, "profile must be a non-empty string"],
    ];
    for (const [value, error] of cases) {
      expect(parseManagementRequest(line(value)), JSON.stringify(value)).toEqual({
        kind: "error",
        requestId: "r",
        error,
      });
    }
  });

  it("is fatal when no usable requestId exists", () => {
    for (const text of [
      "not json",
      "[]",
      "null",
      '"subscribe"',
      line({ type: "subscribe", events: [] }),
      line({ type: "subscribe", requestId: "", events: [] }),
      line({ type: "subscribe", requestId: 5, events: [] }),
      line({ type: "subscribe", requestId: "x".repeat(MAX_REQUEST_ID_LENGTH + 1), events: [] }),
    ]) {
      expect(parseManagementRequest(text), text).toEqual({ kind: "fatal" });
    }
    expect(
      parseManagementRequest(
        line({ type: "subscribe", requestId: "x".repeat(MAX_REQUEST_ID_LENGTH), events: [] })
      ).kind
    ).toBe("ok");
  });
});

describe("encodeManagementFrame", () => {
  it("writes one JSON object terminated by a newline", () => {
    expect(
      encodeManagementFrame({
        type: "result",
        requestId: "r",
        result: { success: false, error: "unknown profile" },
      })
    ).toBe(
      '{"type":"result","requestId":"r","result":{"success":false,"error":"unknown profile"}}\n'
    );
  });
});

describe("secretMatches", () => {
  it("compares in constant time regardless of length", () => {
    const secret = "s".repeat(40);
    expect(secretMatches(secret, secret)).toBe(true);
    expect(secretMatches(`${secret}x`, secret)).toBe(false);
    expect(secretMatches("", secret)).toBe(false);
    expect(secretMatches("t".repeat(40), secret)).toBe(false);
  });
});
