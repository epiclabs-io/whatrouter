/**
 * The HTTP server every route is mounted on.
 *
 * This module knows about `node:http` and nothing else: no routes, no auth, no
 * config. Callers hand it a list of routes and a map of upgrade paths, so what
 * a deployment serves is visible in one place (`serve.ts`) instead of spread
 * across whichever module happened to need the socket first.
 *
 * The helpers at the bottom (`readBody`, `sendJson`, `rawToString`) live here
 * because three modules needed the same three functions, and a copy per module
 * is how they drift apart.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData } from "ws";
import type { Logger } from "../util/log.js";

export type RequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

export interface HttpRoute {
  /** Undefined matches any method. */
  method?: string;
  /** Exact path, or with `prefix`, the path followed by `/...`. */
  path: string;
  /** True matches `path` and anything below it. */
  prefix?: boolean;
  handle: RequestHandler;
}

export interface HttpServer {
  listen(): Promise<{ host: string; port: number }>;
  /** Idle connections first, then all of them after a short grace. */
  close(): Promise<void>;
}

export interface HttpServerOptions {
  listen: { host: string; port: number };
  /** First match wins; nothing matching is a 404. */
  routes: HttpRoute[];
  /** By upgrade path. An unknown path is refused rather than left hanging. */
  upgrades: Record<string, UpgradeHandler>;
  log: Logger;
}

/** How long a closing server waits before dropping connections that linger. */
const CLOSE_GRACE_MS = 2_000;

/** The path a request asks for, or null when it asks for nothing we can read. */
function requestPath(req: IncomingMessage): string | null {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "whatrouter.invalid"}`);
    return url.pathname.replace(/\/+$/, "") || "/";
  } catch {
    return null;
  }
}

export function createHttpServer(opts: HttpServerOptions): HttpServer {
  const { listen, routes, log } = opts;
  let closed = false;

  const server: Server = createServer((req, res) => {
    void (async (): Promise<void> => {
      const path = requestPath(req);
      if (path === null) {
        sendJson(res, 400, { error: "bad request" });
        return;
      }
      const method = req.method ?? "GET";
      const route = routes.find((candidate) => {
        if (candidate.method !== undefined && candidate.method !== method) {
          return false;
        }
        return candidate.prefix === true
          ? path.startsWith(`${candidate.path}/`)
          : path === candidate.path;
      });
      if (route === undefined) {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      await route.handle(req, res);
    })().catch((err: unknown) => {
      log.error({ err: String(err), path: req.url }, "request handler failed");
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal error" });
      } else {
        res.end();
      }
    });
  });

  server.on("upgrade", (req, socket, head) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://whatrouter.invalid").pathname;
    } catch {
      pathname = "/";
    }
    const handler = opts.upgrades[pathname];
    if (handler === undefined) {
      log.warn(
        { path: req.url, ip: req.socket.remoteAddress ?? "unknown" },
        "websocket upgrade on an unknown path"
      );
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    handler(req, socket, head);
  });

  return {
    async listen() {
      await new Promise<void>((resolvePromise, reject) => {
        const onError = (err: Error): void => reject(err);
        server.once("error", onError);
        server.listen(listen.port, listen.host, () => {
          server.removeListener("error", onError);
          resolvePromise();
        });
      });
      const address = server.address();
      const bound =
        address !== null && typeof address === "object"
          ? { host: listen.host, port: (address as AddressInfo).port }
          : { host: listen.host, port: listen.port };
      log.info({ host: bound.host, port: bound.port }, "http server listening");
      return bound;
    },

    async close() {
      if (closed) {
        return;
      }
      closed = true;
      await new Promise<void>((resolvePromise) => {
        let done = false;
        const finish = (): void => {
          if (done) {
            return;
          }
          done = true;
          resolvePromise();
        };
        server.close(finish);
        server.closeIdleConnections();
        const grace = setTimeout(() => {
          server.closeAllConnections();
          finish();
        }, CLOSE_GRACE_MS);
        grace.unref?.();
      });
    },
  };
}

// ------------------------------------------------------------------- helpers

/**
 * Closes a `noServer` WebSocket server without letting a non-cooperative client
 * stall shutdown: its clients are terminated once the grace is up.
 *
 * Lives here because it is the same "close, but do not hang" concern as
 * `HttpServer.close`, and one definition is easier to keep identical.
 */
export function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  return new Promise<void>((resolvePromise) => {
    const grace = setTimeout(() => {
      for (const client of wss.clients) {
        client.terminate();
      }
    }, CLOSE_GRACE_MS);
    grace.unref?.();
    wss.close(() => {
      clearTimeout(grace);
      resolvePromise();
    });
  });
}

export type ReadBodyResult = { ok: true; body: Buffer } | { ok: false; reason: "too_large" };

/**
 * Reads at most `limit` bytes, refusing anything larger rather than truncating.
 *
 * Truncating would hand the caller a valid-looking prefix of someone else's
 * body; a `too_large` answer is the only honest one at a size limit.
 */
export function readBody(req: IncomingMessage, limit: number): Promise<ReadBodyResult> {
  // A declared length over the limit is refused before a byte is read, so the
  // answer goes out while the client is still uploading and nothing is buffered.
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) {
    return Promise.resolve({ ok: false, reason: "too_large" });
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const settle = (result: ReadBodyResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };
    req.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > limit) {
        // Deliberately no `req.destroy()`: the refusal still has to reach the
        // client, which is mid-upload. Draining what is left is Node's problem
        // once the response is written.
        settle({ ok: false, reason: "too_large" });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      settle({ ok: true, body: Buffer.concat(chunks) });
    });
    req.on("error", reject);
  });
}

export function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {}
): void {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.byteLength),
    ...headers,
  });
  res.end(body);
}

export function rawToString(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data as ArrayBuffer).toString("utf8");
}
