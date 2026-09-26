/**
 * Markdown (what an LLM writes) -> WhatsApp formatting (what the app renders).
 *
 * Port of Hermes' `WhatsAppBehaviorMixin`:
 *   **bold** / __bold__ -> *bold*      *italic* / _italic_ -> _italic_
 *   ~~strike~~          -> ~strike~    # Heading           -> *Heading*
 *   [text](url)         -> text (url)  - item / * item     -> • item
 *
 * Two rules keep this from eating itself:
 *  - code (fenced and inline) is stashed behind placeholders first and restored last,
 *    so nothing inside a code block is rewritten;
 *  - italics run *before* bold, with lookarounds that refuse to match a `*` next to
 *    another `*`, so `**bold**` survives the italic pass untouched.
 */

const PLACEHOLDER_PREFIX = "\u0000";
const PLACEHOLDER_SUFFIX = "\u0000";

const FENCED_CODE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const HEADER_RE = /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm;
const LINK_RE = /\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const BULLET_RE = /^([ \t]*)[-*][ \t]+/gm;
const STRIKE_RE = /~~(?=\S)([\s\S]*?\S)~~/g;
const BOLD_ITALIC_RE = /\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g;
// A `*` that is not adjacent to another `*` and not glued to a word character:
// `*italic*` matches, `**bold**` and `2*3*4` do not.
const ITALIC_STAR_RE = /(?<![*\w])\*(?![\s*])([^*\n]+?)(?<![\s])\*(?![*\w])/g;
const BOLD_STAR_RE = /\*\*(?=\S)([\s\S]*?\S)\*\*/g;
const BOLD_UNDERSCORE_RE = /__(?=\S)([\s\S]*?\S)__/g;
/** A heading is bold as a whole, so inner emphasis markers are dropped. */
function stripEmphasis(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/(?<![\w])_(.+?)_(?![\w])/g, "$1");
}

class Stash {
  private readonly items: string[] = [];

  keep(value: string): string {
    const index = this.items.push(value) - 1;
    return `${PLACEHOLDER_PREFIX}${index}${PLACEHOLDER_SUFFIX}`;
  }

  restore(text: string): string {
    let out = text;
    // A stashed heading may itself contain a stashed inline-code span.
    for (let pass = 0; pass < 5 && out.includes(PLACEHOLDER_PREFIX); pass++) {
      out = out.replace(/\u0000(\d+)\u0000/g, (whole, index: string) => {
        const value = this.items[Number(index)];
        return value ?? whole;
      });
    }
    return out;
  }
}

export function markdownToWhatsApp(input: string): string {
  if (input === "") {
    return "";
  }
  const stash = new Stash();

  // 1. Code first: everything inside it is off limits.
  let text = input.replace(FENCED_CODE_RE, (block) => stash.keep(block));
  text = text.replace(INLINE_CODE_RE, (span) => stash.keep(span));

  // 2. Headings become bold lines; inner emphasis markers are dropped so we never
  //    produce `*The *big* one*`. The result is stashed: it is already WA syntax.
  text = text.replace(HEADER_RE, (_whole, _hashes: string, body: string) =>
    stash.keep(`*${stripEmphasis(body).trim()}*`)
  );

  // 3. Links, bullets: structural rewrites.
  text = text.replace(LINK_RE, (_whole, label: string, url: string) =>
    label.trim() === "" ? url : `${label} (${url})`
  );
  text = text.replace(BULLET_RE, (_whole, indent: string) => `${indent}• `);

  // 4. Emphasis: strike, then italic, then bold (italic before bold, see header).
  text = text.replace(STRIKE_RE, (_whole, body: string) => `~${body}~`);
  // `***both***` is already WA syntax once rewritten, so it is stashed rather than
  // handed to the italic pass (which would turn `*_x_*` into `__x__`).
  text = text.replace(BOLD_ITALIC_RE, (_whole, body: string) => stash.keep(`*_${body}_*`));
  text = text.replace(ITALIC_STAR_RE, (_whole, body: string) => `_${body}_`);
  text = text.replace(BOLD_STAR_RE, (_whole, body: string) => `*${body}*`);
  text = text.replace(BOLD_UNDERSCORE_RE, (_whole, body: string) => `*${body}*`);

  return stash.restore(text);
}
