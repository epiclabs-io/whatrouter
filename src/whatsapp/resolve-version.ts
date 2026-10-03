import { fetchLatestBaileysVersion, type WAVersion } from "@whiskeysockets/baileys";
import type { Logger } from "../util/log.js";

const VERSION_FETCH_TIMEOUT_MS = 15_000;

export async function resolveVersion(
  enabled: boolean,
  log: Logger
): Promise<WAVersion | undefined> {
  if (!enabled) {
    return undefined;
  }
  try {
    const timeout = new Promise<null>((resolve) => {
      const timer = setTimeout(() => resolve(null), VERSION_FETCH_TIMEOUT_MS);
      timer.unref?.();
    });
    const result = await Promise.race([fetchLatestBaileysVersion(), timeout]);
    if (result === null) {
      log.warn("whatsapp version lookup timed out; using the bundled version");
      return undefined;
    }
    return result.version;
  } catch (err) {
    log.warn({ err }, "whatsapp version lookup failed; using the bundled version");
    return undefined;
  }
}
