import type WebSocket from "ws";

const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 60_000;

export function startWebSocketHeartbeat(ws: WebSocket, onTimeout: () => void): NodeJS.Timeout {
  let lastPong = Date.now();
  ws.on("pong", () => {
    lastPong = Date.now();
  });

  const timer = setInterval(() => {
    if (Date.now() - lastPong > PONG_TIMEOUT_MS) {
      onTimeout();
      ws.terminate();
      return;
    }
    try {
      ws.ping();
    } catch {
      /* the socket is going away anyway */
    }
  }, PING_INTERVAL_MS);
  timer.unref?.();
  return timer;
}
