/**
 * The relevance gate: should this message wake the agent at all?
 *
 * DMs always do. Groups are noisy, so by default only messages that *address*
 * the bot get through (an @mention, a reply to one of our messages, or a slash
 * command). Precedence, per docs/DESIGN.md:
 *
 *   route.require_mention  >  gateway policy.requireAddress  >  true
 *
 * A group route may also pin `allowed_senders`; anyone else is dropped before
 * the mention check even runs.
 */
import { sameUser } from '../whatsapp/jid.js';
import type { Route } from '../config/schema.js';
import type { RelayPolicy } from '../store/policy.js';
import type { InboundMessage } from '../whatsapp/port.js';

export type RelevanceDecision = { deliver: true } | { deliver: false; reason: string };

const DELIVER: RelevanceDecision = { deliver: true };

/** Does the text look like a command (`/help`)? Leading whitespace is ignored. */
export function isCommandText(text: string): boolean {
  return text.trimStart().startsWith('/');
}

export function shouldDeliver(
  m: InboundMessage,
  route: Route | null,
  policy: RelayPolicy | null,
): RelevanceDecision {
  if (m.chatType === 'dm') return DELIVER;

  const groupRoute = route !== null && route.kind === 'group' ? route : null;

  const allowed = groupRoute?.allowedSenders;
  if (allowed !== undefined) {
    const isAllowed = allowed.some(
      (a) =>
        sameUser(a, m.senderId) ||
        (m.senderIdAlt !== null && m.senderIdAlt !== '' && sameUser(a, m.senderIdAlt)),
    );
    if (!isAllowed) return { deliver: false, reason: 'sender_not_allowed' };
  }

  const requireMention = groupRoute?.requireMention ?? policy?.requireAddress ?? true;
  if (!requireMention) return DELIVER;

  if (m.mentionsBot || m.quoted?.isFromBot === true || isCommandText(m.text)) return DELIVER;
  return { deliver: false, reason: 'not_addressed' };
}
