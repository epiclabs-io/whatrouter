import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { readCapped } from "../../src/util/stream.js";
import { MediaTooLargeError } from "../../src/store/media.js";

/** A readable that reports how much was pulled, so we can see the abort. */
function counted(chunks: Uint8Array[]): Readable & { pulled: number } {
  const stream = Readable.from(chunks) as Readable & { pulled: number };
  stream.pulled = 0;
  const original = stream.push.bind(stream);
  vi.spyOn(stream, "push").mockImplementation(((chunk: unknown) => {
    if (chunk !== null) {
      stream.pulled += 1;
    }
    return original(chunk);
  }) as typeof stream.push);
  return stream;
}

describe("readCapped", () => {
  it("concatenates a stream that stays under the cap", async () => {
    const bytes = await readCapped(Readable.from([Buffer.from([1, 2]), Buffer.from([3, 4])]), 8);
    expect([...bytes]).toEqual([1, 2, 3, 4]);
  });

  it("returns an empty array for an empty stream", async () => {
    expect(await readCapped(Readable.from([]), 8)).toHaveLength(0);
  });

  it("accepts a stream that lands exactly on the cap", async () => {
    const bytes = await readCapped(Readable.from([Buffer.alloc(4)]), 4);
    expect(bytes).toHaveLength(4);
  });

  it("rejects with MediaTooLargeError and destroys the stream past the cap", async () => {
    // Three chunks of 4: the third pushes the total to 12, over a limit of 8.
    const stream = counted([Buffer.alloc(4), Buffer.alloc(4), Buffer.alloc(4)]);
    await expect(readCapped(stream, 8)).rejects.toBeInstanceOf(MediaTooLargeError);
    expect(stream.destroyed).toBe(true);
    // It stopped at the chunk that broke the cap rather than draining the rest.
    expect(stream.pulled).toBe(3);
  });

  it("reports the size it saw and the limit that was exceeded", async () => {
    const err = await readCapped(Readable.from([Buffer.alloc(6)]), 4).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaTooLargeError);
    expect((err as MediaTooLargeError).size).toBe(6);
    expect((err as MediaTooLargeError).limit).toBe(4);
    expect((err as MediaTooLargeError).code).toBe("media_too_large");
  });

  it("destroys the stream and rethrows an upstream failure", async () => {
    const stream = new Readable({
      read() {
        this.destroy(new Error("socket hang up"));
      },
    });
    await expect(readCapped(stream, 1024)).rejects.toThrow("socket hang up");
    expect(stream.destroyed).toBe(true);
  });
});
