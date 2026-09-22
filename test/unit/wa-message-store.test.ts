import { describe, expect, it } from 'vitest';
import type { WAMessage } from '@whiskeysockets/baileys';
import { createMessageStore } from '../../src/whatsapp/message-store.js';

function message(id: string): WAMessage {
  return {
    key: { id, remoteJid: '34611111111@s.whatsapp.net', fromMe: false },
    message: { conversation: id },
    messageTimestamp: 1758000000,
  } as WAMessage;
}

describe('createMessageStore', () => {
  it('stores and returns messages by id', () => {
    const store = createMessageStore();
    store.remember(message('a'));
    expect(store.get('a')?.message?.conversation).toBe('a');
    expect(store.get('missing')).toBeUndefined();
  });

  it('ignores a message with no id', () => {
    const store = createMessageStore();
    store.remember({ key: { remoteJid: 'x', fromMe: false } } as WAMessage);
    expect(store.size()).toBe(0);
  });

  it('evicts the least recently used message past the limit', () => {
    const store = createMessageStore(3);
    store.remember(message('a'));
    store.remember(message('b'));
    store.remember(message('c'));
    // Touching `a` makes `b` the oldest.
    expect(store.get('a')).toBeDefined();
    store.remember(message('d'));

    expect(store.size()).toBe(3);
    expect(store.get('b')).toBeUndefined();
    expect(store.get('a')).toBeDefined();
    expect(store.get('c')).toBeDefined();
    expect(store.get('d')).toBeDefined();
  });

  it('remembers our own sent ids for echo suppression, bounded', () => {
    const store = createMessageStore(2);
    store.rememberSentId('s1');
    store.rememberSentId('s2');
    expect(store.wasSentByUs('s1')).toBe(true);
    store.rememberSentId('s3');
    expect(store.wasSentByUs('s1')).toBe(false);
    expect(store.wasSentByUs('s3')).toBe(true);
    expect(store.wasSentByUs('never')).toBe(false);
  });
});
