import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { parseBearer } from "../relay/auth.js";
import { secretMatches } from "../management/auth.js";
import type { Logger } from "../util/log.js";
import { createMcpServer, type McpToolOptions } from "./tools.js";

const MAX_SESSIONS = 32;
const IDLE_MS = 15 * 60_000;
const BODY_LIMIT = 1024 * 1024;

interface SessionEntry {
  server: ReturnType<typeof createMcpServer>;
  transport: StreamableHTTPServerTransport;
  lastUsed: number;
  /** Requests currently being handled; busy sessions are never evicted. */
  inFlight: number;
}

interface InitializingEntry extends SessionEntry {
  done: Promise<void>;
  finish: () => void;
}

export interface McpEndpoint {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  close(): Promise<void>;
}

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  const encoded = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(encoded.byteLength),
    ...headers,
  });
  res.end(encoded);
}

function ownOrigin(req: IncomingMessage): string | null {
  const host = req.headers.host;
  if (host === undefined) {
    return null;
  }
  const encrypted = "encrypted" in req.socket && req.socket.encrypted === true;
  try {
    return new URL(`${encrypted ? "https" : "http"}://${host}`).origin;
  } catch {
    return null;
  }
}

export function createMcpEndpoint(opts: McpToolOptions & { log: Logger }): McpEndpoint {
  const sessions = new Map<string, SessionEntry>();
  const initializing = new Set<InitializingEntry>();
  let closed = false;

  const expire = setInterval(() => {
    const cutoff = Date.now() - IDLE_MS;
    for (const [id, entry] of sessions) {
      if (entry.lastUsed < cutoff && entry.inFlight === 0) {
        sessions.delete(id);
        void entry.transport.close().catch(() => undefined);
        void entry.server.close().catch(() => undefined);
      }
    }
  }, 60_000);
  expire.unref?.();

  /**
   * Frees a slot by closing the least recently used idle session. Clients that restart
   * without a DELETE leave sessions behind; refusing new ones would lock management out.
   */
  function evictLeastRecentlyUsed(): boolean {
    let victim: [string, SessionEntry] | undefined;
    for (const candidate of sessions) {
      if (
        candidate[1].inFlight === 0 &&
        (victim === undefined || candidate[1].lastUsed < victim[1].lastUsed)
      ) {
        victim = candidate;
      }
    }
    if (victim === undefined) {
      return false;
    }
    const [id, entry] = victim;
    sessions.delete(id);
    void entry.transport.close().catch(() => undefined);
    void entry.server.close().catch(() => undefined);
    opts.log.info({ sessionId: id }, "evicted the least recently used MCP session");
    return true;
  }

  async function remove(id: string, entry: SessionEntry): Promise<void> {
    if (sessions.get(id) !== entry) {
      return;
    }
    sessions.delete(id);
    await entry.server.close().catch(() => undefined);
  }

  return {
    async handle(req, res) {
      if (closed) {
        json(res, 503, { error: "shutting down" });
        return;
      }
      const management = opts.getConfig().management;
      if (management === null) {
        json(res, 404, { error: "not found" });
        req.resume();
        return;
      }
      const token = parseBearer(req.headers.authorization);
      if (token === null || !secretMatches(token, management.secret)) {
        opts.log.warn(
          {
            method: req.method,
            path: req.url,
            reason: token === null ? "missing_token" : "bad_secret",
          },
          "MCP auth failure"
        );
        json(res, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
        req.resume();
        return;
      }
      const origin = req.headers.origin;
      if (origin !== undefined && (Array.isArray(origin) || origin !== ownOrigin(req))) {
        json(res, 403, { error: "origin rejected" });
        req.resume();
        return;
      }
      const method = req.method ?? "GET";
      if (method !== "GET" && method !== "POST" && method !== "DELETE") {
        json(res, 405, { error: "method not allowed" }, { allow: "GET, POST, DELETE" });
        req.resume();
        return;
      }
      const rawSession = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(rawSession) ? rawSession[0] : rawSession;
      let entry = sessionId === undefined ? undefined : sessions.get(sessionId);
      if (entry === undefined && sessionId !== undefined) {
        json(res, 404, { error: "unknown MCP session" });
        req.resume();
        return;
      }
      if (entry === undefined) {
        if (method !== "POST") {
          json(res, 400, { error: "MCP initialization requires POST" });
          req.resume();
          return;
        }
        if (sessions.size + initializing.size >= MAX_SESSIONS && !evictLeastRecentlyUsed()) {
          json(res, 503, { error: "too many MCP sessions" });
          req.resume();
          return;
        }
        let parsed: unknown;
        try {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of req) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
            size += buffer.byteLength;
            if (size > BODY_LIMIT) {
              throw new Error("too large");
            }
            chunks.push(buffer);
          }
          parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch (error) {
          json(res, error instanceof Error && error.message === "too large" ? 413 : 400, {
            error: "invalid request body",
          });
          return;
        }
        if (!isInitializeRequest(parsed)) {
          json(res, 400, { error: "missing MCP session" });
          return;
        }
        const server = createMcpServer(opts);
        let transport: StreamableHTTPServerTransport;
        let finish!: () => void;
        const done = new Promise<void>((resolve) => {
          finish = resolve;
        });
        let initializingEntry!: InitializingEntry;
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          enableJsonResponse: true,
          maxRequestBodySize: BODY_LIMIT,
          onsessioninitialized: (id): void => {
            if (!closed && initializing.has(initializingEntry)) {
              sessions.set(id, { server, transport, lastUsed: Date.now(), inFlight: 0 });
            }
          },
          onsessionclosed: (id) => {
            const found = sessions.get(id);
            if (found !== undefined) {
              void remove(id, found);
            }
          },
        });
        entry = { server, transport, lastUsed: Date.now(), inFlight: 0 };
        initializingEntry = { ...entry, done, finish };
        initializing.add(initializingEntry);
        transport.onerror = (error: Error) =>
          opts.log.warn({ err: String(error) }, "MCP transport error");
        try {
          // SDK 1.31's optional callback declarations predate exactOptionalPropertyTypes.
          await server.connect(transport as Transport);
          await transport.handleRequest(req, res, parsed);
        } catch (error) {
          if (transport.sessionId !== undefined) {
            sessions.delete(transport.sessionId);
          }
          await transport.close().catch(() => undefined);
          await server.close().catch(() => undefined);
          throw error;
        } finally {
          initializing.delete(initializingEntry);
          finish();
        }
        return;
      }
      entry.lastUsed = Date.now();
      entry.inFlight += 1;
      try {
        await entry.transport.handleRequest(req, res);
      } finally {
        entry.inFlight -= 1;
        entry.lastUsed = Date.now();
      }
    },

    async close() {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(expire);
      const active = [...sessions.values()];
      const starting = [...initializing];
      sessions.clear();
      const resources = [...active, ...starting].filter(
        (entry, index, all) =>
          all.findIndex((candidate) => candidate.transport === entry.transport) === index
      );
      await Promise.all(
        resources.map(async (entry) => {
          await entry.transport.close().catch(() => undefined);
          await entry.server.close().catch(() => undefined);
        })
      );
      await Promise.all(starting.map((entry) => entry.done));
    },
  };
}
