/** Shared fixtures for relay and store tests (not a test file itself). */
import pino from "pino";
import type { Config, ProfileConfig } from "../../src/config/schema.js";
import type { Logger } from "../../src/util/log.js";
import { sign } from "../../src/relay/auth.js";
import type { RelayEvent } from "../../src/relay/frames.js";

/**
 * Mints a relay token the way the gateway does. Production only ever verifies
 * tokens, so this lives with the tests that need to be a gateway.
 */
export function makeToken(
  payload: string,
  secret: string,
  ttlSeconds: number,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): string {
  const exp = ttlSeconds > 0 ? Math.floor(nowSeconds) + Math.floor(ttlSeconds) : 0;
  const signed = `${payload}:${exp}`;
  return Buffer.from(`${signed}:${sign(signed, secret)}`, "utf8").toString("base64url");
}

export function silentLogger(): Logger {
  return pino({ level: "silent" });
}

export function testProfile(name: string, overrides: Partial<ProfileConfig> = {}): ProfileConfig {
  return {
    name,
    gatewayId: `gw-${name}`,
    secret: `secret-for-${name}-0123456789abcdef0123456789`,
    displayName: null,
    wakeUrl: null,
    routes: [],
    ...overrides,
  };
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    listen: { host: "127.0.0.1", port: 0 },
    publicUrl: null,
    dataDir: "./data",
    logLevel: "info",
    whatsapp: {
      editStreaming: false,
      sendReadReceipts: false,
      chunkDelayMs: 300,
      sendTimeoutMs: 60_000,
    },
    buffer: { maxAgeSeconds: 1_209_600, wakeCooldownSeconds: 60 },
    media: { maxBytes: 26_214_400, retentionSeconds: 604_800 },
    defaultProfile: null,
    allowUnroutedOutbound: false,
    management: null,
    groups: {},
    profiles: [testProfile("work")],
    ...overrides,
  };
}

export function testEvent(text: string, chatId = "34600000000@s.whatsapp.net"): RelayEvent {
  return {
    text,
    message_type: "text",
    message_id: `wa-${text}`,
    reply_to_message_id: null,
    source: {
      platform: "whatsapp",
      chat_id: chatId,
      chat_type: "dm",
      chat_name: "Tester",
      user_id: chatId,
      user_name: "Tester",
      thread_id: null,
      chat_topic: null,
      message_id: `wa-${text}`,
    },
  };
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
