import { describe, expect, it } from "vitest";
import { markdownToWhatsApp } from "../../src/whatsapp/format.js";

describe("markdownToWhatsApp", () => {
  it("converts bold", () => {
    expect(markdownToWhatsApp("**bold**")).toBe("*bold*");
    expect(markdownToWhatsApp("__bold__")).toBe("*bold*");
    expect(markdownToWhatsApp("a **bold** b")).toBe("a *bold* b");
  });

  it("converts italics without eating the bold markers", () => {
    expect(markdownToWhatsApp("*italic*")).toBe("_italic_");
    expect(markdownToWhatsApp("_italic_")).toBe("_italic_");
    expect(markdownToWhatsApp("**bold** and *italic*")).toBe("*bold* and _italic_");
    expect(markdownToWhatsApp("***both***")).toBe("*_both_*");
  });

  it("leaves arithmetic and identifiers alone", () => {
    expect(markdownToWhatsApp("2*3*4")).toBe("2*3*4");
  });

  it("converts strikethrough", () => {
    expect(markdownToWhatsApp("~~gone~~")).toBe("~gone~");
  });

  it("converts ATX headings to bold lines, dropping inner emphasis", () => {
    expect(markdownToWhatsApp("# Heading")).toBe("*Heading*");
    expect(markdownToWhatsApp("### **Big** heading")).toBe("*Big heading*");
    expect(markdownToWhatsApp("# One\ntext\n## Two")).toBe("*One*\ntext\n*Two*");
    expect(markdownToWhatsApp("## *emphasised* heading")).toBe("*emphasised heading*");
    // Underscores inside identifiers are not emphasis.
    expect(markdownToWhatsApp("# handle_this_case")).toBe("*handle_this_case*");
  });

  it("flattens links", () => {
    expect(markdownToWhatsApp("[Docs](https://example.com)")).toBe("Docs (https://example.com)");
    expect(markdownToWhatsApp("see [the docs](https://x.dev/a_b) now")).toBe(
      "see the docs (https://x.dev/a_b) now"
    );
  });

  it("converts bullets", () => {
    expect(markdownToWhatsApp("- one\n* two\n  - three")).toBe("• one\n• two\n  • three");
  });

  it("never rewrites anything inside code", () => {
    const fenced = "```js\nconst a = **not bold**; // *keep*\n```";
    expect(markdownToWhatsApp(fenced)).toBe(fenced);
    expect(markdownToWhatsApp("use `a **b** c` here")).toBe("use `a **b** c` here");
  });

  it("keeps the fences so WhatsApp renders monospace", () => {
    const out = markdownToWhatsApp("before\n```\ncode\n```\nafter **x**");
    expect(out).toBe("before\n```\ncode\n```\nafter *x*");
  });

  it("handles a mixed document", () => {
    const input = [
      "# Report",
      "",
      "The **build** is *green*, see [CI](https://ci.example.com).",
      "",
      "- ~~flaky~~ fixed",
      "- `npm test` passes",
    ].join("\n");
    expect(markdownToWhatsApp(input)).toBe(
      [
        "*Report*",
        "",
        "The *build* is _green_, see CI (https://ci.example.com).",
        "",
        "• ~flaky~ fixed",
        "• `npm test` passes",
      ].join("\n")
    );
  });

  it("passes an empty string through", () => {
    expect(markdownToWhatsApp("")).toBe("");
  });
});
