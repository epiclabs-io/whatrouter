import { rm } from 'node:fs/promises';
import { Boom } from '@hapi/boom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBaileysClient, backoffMs, disconnectStatus } from '../../src/whatsapp/baileys-client.js';
import type { InboundMessage } from '../../src/whatsapp/port.js';
import {
  BOT_LID,
  BOT_PN,
  createFakeSocket,
  fixture,
  makeEmptyAuthDir,
  makeRegisteredAuthDir,
  silentLog,
  testConfig,
  type FakeSocket,
} from '../helpers/wa.js';

const dirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

interface Harness {
  client: ReturnType<typeof createBaileysClient>;
  sockets: FakeSocket[];
  received: InboundMessage[];
  dir: string;
}

async function connected(configOverrides = {}): Promise<Harness> {
  const dir = await makeRegisteredAuthDir();
  dirs.push(dir);
  const sockets: FakeSocket[] = [];
  const client = createBaileysClient({
    config: testConfig(configOverrides),
    log: silentLog(),
    authDir: dir,
    makeSocket: () => {
      const fake = createFakeSocket();
      fake.setUser({ id: '34600000099:12@s.whatsapp.net', lid: '111222333444555:12@lid' });
      sockets.push(fake);
      return fake.socket;
    },
  });

  const received: InboundMessage[] = [];
  client.onMessage(async (m) => {
    received.push(m);
  });

  await client.start();
  sockets[0]?.ev.emit('connection.update', { connection: 'open' });
  return { client, sockets, received, dir };
}

describe('createBaileysClient: startup', () => {
  it('stays unpaired and never opens a socket when the credentials are not registered', async () => {
    const dir = await makeEmptyAuthDir();
    dirs.push(dir);
    const makeSocket = vi.fn();
    const client = createBaileysClient({
      config: testConfig(),
      log: silentLog(),
      authDir: dir,
      makeSocket: makeSocket as never,
    });

    await client.start();

    expect(makeSocket).not.toHaveBeenCalled();
    expect(client.state()).toBe('unpaired');
    expect(client.authDir()).toBe(dir);
  });

  it('caches both bot ids on open', async () => {
    const states: string[] = [];
    const dir = await makeRegisteredAuthDir();
    dirs.push(dir);
    const sockets: FakeSocket[] = [];
    const client = createBaileysClient({
      config: testConfig(),
      log: silentLog(),
      authDir: dir,
      makeSocket: () => {
        const fake = createFakeSocket();
        fake.setUser({ id: '34600000099:12@s.whatsapp.net', lid: '111222333444555:12@lid' });
        sockets.push(fake);
        return fake.socket;
      },
    });
    client.onStateChange((s) => states.push(s));

    await client.start();
    expect(sockets).toHaveLength(1);
    expect(client.state()).toBe('connecting');

    sockets[0]?.ev.emit('connection.update', { connection: 'open' });
    expect(client.state()).toBe('connected');
    expect(client.botIds()).toEqual([BOT_PN, BOT_LID]);
    expect(states).toEqual(['connecting', 'connected']);
  });
});

describe('createBaileysClient: inbound', () => {
  it('hands the handler a normalized message', async () => {
    const h = await connected();
    h.sockets[0]?.ev.emit('messages.upsert', { messages: [fixture('dm-conversation')], type: 'notify' });

    await vi.waitFor(() => expect(h.received).toHaveLength(1));
    expect(h.received[0]).toMatchObject({
      chatId: '34611111111@s.whatsapp.net',
      chatType: 'dm',
      text: 'Hello there',
      kind: 'text',
    });
  });

  it('ignores upserts that are not notify/append', async () => {
    const h = await connected();
    h.sockets[0]?.ev.emit('messages.upsert', {
      messages: [fixture('dm-conversation')],
      type: 'prepend',
    });
    h.sockets[0]?.ev.emit('messages.upsert', {
      messages: [fixture('command-text')],
      type: 'append',
    });

    await vi.waitFor(() => expect(h.received).toHaveLength(1));
    expect(h.received[0]?.text).toBe('/status please');
  });

  it('drops the echo of a message we sent ourselves', async () => {
    const h = await connected();
    await h.client.sendText('34611111111@s.whatsapp.net', 'from the bot');
    const sentId = h.sockets[0]?.sends[0] !== undefined ? 'sent-1' : '';

    const echo = fixture('dm-conversation');
    echo.key.id = sentId;
    h.sockets[0]?.ev.emit('messages.upsert', { messages: [echo], type: 'notify' });
    h.sockets[0]?.ev.emit('messages.upsert', { messages: [fixture('command-text')], type: 'notify' });

    await vi.waitFor(() => expect(h.received).toHaveLength(1));
    expect(h.received[0]?.text).toBe('/status please');
  });

  it('survives a throwing handler', async () => {
    const h = await connected();
    h.client.onMessage(async () => {
      throw new Error('gateway exploded');
    });
    h.sockets[0]?.ev.emit('messages.upsert', { messages: [fixture('dm-conversation')], type: 'notify' });

    // No unhandled rejection, socket still usable.
    await vi.waitFor(() => expect(h.sockets[0]?.ev.listenerCount('messages.upsert')).toBe(1));
    await expect(h.client.sendText('34611111111@s.whatsapp.net', 'still here')).resolves.toEqual({
      messageId: 'sent-1',
    });
  });

  it('sends a read receipt only when configured', async () => {
    const off = await connected();
    off.sockets[0]?.ev.emit('messages.upsert', { messages: [fixture('dm-conversation')], type: 'notify' });
    await vi.waitFor(() => expect(off.received).toHaveLength(1));
    expect(off.sockets[0]?.reads).toHaveLength(0);

    const on = await connected({ sendReadReceipts: true });
    on.sockets[0]?.ev.emit('messages.upsert', { messages: [fixture('dm-conversation')], type: 'notify' });
    await vi.waitFor(() => expect(on.sockets[0]?.reads).toHaveLength(1));
    expect(on.sockets[0]?.reads[0]?.[0]?.id).toBe('3EB0C767D82B0F3A1111');
  });
});

describe('createBaileysClient: outbound', () => {
  it('converts markdown and returns the id of the last chunk', async () => {
    const h = await connected();
    const result = await h.client.sendText('34611111111@s.whatsapp.net', '**hi** there');

    expect(h.sockets[0]?.sends).toHaveLength(1);
    expect(h.sockets[0]?.sends[0]?.content).toEqual({ text: '*hi* there' });
    expect(result).toEqual({ messageId: 'sent-1' });
  });

  it('chunks a long message and quotes only the first chunk', async () => {
    const h = await connected();
    h.sockets[0]?.ev.emit('messages.upsert', { messages: [fixture('dm-conversation')], type: 'notify' });
    await vi.waitFor(() => expect(h.received).toHaveLength(1));

    const result = await h.client.sendText('34611111111@s.whatsapp.net', 'x'.repeat(5000), {
      replyTo: '3EB0C767D82B0F3A1111',
    });

    const sends = h.sockets[0]?.sends ?? [];
    expect(sends).toHaveLength(2);
    expect((sends[0]?.content as { text: string }).text).toHaveLength(4096);
    expect((sends[1]?.content as { text: string }).text).toHaveLength(904);
    expect(sends[0]?.options?.quoted?.key?.id).toBe('3EB0C767D82B0F3A1111');
    expect(sends[1]?.options?.quoted).toBeUndefined();
    expect(result).toEqual({ messageId: 'sent-2' });
  });

  it('sends to the raw jid last seen for a canonical chat id', async () => {
    const h = await connected();
    h.sockets[0]?.ev.emit('messages.upsert', { messages: [fixture('dm-lid-remote')], type: 'notify' });
    await vi.waitFor(() => expect(h.received).toHaveLength(1));

    await h.client.sendText('34622222222@s.whatsapp.net', 'hello back');
    expect(h.sockets[0]?.sends[0]?.jid).toBe('99988877766655@lid');
  });

  it('edits with a fromMe key and pushes overflow out as new messages', async () => {
    const h = await connected();
    await h.client.editText('34611111111@s.whatsapp.net', 'ABC', 'corrected');

    const content = h.sockets[0]?.sends[0]?.content as { text: string; edit: { id: string; fromMe: boolean } };
    expect(content.text).toBe('corrected');
    expect(content.edit).toEqual({
      id: 'ABC',
      fromMe: true,
      remoteJid: '34611111111@s.whatsapp.net',
    });
  });

  it('deletes, reacts and updates presence', async () => {
    const h = await connected();
    const chat = '34611111111@s.whatsapp.net';

    await h.client.deleteMessage(chat, 'DEL1');
    await h.client.react(chat, 'REACT1', '👍');
    await h.client.typing(chat, true);
    await h.client.typing(chat, false);

    const sends = h.sockets[0]?.sends ?? [];
    expect(sends[0]?.content).toEqual({ delete: { id: 'DEL1', remoteJid: chat, fromMe: true } });
    expect(sends[1]?.content).toEqual({
      react: { text: '👍', key: { id: 'REACT1', remoteJid: chat, fromMe: false } },
    });
    expect(h.sockets[0]?.presence).toEqual([
      { type: 'composing', jid: chat },
      { type: 'paused', jid: chat },
    ]);
  });

  it('reacts with the stored key when the message is known', async () => {
    const h = await connected();
    h.sockets[0]?.ev.emit('messages.upsert', {
      messages: [fixture('group-lid-participant')],
      type: 'notify',
    });
    await vi.waitFor(() => expect(h.received).toHaveLength(1));

    await h.client.react('120363001234567890@g.us', '3EB0C767D82B0F3A3333', '🎉');
    const content = h.sockets[0]?.sends[0]?.content as { react: { key: { participant?: string } } };
    expect(content.react.key.participant).toBe('99988877766655@lid');
  });

  it('sends media', async () => {
    const h = await connected();
    const result = await h.client.sendMedia('34611111111@s.whatsapp.net', {
      kind: 'image',
      bytes: new Uint8Array([1, 2, 3]),
      mime: 'image/png',
      caption: 'shot',
    });

    expect(result).toEqual({ messageId: 'sent-1' });
    expect(h.sockets[0]?.sends[0]?.content).toMatchObject({ mimetype: 'image/png', caption: 'shot' });
  });

  it('answers chat info for groups and dms', async () => {
    const h = await connected();
    h.sockets[0]?.ev.emit('messages.upsert', { messages: [fixture('dm-conversation')], type: 'notify' });
    await vi.waitFor(() => expect(h.received).toHaveLength(1));

    expect(await h.client.chatInfo('120363001234567890@g.us')).toEqual({
      name: 'Test Group',
      type: 'group',
    });
    expect(await h.client.chatInfo('34611111111@s.whatsapp.net')).toEqual({
      name: 'Alice',
      type: 'dm',
    });
    expect(await h.client.chatInfo('34699999999@s.whatsapp.net')).toEqual({
      name: '34699999999',
      type: 'dm',
    });
  });

  it('refuses to send when the socket is down', async () => {
    const h = await connected();
    await h.client.stop();
    await expect(h.client.sendText('34611111111@s.whatsapp.net', 'hi')).rejects.toThrow(
      /not connected/,
    );
    expect(h.client.state()).toBe('disconnected');
  });
});

describe('createBaileysClient: reconnection', () => {
  it('goes unpaired without reconnecting when WhatsApp logs us out', async () => {
    const h = await connected();
    vi.useFakeTimers();

    h.sockets[0]?.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: new Boom('logged out', { statusCode: 401 }), date: new Date() },
    });

    expect(h.client.state()).toBe('unpaired');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.sockets).toHaveLength(1);
  });

  it('reconnects one second after a 515 restart', async () => {
    const h = await connected();
    vi.useFakeTimers();

    h.sockets[0]?.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: new Boom('restart required', { statusCode: 515 }), date: new Date() },
    });

    expect(h.client.state()).toBe('disconnected');
    await vi.advanceTimersByTimeAsync(999);
    expect(h.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(h.sockets).toHaveLength(2);
  });

  it('backs off on any other close and stops once stopped', async () => {
    const h = await connected();
    vi.useFakeTimers();

    h.sockets[0]?.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: new Boom('closed', { statusCode: 428 }), date: new Date() },
    });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(h.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(h.sockets).toHaveLength(2);

    await h.client.stop();
    h.sockets[1]?.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: new Boom('closed', { statusCode: 428 }), date: new Date() },
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.sockets).toHaveLength(2);
  });
});

describe('helpers', () => {
  it('reads the status code out of a Boom, a plain error and nothing', () => {
    expect(disconnectStatus(new Boom('x', { statusCode: 401 }))).toBe(401);
    expect(disconnectStatus(new Error('x'))).toBe(500);
    expect(disconnectStatus(undefined)).toBeUndefined();
  });

  it('doubles the backoff up to a minute', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(backoffMs)).toEqual([
      3000, 6000, 12000, 24000, 48000, 60000, 60000,
    ]);
  });
});
