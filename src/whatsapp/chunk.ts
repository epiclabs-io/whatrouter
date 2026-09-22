/**
 * Splits an outbound message into WhatsApp-sized pieces.
 *
 * Preference order for a split point: the last newline before the limit, then the
 * last space, then a hard cut. A chunk that would leave a ``` fence open gets the
 * fence closed and the next chunk reopens it, so neither half renders as prose.
 */

export const WHATSAPP_MAX_MESSAGE_CHARS = 4096;

const FENCE = '```';
const FENCE_CLOSE = '\n```';
const FENCE_REOPEN = '```\n';

function countFences(text: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(FENCE, from);
    if (at === -1) return count;
    count += 1;
    from = at + FENCE.length;
  }
}

/** Where to cut `text` so the head is at most `budget` chars, and what to skip. */
function findCut(text: string, budget: number): { end: number; next: number } {
  const limit = Math.max(1, Math.min(budget, text.length));
  if (text.length <= limit) return { end: text.length, next: text.length };

  const window = text.slice(0, limit);
  const newline = window.lastIndexOf('\n');
  if (newline > 0) return { end: newline, next: newline + 1 };
  const space = window.lastIndexOf(' ');
  if (space > 0) return { end: space, next: space + 1 };
  return { end: limit, next: limit };
}

export function chunkText(text: string, max: number = WHATSAPP_MAX_MESSAGE_CHARS): string[] {
  if (text === '') return [];
  const limit = Math.max(8, max);
  if (text.length <= limit && countFences(text) % 2 === 0) return [text];

  const chunks: string[] = [];
  let rest = text;
  let reopenFence = false;

  while (rest !== '') {
    const prefix = reopenFence ? FENCE_REOPEN : '';
    if (prefix.length + rest.length <= limit) {
      chunks.push(prefix + rest);
      break;
    }

    let cut = findCut(rest, limit - prefix.length);
    let head = rest.slice(0, cut.end);
    let suffix = '';

    if (countFences(prefix + head) % 2 === 1) {
      // Leave room for the closing fence and re-cut; the new head may well be
      // balanced (the split moved back out of the block), so re-check.
      cut = findCut(rest, limit - prefix.length - FENCE_CLOSE.length);
      head = rest.slice(0, cut.end);
      if (countFences(prefix + head) % 2 === 1) suffix = FENCE_CLOSE;
    }

    chunks.push(prefix + head + suffix);
    reopenFence = suffix !== '';
    rest = rest.slice(cut.next);
  }

  return chunks;
}
