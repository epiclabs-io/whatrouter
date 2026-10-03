/**
 * `whatrouter pair` - the one-off login that writes `<data_dir>/wa-auth`.
 *
 * Deliberately separate from the serving client: this is the only code path in the
 * program allowed to open a socket with unregistered credentials, print a QR code
 * or ask for a pairing code. `serve` refuses to do any of that.
 */
import qrcodeTerminal from "qrcode-terminal";
import {
  DisconnectReason,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type ConnectionState,
} from "@whiskeysockets/baileys";
import type { CliIo } from "../cli.js";
import type { Config } from "../config/schema.js";
import type { Logger } from "../util/log.js";
import {
  authDirFor,
  defaultMakeSocket,
  disconnectStatus,
  type MakeSocket,
  type SocketLike,
} from "./baileys-client.js";
import { digitsOf, normalizeJid } from "./jid.js";
import { resolveVersion } from "./resolve-version.js";

/** `34600000099:12@s.whatsapp.net` -> `34600000099` (the `:device` suffix is noise). */
function accountDigits(jid: string): string {
  return digitsOf(normalizeJid(jid));
}

export const PAIR_TIMEOUT_MS = 5 * 60_000;
/** Time given to `creds.update` after `open` before we close the socket. */
export const PAIR_SETTLE_MS = 2_000;

export interface PairOptions {
  config: Config;
  /** `--code <phone>`: pair with a code instead of a QR. */
  code?: string | undefined;
  log: Logger;
  io: CliIo;
  makeSocket?: MakeSocket | undefined;
  authDir?: string | undefined;
  timeoutMs?: number | undefined;
  settleMs?: number | undefined;
}

function formatPairingCode(code: string): string {
  const clean = code.replace(/[^A-Za-z0-9]/g, "");
  return clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : code;
}
export async function runPair(opts: PairOptions): Promise<number> {
  const { config, io, log } = opts;
  const makeSocket = opts.makeSocket ?? defaultMakeSocket;
  const fetchVersion = opts.makeSocket === undefined;
  const dir = opts.authDir ?? authDirFor(config);
  const timeoutMs = opts.timeoutMs ?? PAIR_TIMEOUT_MS;
  const settleMs = opts.settleMs ?? PAIR_SETTLE_MS;
  const waLogger = log.child({ mod: "baileys" });

  // Validate the arguments before creating anything on disk.
  const phoneDigits = opts.code === undefined ? "" : digitsOf(opts.code);
  if (opts.code !== undefined && phoneDigits === "") {
    io.err("error: --code needs a phone number in international format, e.g. --code +34600000000");
    return 1;
  }

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  if (state.creds.registered === true) {
    io.out(`already paired as ${accountDigits(state.creds.me?.id ?? "")}; connecting to verify…`);
  }

  const version = await resolveVersion(fetchVersion, log);

  return await new Promise<number>((resolve) => {
    let sock: SocketLike | null = null;
    let done = false;
    let qrPrinted = false;
    let codeRequested = false;
    let restarted = false;
    let completing = false;

    const timer = setTimeout(() => {
      io.err(`error: pairing timed out after ${Math.round(timeoutMs / 1000)}s`);
      finish(1);
    }, timeoutMs);
    timer.unref?.();

    function closeSocket(): void {
      const current = sock;
      sock = null;
      if (current === null) {
        return;
      }
      try {
        void Promise.resolve(current.end(undefined)).catch(() => undefined);
      } catch {
        /* already gone */
      }
    }

    function finish(exitCode: number): void {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      closeSocket();
      resolve(exitCode);
    }

    function printQr(qr: string): void {
      if (qrPrinted || opts.code !== undefined) {
        return;
      }
      qrPrinted = true;
      io.out("Scan this QR with WhatsApp → Settings → Linked devices → Link a device:");
      qrcodeTerminal.generate(qr, { small: true }, (rendered: string) => io.out(rendered));
    }

    function requestCode(): void {
      if (codeRequested || opts.code === undefined || sock === null) {
        return;
      }
      codeRequested = true;
      sock
        .requestPairingCode(phoneDigits)
        .then((code) => {
          io.out(`Pairing code: ${formatPairingCode(code)}`);
          io.out(
            "Enter it in WhatsApp → Settings → Linked devices → Link with phone number instead."
          );
        })
        .catch((err: unknown) => {
          io.err(`error: could not request a pairing code: ${String(err)}`);
          finish(1);
        });
    }

    function onOpen(): void {
      if (completing) {
        return;
      }
      completing = true;
      // Baileys does not reliably mutate this flag while pairing. An authenticated
      // open socket is the authoritative signal that this device is registered.
      state.creds.registered = true;
      const me = sock?.user?.id ?? state.creds.me?.id ?? "";
      io.out(`Paired as ${accountDigits(me)}. Credentials saved to ${dir}.`);
      // Give the last `creds.update` room to land before we pull the socket down.
      void saveCreds()
        .catch((err: unknown) => log.debug({ err }, "final saveCreds failed"))
        .then(async () => {
          await new Promise<void>((done2) => {
            const settle = setTimeout(done2, settleMs);
            settle.unref?.();
          });
          finish(0);
        });
    }

    function onUpdate(update: Partial<ConnectionState>): void {
      if (done) {
        return;
      }
      if (update.qr !== undefined) {
        printQr(update.qr);
      }
      if (update.qr !== undefined || update.connection === "connecting") {
        requestCode();
      }

      if (update.connection === "open") {
        onOpen();
        return;
      }
      if (update.connection !== "close") {
        return;
      }

      const status = disconnectStatus(update.lastDisconnect?.error);
      sock = null;
      if (status === DisconnectReason.restartRequired && !restarted) {
        // Normal after a successful link: Baileys wants a fresh socket.
        restarted = true;
        open();
        return;
      }
      if (status === DisconnectReason.loggedOut) {
        io.err("error: WhatsApp logged this session out.");
        io.err(`Remove the stored credentials and pair again: rm -rf ${dir}`);
        finish(1);
        return;
      }
      io.err(`error: connection closed before pairing completed (status ${String(status)})`);
      finish(1);
    }

    function open(): void {
      const next = makeSocket({
        ...(version === undefined ? {} : { version }),
        logger: waLogger,
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, waLogger) },
        browser: ["WhatRouter", "Chrome", "120.0"],
        syncFullHistory: false,
        markOnlineOnConnect: false,
      });
      sock = next;
      next.ev.on("creds.update", (update) => {
        Object.assign(state.creds, update);
        void saveCreds().catch((err: unknown) => log.error({ err }, "saving credentials failed"));
      });
      next.ev.on("connection.update", (update) => {
        try {
          onUpdate(update);
        } catch (err) {
          log.error({ err }, "pairing update handler failed");
        }
      });
    }

    open();
  });
}
