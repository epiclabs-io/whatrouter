import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildDescriptor } from '../../src/relay/descriptor.js';
import { Session } from '../../src/relay/session.js';
import type {
  ConnectorFrame,
  GatewayFrame,
  InboundFrame,
  OutboundAction,
  OutboundResult,
} from '../../src/relay/frames.js';
import { openStore, type Store } from '../../src/store/db.js';
import { silentLogger, testConfig, testEvent } from '../helpers/relay.js';

const temps: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
  while (temps.length > 0) rmSync(temps.pop() as string, { recursive: true, force: true });
});

interface Harness {
  store: Store;
  sent: ConnectorFrame[];
  session: Session;
  execute: ReturnType<typeof vi.fn>;
  inbound: () => InboundFrame[];
}

function harness(
  execute: (action: OutboundAction, platform: string | undefined) => Promise<OutboundResult> = async () => ({
    success: true,
  }),
): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'whatrouter-session-'));
  temps.push(dir);
  const store = openStore(':memory:', { mediaDir: join(dir, 'media') });
  stores.push(store);
  const sent: ConnectorFrame[] = [];
  const spy = vi.fn(execute);
  const session = new Session({
    profile: 'work',
    store,
    descriptor: buildDescriptor(testConfig()),
    send: (frame) => sent.push(frame),
    execute: spy,
    log: silentLogger(),
  });
  return {
    store,
    sent,
    session,
    execute: spy,
    inbound: () => sent.filter((f): f is InboundFrame => f.type === 'inbound'),
  };
}

const hello: GatewayFrame = { type: 'hello', platform: 'whatsapp', botId: '34600000000' };

describe('before hello', () => {
  it('buffers everything and sends nothing', async () => {
    const h = harness();
    h.session.deliver(testEvent('one'));
    h.session.deliver(testEvent('two'));
    expect(h.sent).toEqual([]);
    expect(h.store.buffer.count('work')).toBe(2);
    expect(h.session.helloed).toBe(false);
    expect(h.session.liveOk).toBe(false);
    await Promise.resolve();
  });
});

describe('hello', () => {
  it('answers with the descriptor and starts an ack-gated drain in order', async () => {
    const h = harness();
    h.session.deliver(testEvent('one'));
    h.session.deliver(testEvent('two'));

    await h.session.handleFrame(hello);
    expect(h.sent[0]).toEqual({ type: 'descriptor', descriptor: buildDescriptor(testConfig()) });
    // Only the oldest row goes out; the next waits for its ack.
    expect(h.inbound()).toHaveLength(1);
    const first = h.inbound()[0];
    expect(first?.event.text).toBe('one');
    expect(first?.bufferId).toBe(String(h.session.pending));

    await h.session.handleFrame({ type: 'inbound_ack', bufferId: first?.bufferId ?? '' });
    expect(h.inbound()).toHaveLength(2);
    expect(h.inbound()[1]?.event.text).toBe('two');
    expect(h.store.buffer.count('work')).toBe(1);

    await h.session.handleFrame({
      type: 'inbound_ack',
      bufferId: h.inbound()[1]?.bufferId ?? '',
    });
    expect(h.store.buffer.count('work')).toBe(0);
    expect(h.session.pending).toBeNull();
    expect(h.session.liveOk).toBe(true);
  });

  it('sends one descriptor per hello but pumps only on the first', async () => {
    const h = harness();
    h.session.deliver(testEvent('one'));
    await h.session.handleFrame(hello);
    await h.session.handleFrame({ type: 'hello', platform: 'relay' });
    expect(h.sent.filter((f) => f.type === 'descriptor')).toHaveLength(2);
    expect(h.inbound()).toHaveLength(1);
  });

  it('still answers a hello for an unexpected platform', async () => {
    const h = harness();
    await h.session.handleFrame({ type: 'hello', platform: 'discord' });
    expect(h.sent[0]?.type).toBe('descriptor');
  });

  it('reports the fronted identity', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatrouter-session-'));
    temps.push(dir);
    const store = openStore(':memory:', { mediaDir: join(dir, 'media') });
    stores.push(store);
    const onIdentity = vi.fn();
    const session = new Session({
      profile: 'work',
      store,
      descriptor: buildDescriptor(testConfig()),
      send: () => undefined,
      execute: async () => ({ success: true }),
      log: silentLogger(),
      onIdentity,
    });
    await session.handleFrame(hello);
    expect(onIdentity).toHaveBeenCalledWith('whatsapp', '34600000000');
  });
});

describe('acks', () => {
  it('ignores an ack that does not match the in-flight bufferId', async () => {
    const h = harness();
    h.session.deliver(testEvent('one'));
    h.session.deliver(testEvent('two'));
    await h.session.handleFrame(hello);
    const pending = h.session.pending;

    await h.session.handleFrame({ type: 'inbound_ack', bufferId: '9999' });
    expect(h.session.pending).toBe(pending);
    expect(h.inbound()).toHaveLength(1);
    expect(h.store.buffer.count('work')).toBe(2);
  });

  it('ignores an ack when nothing is in flight', async () => {
    const h = harness();
    await h.session.handleFrame(hello);
    await h.session.handleFrame({ type: 'inbound_ack', bufferId: '1' });
    expect(h.session.pending).toBeNull();
    expect(h.session.liveOk).toBe(true);
  });
});

describe('live delivery', () => {
  it('sends without a bufferId once the buffer has drained', async () => {
    const h = harness();
    await h.session.handleFrame(hello);
    expect(h.session.liveOk).toBe(true);

    h.session.deliver(testEvent('live'));
    expect(h.inbound()).toHaveLength(1);
    expect(h.inbound()[0]?.bufferId).toBeUndefined();
    expect(h.store.buffer.count('work')).toBe(0);
  });

  it('falls back to the buffer while a replay is in flight', async () => {
    const h = harness();
    h.session.deliver(testEvent('buffered'));
    await h.session.handleFrame(hello);
    expect(h.session.pending).not.toBeNull();

    h.session.deliver(testEvent('while-replaying'));
    expect(h.inbound()).toHaveLength(1);
    expect(h.store.buffer.count('work')).toBe(2);
  });
});

describe('going_idle', () => {
  it('flips durably before acking and buffers afterwards', async () => {
    const h = harness();
    await h.session.handleFrame(hello);
    expect(h.session.liveOk).toBe(true);

    await h.session.handleFrame({ type: 'going_idle' });
    expect(h.store.buffer.isBufferedOnly('work')).toBe(true);
    expect(h.sent.at(-1)).toEqual({ type: 'going_idle_ack' });
    expect(h.session.idleFlipped).toBe(true);
    expect(h.session.liveOk).toBe(false);

    h.session.deliver(testEvent('after-idle'));
    h.session.deliver(testEvent('after-idle-2'));
    expect(h.inbound()).toHaveLength(0);
    expect(h.store.buffer.count('work')).toBe(2);
  });

  it('is cleared by a drain on the next session', async () => {
    const h = harness();
    await h.session.handleFrame(hello);
    await h.session.handleFrame({ type: 'going_idle' });
    h.session.deliver(testEvent('queued'));
    h.session.close();

    // A fresh session over the same store: the durable flip must not block the drain.
    const sent: ConnectorFrame[] = [];
    const next = new Session({
      profile: 'work',
      store: h.store,
      descriptor: buildDescriptor(testConfig()),
      send: (f) => sent.push(f),
      execute: async () => ({ success: true }),
      log: silentLogger(),
    });
    await next.handleFrame(hello);
    const replayed = sent.filter((f): f is InboundFrame => f.type === 'inbound');
    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.bufferId).toBe(String(next.pending));

    await next.handleFrame({ type: 'inbound_ack', bufferId: replayed[0]?.bufferId ?? '' });
    expect(h.store.buffer.isBufferedOnly('work')).toBe(false);
    expect(next.liveOk).toBe(true);
  });
});

describe('outbound', () => {
  it('answers with the executor result under the same requestId', async () => {
    const h = harness(async () => ({ success: true, message_id: 'wa-42' }));
    await h.session.handleFrame({
      type: 'outbound',
      requestId: 'req-1',
      action: { op: 'send', chat_id: 'c', content: 'hi' },
    });
    await h.session.settled();
    expect(h.sent.at(-1)).toEqual({
      type: 'outbound_result',
      requestId: 'req-1',
      result: { success: true, message_id: 'wa-42' },
    });
  });

  it('turns a throwing executor into a structured failure', async () => {
    const h = harness(async () => {
      throw new Error('socket is closed');
    });
    await h.session.handleFrame({
      type: 'outbound',
      requestId: 'req-2',
      action: { op: 'send', chat_id: 'c', content: 'hi' },
    });
    await h.session.settled();
    expect(h.sent.at(-1)).toEqual({
      type: 'outbound_result',
      requestId: 'req-2',
      result: { success: false, error: 'socket is closed' },
    });
  });

  it('refuses a platform we do not front without calling the executor', async () => {
    const h = harness();
    await h.session.handleFrame({
      type: 'outbound',
      requestId: 'req-3',
      action: { op: 'send', chat_id: 'c', content: 'hi' },
      platform: 'discord',
    });
    await h.session.settled();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.sent.at(-1)).toEqual({
      type: 'outbound_result',
      requestId: 'req-3',
      result: { success: false, error: 'platform not fronted' },
    });
  });

  it('does not block inbound processing while an action runs', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness(async () => {
      await gate;
      return { success: true };
    });
    h.session.deliver(testEvent('queued'));

    await h.session.handleFrame({
      type: 'outbound',
      requestId: 'slow',
      action: { op: 'send', chat_id: 'c', content: 'hi' },
    });
    // The hello is handled (and the buffer drains) even though the send is stuck.
    await h.session.handleFrame(hello);
    expect(h.inbound()).toHaveLength(1);
    expect(h.sent.some((f) => f.type === 'outbound_result')).toBe(false);

    release?.();
    await h.session.settled();
    expect(h.sent.at(-1)).toMatchObject({ type: 'outbound_result', requestId: 'slow' });
  });

  it('passes the platform through to the executor when it is whatsapp', async () => {
    const h = harness();
    await h.session.handleFrame({
      type: 'outbound',
      requestId: 'req-4',
      action: { op: 'typing', chat_id: 'c' },
      platform: 'whatsapp',
    });
    await h.session.settled();
    expect(h.execute).toHaveBeenCalledWith({ op: 'typing', chat_id: 'c' }, 'whatsapp');
  });
});

describe('other frames', () => {
  it('logs interrupts and ignores unknown types', async () => {
    const h = harness();
    await h.session.handleFrame({ type: 'interrupt', session_key: 'abc', reason: 'user' });
    await h.session.handleFrame({ type: 'from_the_future' } as unknown as GatewayFrame);
    expect(h.sent).toEqual([]);
  });

  it('buffers deliveries after close instead of emitting them', async () => {
    const h = harness();
    await h.session.handleFrame(hello);
    h.session.close();
    h.session.deliver(testEvent('post-close'));
    expect(h.inbound()).toHaveLength(0);
    expect(h.store.buffer.count('work')).toBe(1);
  });
});
