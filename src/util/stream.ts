/**
 * Reading a stream with a hard ceiling.
 *
 * A WhatsApp attachment is a remote stream, so its real size is only known once
 * it has been read. `maxBytes` is a cap on memory, not a politeness limit: the
 * moment the stream crosses it we stop reading and destroy it, so an oversized
 * or endless stream costs one chunk rather than the process's heap.
 */
import type { Readable } from "node:stream";
import { MediaTooLargeError } from "../store/media.js";

/**
 * Buffers `stream` into a single `Uint8Array`, rejecting with
 * `MediaTooLargeError` if more than `maxBytes` arrive. The stream is destroyed
 * before the error propagates, whether that is on an over-long read or a failure
 * from upstream, so the socket is not left open.
 */
export async function readCapped(stream: Readable, maxBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(String(chunk));
      total += bytes.byteLength;
      if (total > maxBytes) {
        // `size` is what we have seen, which is the least we know for sure.
        throw new MediaTooLargeError(total, maxBytes);
      }
      chunks.push(bytes);
    }
  } catch (err) {
    stream.destroy();
    throw err;
  }
  const out = Buffer.allocUnsafe(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
