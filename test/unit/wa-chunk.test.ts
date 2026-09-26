import { describe, expect, it } from "vitest";
import { WHATSAPP_MAX_MESSAGE_CHARS, chunkText } from "../../src/whatsapp/chunk.js";

function fences(text: string): number {
  return text.split("```").length - 1;
}

describe("chunkText", () => {
  it("returns nothing for an empty string", () => {
    expect(chunkText("")).toEqual([]);
  });

  it("keeps a short message whole", () => {
    expect(chunkText("hello")).toEqual(["hello"]);
  });

  it("keeps a message of exactly the limit whole", () => {
    const text = "a".repeat(WHATSAPP_MAX_MESSAGE_CHARS);
    expect(chunkText(text)).toEqual([text]);
  });

  it("splits one character over the limit", () => {
    const text = "a".repeat(WHATSAPP_MAX_MESSAGE_CHARS + 1);
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(WHATSAPP_MAX_MESSAGE_CHARS);
    expect(chunks[1]).toBe("a");
    expect(chunks.join("")).toBe(text);
  });

  it("prefers the last newline before the limit", () => {
    const text = `${"a".repeat(30)}\n${"b".repeat(30)}`;
    expect(chunkText(text, 40)).toEqual(["a".repeat(30), "b".repeat(30)]);
  });

  it("falls back to the last space", () => {
    const text = `${"a".repeat(30)} ${"b".repeat(30)}`;
    expect(chunkText(text, 40)).toEqual(["a".repeat(30), "b".repeat(30)]);
  });

  it("hard splits an unbreakable run", () => {
    const chunks = chunkText("x".repeat(25), 10);
    expect(chunks).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  });

  it("closes and reopens a code fence across chunks", () => {
    const body = Array.from({ length: 10 }, () => "0123456789").join("\n");
    const chunks = chunkText(`\`\`\`\n${body}\n\`\`\``, 40);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(40);
      // Every chunk renders on its own: no half-open fence anywhere.
      expect(fences(chunk) % 2).toBe(0);
    }
    expect(chunks[0]?.startsWith("```")).toBe(true);
    expect(chunks[0]?.endsWith("```")).toBe(true);
    expect(chunks[1]?.startsWith("```\n")).toBe(true);
    expect(chunks.at(-1)?.endsWith("```")).toBe(true);
  });

  it("does not touch text that has no fences", () => {
    const chunks = chunkText("plain text without fences", 10);
    for (const chunk of chunks) {
      expect(chunk).not.toContain("```");
    }
    expect(chunks.join(" ")).toBe("plain text without fences");
  });

  it("leaves a balanced fenced block that fits in one chunk alone", () => {
    const text = "before\n```\ncode\n```\nafter";
    expect(chunkText(text, 4096)).toEqual([text]);
  });
});
