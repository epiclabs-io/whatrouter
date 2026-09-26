/**
 * Logger factory. Pretty on an interactive terminal, newline-delimited JSON otherwise
 * (containers, systemd). `WHATROUTER_LOG_LEVEL` overrides the configured level.
 */
import { createRequire } from "node:module";
import pino from "pino";

export type Logger = pino.Logger;
export type LogLevelName = pino.Level;

export interface LoggerOptions {
  /** Usually `config.logLevel`. */
  level?: string;
  name?: string;
}

// pino-pretty is a dev dependency: production images install with --omit=dev.
function prettyAvailable(): boolean {
  try {
    createRequire(import.meta.url).resolve("pino-pretty");
    return true;
  } catch {
    return false;
  }
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = process.env["WHATROUTER_LOG_LEVEL"] ?? opts.level ?? "info";
  const pretty =
    process.stdout.isTTY === true && process.env["NODE_ENV"] !== "production" && prettyAvailable();

  return pino({
    level,
    ...(opts.name === undefined ? {} : { name: opts.name }),
    ...(pretty
      ? {
          transport: {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" },
          },
        }
      : {}),
  });
}
