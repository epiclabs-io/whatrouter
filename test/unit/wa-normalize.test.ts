import { describe, expect, it, vi } from 'vitest';
import type { WAMessage } from '@whiskeysockets/baileys';
import { normalizeInbound, toUnixSeconds } from '../../src/whatsapp/normalize.js';
import { BOT_IDS, BOT_LID, BOT_PN, fixture, silentLog } from '../helpers/wa.js';

const log = silentLog();

async function normalize(
  name: string,
  extra: Partial<Parameters<typeof normalizeInbound>[1]> = {},
): ReturnType<typeof normalizeInbound> {
  return await normalizeInbound(fixture(name), { botIds: BOT_IDS, log, ...extra });
}

describe('normalizeInbound: dropped messages', () => {
  it('drops our own messages, broadcasts and protocol payloads', async () => {
    expect(await normalize('from-me')).toBeNull();
    expect(await normalize('broadcast')).toBeNull();
    expect(await normalize('protocol')).toBeNull();
  });

  it('drops a message with no payload at all', async () => {
    const msg = { key: { remoteJid: '1@s.whatsapp.net', id: 'x', fromMe: false } } as WAMessage;
    expect(await normalizeInbound(msg, { botIds: BOT_IDS, log })).toBeNull();
  });

  it('drops a reaction-only payload', async () => {
    const msg = {
      key: { remoteJid: '1@s.whatsapp.net', id: 'x', fromMe: false },
      message: { reactionMessage: { text: '👍', key: { id: 'y' } } },
    } as unknown as WAMessage;
    expect(await normalizeInbound(msg, { botIds: BOT_IDS, log })).toBeNull();
  });
});

describe('normalizeInbound: direct messages', () => {
  it('maps a plain conversation', async () => {
    const m = await normalize('dm-conversation');
    expect(m).not.toBeNull();
    expect(m).toMatchObject({
      messageId: '3EB0C767D82B0F3A1111',
      chatId: '34611111111@s.whatsapp.net',
      chatIdRaw: '34611111111@s.whatsapp.net',
      chatType: 'dm',
      chatName: 'Alice',
      senderId: '34611111111@s.whatsapp.net',
      senderIdAlt: null,
      senderName: 'Alice',
      text: 'Hello there',
      kind: 'text',
      timestamp: 1758000000,
      mentionsBot: false,
      mentionedIds: [],
      quoted: null,
      media: null,
      downloadFailed: false,
    });
  });

  it('keeps a leading slash so the router can mark it as a command', async () => {
    const m = await normalize('command-text');
    expect(m?.text).toBe('/status please');
    expect(m?.kind).toBe('text');
  });

  it('extracts quote, mention and bot authorship', async () => {
    const m = await normalize('dm-extended-text-quote');
    expect(m?.text).toBe('@34600000099 what do you think about this?');
    expect(m?.mentionedIds).toEqual([BOT_PN]);
    expect(m?.mentionsBot).toBe(true);
    expect(m?.quoted).toEqual({
      messageId: 'BAE5F1B8C0DE0001',
      text: 'Earlier answer from the bot',
      senderId: BOT_PN,
      isFromBot: true,
    });
  });

  it('prefers the phone form when the chat is addressed by LID', async () => {
    const m = await normalize('dm-lid-remote');
    expect(m?.senderId).toBe('34622222222@s.whatsapp.net');
    expect(m?.senderIdAlt).toBe('99988877766655@lid');
    expect(m?.chatId).toBe('34622222222@s.whatsapp.net');
    expect(m?.chatIdRaw).toBe('99988877766655@lid');
  });

  it('falls back to the lid mapping when no alt is present', async () => {
    const resolvePn = vi.fn(async () => '34633333333@s.whatsapp.net');
    const m = await normalize('dm-lid-unmapped', { resolvePn });
    expect(resolvePn).toHaveBeenCalledWith('12345678901234@lid');
    expect(m?.senderId).toBe('34633333333@s.whatsapp.net');
    expect(m?.senderIdAlt).toBe('12345678901234@lid');
  });

  it('keeps the lid as the canonical id when nothing resolves it', async () => {
    const m = await normalize('dm-lid-unmapped', { resolvePn: async () => null });
    expect(m?.senderId).toBe('12345678901234@lid');
    expect(m?.senderIdAlt).toBeNull();
  });

  it('survives a throwing lid resolver', async () => {
    const m = await normalize('dm-lid-unmapped', {
      resolvePn: async () => {
        throw new Error('signal store is closed');
      },
    });
    expect(m?.senderId).toBe('12345678901234@lid');
  });
});

describe('normalizeInbound: groups', () => {
  it('canonicalizes a LID participant through participantAlt', async () => {
    const m = await normalize('group-lid-participant', {
      groupSubject: async () => 'Weekend plans',
    });
    expect(m?.chatType).toBe('group');
    expect(m?.chatId).toBe('120363001234567890@g.us');
    expect(m?.chatName).toBe('Weekend plans');
    expect(m?.senderId).toBe('34622222222@s.whatsapp.net');
    expect(m?.senderIdAlt).toBe('99988877766655@lid');
    expect(m?.mentionedIds).toEqual([BOT_LID]);
    expect(m?.mentionsBot).toBe(true);
  });

  it('falls back to the group digits when the subject is unknown', async () => {
    const m = await normalize('group-lid-participant');
    expect(m?.chatName).toBe('120363001234567890');
  });

  it('unwraps an ephemeral envelope', async () => {
    const m = await normalize('ephemeral-text', { groupSubject: async () => 'Weekend plans' });
    expect(m?.kind).toBe('text');
    expect(m?.text).toBe('this one disappears in a week');
    expect(m?.senderId).toBe('34622222222@s.whatsapp.net');
  });
});

describe('normalizeInbound: media', () => {
  it('downloads an image and keeps the caption', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const download = vi.fn(async () => bytes);
    const m = await normalize('image-caption', { download });
    expect(download).toHaveBeenCalledOnce();
    expect(m?.kind).toBe('image');
    expect(m?.text).toBe('look at this sunset');
    expect(m?.media).toEqual({
      kind: 'image',
      mime: 'image/jpeg',
      bytes,
      size: 4,
      caption: 'look at this sunset',
    });
  });

  it('marks a ptt audio as a voice note', async () => {
    const m = await normalize('audio-ptt', { download: async () => new Uint8Array(8) });
    expect(m?.kind).toBe('voice');
    expect(m?.media?.kind).toBe('voice');
    expect(m?.media?.mime).toBe('audio/ogg; codecs=opus');
    expect(m?.text).toBe('');
  });

  it('carries the document filename in the media and the text', async () => {
    const m = await normalize('document', { download: async () => new Uint8Array(16) });
    expect(m?.kind).toBe('document');
    expect(m?.media?.filename).toBe('invoice-2026-09.pdf');
    expect(m?.media?.mime).toBe('application/pdf');
    expect(m?.text).toBe('[Document: invoice-2026-09.pdf]');
  });

  it('maps a sticker', async () => {
    const m = await normalize('sticker', { download: async () => new Uint8Array(2) });
    expect(m?.kind).toBe('sticker');
    expect(m?.media?.kind).toBe('sticker');
    expect(m?.media?.mime).toBe('image/webp');
  });

  it('leaves media null when no downloader is wired up', async () => {
    const m = await normalize('image-caption');
    expect(m?.media).toBeNull();
    expect(m?.downloadFailed).toBe(false);
  });

  it('delivers the message with a note when the download fails', async () => {
    const m = await normalize('image-caption', {
      download: async () => {
        throw new Error('410 gone');
      },
    });
    expect(m).not.toBeNull();
    expect(m?.media).toBeNull();
    expect(m?.downloadFailed).toBe(true);
    expect(m?.text).toBe('look at this sunset\n[image could not be downloaded]');
  });
});

describe('normalizeInbound: cards', () => {
  it('renders a location as bracketed text', async () => {
    const m = await normalize('location');
    expect(m?.kind).toBe('location');
    expect(m?.text).toBe('[Location: Placa de Catalunya 41.3874,2.1686]');
  });

  it('renders a contact and a poll as bracketed text', async () => {
    const contact = {
      key: { remoteJid: '34611111111@s.whatsapp.net', id: 'c1', fromMe: false },
      messageTimestamp: 1758000000,
      message: {
        contactMessage: {
          displayName: 'Carol',
          vcard: 'BEGIN:VCARD\nVERSION:3.0\nFN:Carol\nTEL;type=CELL:+34 655 000 111\nEND:VCARD',
        },
      },
    } as unknown as WAMessage;
    const poll = {
      key: { remoteJid: '34611111111@s.whatsapp.net', id: 'p1', fromMe: false },
      messageTimestamp: 1758000000,
      message: {
        pollCreationMessageV3: {
          name: 'Lunch?',
          options: [{ optionName: 'Pizza' }, { optionName: 'Sushi' }],
        },
      },
    } as unknown as WAMessage;

    const c = await normalizeInbound(contact, { botIds: BOT_IDS, log });
    expect(c?.kind).toBe('other');
    expect(c?.text).toBe('[Contact: Carol +34 655 000 111]');

    const p = await normalizeInbound(poll, { botIds: BOT_IDS, log });
    expect(p?.kind).toBe('other');
    expect(p?.text).toBe('[Poll: Lunch? Options: Pizza, Sushi]');
  });
});

describe('toUnixSeconds', () => {
  it('accepts numbers, strings and Long-shaped values', () => {
    expect(toUnixSeconds(1758000000)).toBe(1758000000);
    expect(toUnixSeconds('1758000000')).toBe(1758000000);
    expect(toUnixSeconds({ low: 1758000000, high: 0, unsigned: false })).toBe(1758000000);
    expect(toUnixSeconds({ toNumber: () => 1758000001 })).toBe(1758000001);
  });
});
