/**
 * The relay's HTTP surface: `/healthz` and the three `/relay/...` routes a
 * gateway uses outside a WebSocket session.
 *
 * These handlers are deliberately thin. They authenticate with the gate, read a
 * body under a limit, and hand the parsed value to the store — the interesting
 * decisions (is this profile allowed, how big may it be, whose media is this)
 * live in `gate.ts`, in the boot snapshot, and in the store respectively.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody, sendJson, type HttpRoute, type RequestHandler } from "../http/server.js";
import { contentDisposition } from "./content-disposition.js";
import type { RelayGate } from "./gate.js";
import type { ProfileConfig } from "../config/schema.js";
import { MediaTooLargeError, type Store } from "../store/db.js";
import type { Logger } from "../util/log.js";

/** The policy route takes a small JSON document; nothing larger is meaningful. */
const JSON_BODY_LIMIT = 1_048_576;

export interface RelayRoutesOptions {
  gate: RelayGate;
  store: Store;
  log: Logger;
  /** `media.max_bytes` as captured at boot. */
  maxMediaBytes: number;
  /** The assembled `/healthz` snapshot, built by whoever knows the whole system. */
  health: () => Record<string, unknown>;
  /** Unix seconds; injectable for tests. */
  now?: () => number;
}

export function relayRoutes(opts: RelayRoutesOptions): HttpRoute[] {
  const { gate, store, log } = opts;
  const nowSeconds = opts.now ?? ((): number => Math.floor(Date.now() / 1000));

  /** HTTP-route auth; writes the error response itself on failure. */
  function authorize(req: IncomingMessage, res: ServerResponse): ProfileConfig | null {
    const outcome = gate.authenticate(req);
    if (outcome.ok) {
      return outcome.profile;
    }
    const error = gate.httpError(outcome.reason);
    sendJson(res, error.status, { error: error.error });
    // Drain the (unread) body so the client reliably sees the response.
    req.resume();
    return null;
  }

  async function readJson(req: IncomingMessage, res: ServerResponse): Promise<unknown | undefined> {
    const body = await readBody(req, JSON_BODY_LIMIT);
    if (!body.ok) {
      sendJson(res, 413, { error: "payload too large" });
      return undefined;
    }
    try {
      return body.body.byteLength === 0 ? {} : JSON.parse(body.body.toString("utf8"));
    } catch {
      sendJson(res, 400, { error: "invalid json" });
      return undefined;
    }
  }

  /** Path below `prefix`, or null when the request does not start with it. */
  function suffix(req: IncomingMessage, prefix: string): string | null {
    try {
      const path = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? "relay.invalid"}`
      ).pathname.replace(/\/+$/, "");
      return path.startsWith(prefix) ? path.slice(prefix.length) : null;
    } catch {
      return null;
    }
  }

  const handleHealth: RequestHandler = (_req, res) => {
    sendJson(res, 200, opts.health());
  };

  const handlePolicy: RequestHandler = async (req, res) => {
    const profile = authorize(req, res);
    if (profile === null) {
      return;
    }
    const parsed = await readJson(req, res);
    if (parsed === undefined) {
      return;
    }
    const stored = store.policy.set(profile.name, parsed, nowSeconds());
    log.info({ profile: profile.name, policy: stored }, "relay policy updated");
    sendJson(res, 200, {});
  };

  const handleMediaUpload: RequestHandler = async (req, res) => {
    const profile = authorize(req, res);
    if (profile === null) {
      return;
    }
    const body = await readBody(req, opts.maxMediaBytes);
    if (!body.ok) {
      sendJson(res, 413, { error: "payload too large" });
      return;
    }
    const mime = (req.headers["content-type"] ?? "application/octet-stream").split(";")[0]?.trim();
    const filenameHeader = req.headers["x-media-filename"];
    const filename = Array.isArray(filenameHeader) ? filenameHeader[0] : filenameHeader;
    try {
      const { id } = store.media.put(
        profile.name,
        body.body,
        mime === undefined || mime === "" ? "application/octet-stream" : mime,
        filename ?? null,
        nowSeconds()
      );
      log.debug({ profile: profile.name, id, size: body.body.byteLength }, "media stored");
      sendJson(res, 200, { id });
    } catch (err: unknown) {
      if (err instanceof MediaTooLargeError) {
        sendJson(res, 413, { error: "payload too large" });
        return;
      }
      log.error({ err: String(err), profile: profile.name }, "media upload failed");
      sendJson(res, 500, { error: "could not store media" });
    }
  };

  const handleMediaDownload: RequestHandler = (req, res) => {
    const profile = authorize(req, res);
    if (profile === null) {
      return;
    }
    const rawId = suffix(req, "/relay/media/");
    if (rawId === null) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    let id: string;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    const meta = store.media.getMeta(id);
    // Another profile's media must be indistinguishable from media that is not there.
    if (meta === null || meta.profile !== profile.name) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    const found = store.media.get(id);
    if (found === null) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    res.writeHead(200, {
      "content-type": found.meta.mime,
      "content-length": String(found.bytes.byteLength),
      "content-disposition": contentDisposition(found.meta.filename, id),
      "cache-control": "private, max-age=300",
    });
    res.end(found.bytes);
  };

  return [
    { method: "GET", path: "/healthz", handle: handleHealth },
    { method: "POST", path: "/relay/policy", handle: handlePolicy },
    { method: "POST", path: "/relay/media", handle: handleMediaUpload },
    { method: "GET", path: "/relay/media", prefix: true, handle: handleMediaDownload },
  ];
}
