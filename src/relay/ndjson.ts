/**
 * NDJSON framing. The gateway's reader holds a partial line forever, so every
 * frame we write ends with `\n`; its writer may pack several frames into one WS
 * message or split one frame across messages, so our reader re-assembles lines.
 */
import { isGatewayFrame, type GatewayFrame, type RelayFrame } from './frames.js';

/** JSON + a mandatory trailing newline. */
export function encodeFrame(frame: RelayFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

/** Buffers partial lines across chunks and yields complete, non-empty ones. */
export class LineAssembler {
  #buf = '';

  push(chunk: string): string[] {
    if (chunk === '') return [];
    this.#buf += chunk;
    const lines: string[] = [];
    let nl = this.#buf.indexOf('\n');
    while (nl !== -1) {
      const line = this.#buf.slice(0, nl).trim();
      this.#buf = this.#buf.slice(nl + 1);
      if (line !== '') lines.push(line);
      nl = this.#buf.indexOf('\n');
    }
    return lines;
  }

  /** Bytes held back waiting for their newline (diagnostics / tests). */
  get pending(): string {
    return this.#buf;
  }

  reset(): void {
    this.#buf = '';
  }
}

/**
 * Parses one assembled line. Returns null for malformed JSON and for frame
 * types we do not act on — the caller logs, the connection survives (the
 * contract is additive-only).
 */
export function parseGatewayFrame(line: string): GatewayFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  return isGatewayFrame(value) ? value : null;
}
