import { describe, expect, it, vi } from "vitest";
import type { WAMessage, WAMessageKey } from "@whiskeysockets/baileys";
import {
  OPUS_MIME,
  SendTimeoutError,
  buildDeletePayload,
  buildEditPayload,
  buildMediaPayload,
  buildReactPayload,
  buildTextPayload,
  createSendQueue,
} from "../../src/whatsapp/outbound.js";
import type { OutboundMedia } from "../../src/whatsapp/port.js";

const KEY: WAMessageKey = { id: "ABC123", remoteJid: "34611111111@s.whatsapp.net", fromMe: true };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("payload builders", () => {
  it("builds a plain text payload", () => {
    expect(buildTextPayload("hi")).toEqual({ content: { text: "hi" }, options: {} });
  });

  it("attaches mentions and a quoted message", () => {
    const quoted = { key: KEY, message: { conversation: "earlier" } } as WAMessage;
    const payload = buildTextPayload("hi", { quoted, mentions: ["34611111111@s.whatsapp.net"] });
    expect(payload.content).toEqual({ text: "hi", mentions: ["34611111111@s.whatsapp.net"] });
    expect(payload.options.quoted).toBe(quoted);
  });

  it("builds edit, delete and react payloads", () => {
    expect(buildEditPayload("fixed", KEY)).toEqual({
      content: { text: "fixed", edit: KEY },
      options: {},
    });
    expect(buildDeletePayload(KEY)).toEqual({ content: { delete: KEY }, options: {} });
    expect(buildReactPayload("👍", KEY)).toEqual({
      content: { react: { text: "👍", key: KEY } },
      options: {},
    });
    // An empty emoji is how the relay `react` op removes a reaction.
    expect(buildReactPayload("", KEY).content).toEqual({ react: { text: "", key: KEY } });
  });
});

describe("buildMediaPayload", () => {
  const bytes = new Uint8Array([1, 2, 3]);

  it("builds image, video and document payloads", async () => {
    const image = await buildMediaPayload({
      kind: "image",
      bytes,
      mime: "image/png",
      caption: "c",
    });
    expect(image.content).toMatchObject({ mimetype: "image/png", caption: "c" });
    expect(Buffer.isBuffer((image.content as { image: Buffer }).image)).toBe(true);

    const video = await buildMediaPayload({ kind: "video", bytes, mime: "video/mp4" });
    expect(video.content).toMatchObject({ mimetype: "video/mp4" });
    expect(video.content).not.toHaveProperty("caption");

    const doc = await buildMediaPayload({
      kind: "document",
      bytes,
      mime: "application/pdf",
      filename: "a.pdf",
    });
    expect(doc.content).toMatchObject({ mimetype: "application/pdf", fileName: "a.pdf" });
  });

  it("sends an ogg/opus voice note as ptt without transcoding", async () => {
    const transcode = vi.fn(async () => null);
    const payload = await buildMediaPayload(
      { kind: "voice", bytes, mime: "audio/ogg; codecs=opus" },
      { transcode }
    );
    expect(transcode).not.toHaveBeenCalled();
    expect(payload.content).toMatchObject({ ptt: true, mimetype: OPUS_MIME });
  });

  it("transcodes other audio for a voice note when ffmpeg is available", async () => {
    const transcode = vi.fn(async () => new Uint8Array([9, 9]));
    const payload = await buildMediaPayload(
      { kind: "voice", bytes, mime: "audio/mpeg" },
      { transcode }
    );
    expect(transcode).toHaveBeenCalledOnce();
    expect(payload.content).toMatchObject({ ptt: true, mimetype: OPUS_MIME });
    expect((payload.content as { audio: Buffer }).audio).toEqual(Buffer.from([9, 9]));
  });

  it("falls back to a plain audio attachment when transcoding is impossible", async () => {
    const payload = await buildMediaPayload(
      { kind: "voice", bytes, mime: "audio/mpeg" },
      { transcode: async () => null }
    );
    expect(payload.content).toMatchObject({ ptt: false, mimetype: "audio/mpeg" });
  });

  it("sends plain audio as a file", async () => {
    const media: OutboundMedia = { kind: "audio", bytes, mime: "audio/mpeg" };
    const payload = await buildMediaPayload(media);
    expect(payload.content).toMatchObject({ mimetype: "audio/mpeg" });
    expect(payload.content).not.toHaveProperty("ptt");
  });
});

describe("createSendQueue", () => {
  it("runs calls one at a time, in order", async () => {
    const queue = createSendQueue({ timeoutMs: 1000 });
    const events: string[] = [];

    const slow = queue.enqueue(async () => {
      events.push("a:start");
      await sleep(30);
      events.push("a:end");
      return "a";
    });
    const fast = queue.enqueue(async () => {
      events.push("b:start");
      return "b";
    });

    expect(await Promise.all([slow, fast])).toEqual(["a", "b"]);
    expect(events).toEqual(["a:start", "a:end", "b:start"]);
  });

  it("rejects a call that overruns the timeout and keeps the lane moving", async () => {
    const queue = createSendQueue({ timeoutMs: 20 });
    const stuck = queue.enqueue(async () => {
      await sleep(200);
      return "never";
    });
    const after = queue.enqueue(async () => "after");

    await expect(stuck).rejects.toBeInstanceOf(SendTimeoutError);
    await expect(stuck).rejects.toThrow("sendMessage timed out after 0s");
    expect(await after).toBe("after");
  });

  it("keeps going after a rejected call", async () => {
    const queue = createSendQueue({ timeoutMs: 1000 });
    const failed = queue.enqueue(async () => {
      throw new Error("boom");
    });
    const next = queue.enqueue(async () => "ok");

    await expect(failed).rejects.toThrow("boom");
    expect(await next).toBe("ok");
    expect(queue.depth()).toBe(0);
  });
});
