/**
 * End-to-end over a real socket: a real `ws` client speaking NDJSON against
 * `createRelayServer` on port 0, with a real sqlite store in a temp dir.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { makeToken } from '../../src/relay/auth.js';
import { LineAssembler } from '../../src/relay/ndjson.js';
import { createRelayServer, type RelayServer } from '../../src/relay/server.js';
import type { ConnectorFrame, OutboundAction, OutboundResult } from '../../src/relay/frames.js';
import { openStore, type Store } from '../../src/store/db.js';
import type { Config, ProfileConfig } from '../../src/config/schema.js';
import { delay, silentLogger, testConfig, testEvent, testProfile } from '../helpers/relay.js';

const WORK = testProfile('work');
const HOME = testProfile('home');

interface Fixture {
  server: RelayServer;
  store: Store;
  config: Config;
  port: number;
  executed: Array<{ profile: string; action: OutboundAction; platform: string | undefined }>;
  execute: (profile: ProfileConfig, action: OutboundAction, platform?: string) => Promise<OutboundResult>;
  fetchMock: ReturnType<typeof vi.fn>;
}

let fixture: Fixture;
let tempDir: string;
const clients: RelayClient[] = [];

/** Minimal NDJSON client: collects frames, exposes waits. */
class RelayClient {
  readonly ws: WebSocket;
  readonly frames: Record<string, unknown>[] = [];
  closeInfo: { code: number; reason: string } | null = null;
  readonly #assembler = new LineAssembler();
  readonly #opened: Promise<void>;
  readonly #closed: Promise<{ code: number; reason: string }>;

  constructor(port: number, token: string | null) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/relay`, {
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    });
    this.#opened = new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', (err) => reject(err));
    });
    this.#closed = new Promise((resolve) => {
      this.ws.once('close', (code, reason) => {
        this.closeInfo = { code, reason: reason.toString('utf8') };
        resolve(this.closeInfo);
      });
    });
    this.ws.on('message', (data: Buffer) => {
      for (const line of this.#assembler.push(data.toString('utf8'))) {
        this.frames.push(JSON.parse(line) as Record<string, unknown>);
      }
    });
    this.ws.on('error', () => undefined);
    clients.push(this);
  }

  opened(): Promise<void> {
    return this.#opened;
  }

  closed(): Promise<{ code: number; reason: string }> {
    return this.#closed;
  }

  /** Sends a frame the way the gateway does (one JSON object + newline). */
  send(frame: Record<string, unknown>): void {
    this.ws.send(`${JSON.stringify(frame)}\n`);
  }

  sendRaw(text: string): void {
    this.ws.send(text);
  }

  async waitFor(
    predicate: (frame: Record<string, unknown>) => boolean,
    timeoutMs = 2000,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.frames.find(predicate);
      if (found !== undefined) return found;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for a frame; got ${JSON.stringify(this.frames)}`);
      }
      await delay(10);
    }
  }

  of(type: string): Record<string, unknown>[] {
    return this.frames.filter((f) => f.type === type);
  }

  async hello(): Promise<void> {
    await this.opened();
    this.send({ type: 'hello', platform: 'whatsapp', botId: '34600000000' });
    await this.waitFor((f) => f.type === 'descriptor');
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}

function token(profile: ProfileConfig, ttl = 300, atSeconds = Math.floor(Date.now() / 1000)): string {
  return makeToken(profile.gatewayId, profile.secret, ttl, atSeconds);
}

async function startServer(overrides: Partial<Config> = {}): Promise<Fixture> {
  const config = testConfig({ profiles: [WORK, HOME], ...overrides });
  const store = openStore(join(tempDir, 'whatrouter.sqlite'), {
    mediaDir: join(tempDir, 'media'),
    maxMediaBytes: config.media.maxBytes,
  });
  const executed: Fixture['executed'] = [];
  const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
  const execute = async (
    profile: ProfileConfig,
    action: OutboundAction,
    platform?: string,
  ): Promise<OutboundResult> => {
    executed.push({ profile: profile.name, action, platform });
    if (action.op === 'send') return { success: true, message_id: 'wa-out-1' };
    return { success: false, error: `unsupported op: ${action.op}` };
  };
  const server = createRelayServer({
    config,
    store,
    log: silentLogger(),
    execute,
    health: () => ({ status: 'ok', whatsapp: 'connected' }),
    fetchImpl: fetchMock as unknown as typeof fetch,
  });
  const { port } = await server.listen();
  return { server, store, config, port, executed, execute, fetchMock };
}

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'whatrouter-relay-'));
  fixture = await startServer();
});

afterEach(async () => {
  while (clients.length > 0) clients.pop()?.close();
  await fixture.server.close();
  fixture.store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

const base = (): string => `http://127.0.0.1:${fixture.port}`;

/** Replaces the running fixture (and its temp dir) with one for other profiles. */
async function restartWith(profiles: ProfileConfig[]): Promise<void> {
  await fixture.server.close();
  fixture.store.close();
  rmSync(tempDir, { recursive: true, force: true });
  tempDir = mkdtempSync(join(tmpdir(), 'whatrouter-relay-'));
  fixture = await startServer({ profiles });
}

describe('upgrade auth', () => {
  it('closes with 4401 unauthorized for a bad secret and sends no descriptor', async () => {
    const bad = makeToken(WORK.gatewayId, 'a-completely-different-secret-value-1234', 300);
    const client = new RelayClient(fixture.port, bad);
    const info = await client.closed();
    expect(info).toEqual({ code: 4401, reason: 'unauthorized' });
    expect(client.frames).toEqual([]);
  });

  it('closes with 4401 unauthorized for an unknown gateway id', async () => {
    const unknown = makeToken('gw-nobody', WORK.secret, 300);
    const client = new RelayClient(fixture.port, unknown);
    expect(await client.closed()).toEqual({ code: 4401, reason: 'unauthorized' });
  });

  it('closes with 4401 expired when only the TTL has passed', async () => {
    const stale = token(WORK, 300, Math.floor(Date.now() / 1000) - 1000);
    const client = new RelayClient(fixture.port, stale);
    expect(await client.closed()).toEqual({ code: 4401, reason: 'expired' });
  });

  it('closes with 4401 when no token is offered at all', async () => {
    const client = new RelayClient(fixture.port, null);
    expect(await client.closed()).toEqual({ code: 4401, reason: 'unauthorized' });
  });

  it('rejects an upgrade on any other path', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${fixture.port}/relay/nope`, {
      headers: { authorization: `Bearer ${token(WORK)}` },
    });
    const err = await new Promise<Error>((resolve) => ws.once('error', resolve));
    expect(err.message).toMatch(/400/);
  });

  it('closes the second concurrent connection with 1008', async () => {
    const first = new RelayClient(fixture.port, token(WORK));
    await first.hello();
    const second = new RelayClient(fixture.port, token(WORK));
    expect(await second.closed()).toEqual({ code: 1008, reason: 'duplicate session' });
    expect(fixture.server.isConnected('work')).toBe(true);
  });
});

describe('handshake and framing', () => {
  it('answers hello with the WhatsApp descriptor', async () => {
    const client = new RelayClient(fixture.port, token(WORK));
    await client.hello();
    const frame = client.of('descriptor')[0];
    expect(frame?.descriptor).toMatchObject({
      contract_version: 1,
      platform: 'whatsapp',
      len_unit: 'chars',
      supported_ops: ['send', 'edit', 'delete', 'typing', 'react', 'send_media', 'get_chat_info'],
    });
  });

  it('assembles a frame split across two websocket messages', async () => {
    const client = new RelayClient(fixture.port, token(WORK));
    await client.opened();
    client.sendRaw('{"type":"hello","plat');
    await delay(30);
    expect(client.frames).toEqual([]);
    client.sendRaw('form":"whatsapp"}\n');
    await client.waitFor((f) => f.type === 'descriptor');
  });

  it('handles two frames packed into one websocket message', async () => {
    const client = new RelayClient(fixture.port, token(WORK));
    await client.opened();
    client.sendRaw(
      '{"type":"hello","platform":"whatsapp"}\n{"type":"outbound","requestId":"r1","action":{"op":"send","chat_id":"c","content":"hi"}}\n',
    );
    await client.waitFor((f) => f.type === 'descriptor');
    const result = await client.waitFor((f) => f.type === 'outbound_result');
    expect(result).toMatchObject({ requestId: 'r1', result: { success: true, message_id: 'wa-out-1' } });
  });

  it('ignores a malformed line without dropping the session', async () => {
    const client = new RelayClient(fixture.port, token(WORK));
    await client.hello();
    client.sendRaw('this is not json\n');
    client.send({ type: 'outbound', requestId: 'r2', action: { op: 'send', chat_id: 'c', content: 'x' } });
    await client.waitFor((f) => f.type === 'outbound_result');
    expect(client.closeInfo).toBeNull();
  });
});

describe('delivery', () => {
  it('delivers live (no bufferId) while connected and helloed', async () => {
    const client = new RelayClient(fixture.port, token(WORK));
    await client.hello();
    expect(fixture.server.deliver('work', testEvent('live one'))).toBe('live');

    const frame = await client.waitFor((f) => f.type === 'inbound');
    expect(frame.bufferId).toBeUndefined();
    expect((frame.event as { text: string }).text).toBe('live one');
    expect(fixture.server.bufferedCount('work')).toBe(0);
  });

  it('buffers for a disconnected profile and never drops', () => {
    expect(fixture.server.deliver('home', testEvent('while away'))).toBe('buffered');
    expect(fixture.server.bufferedCount('home')).toBe(1);
    expect(fixture.server.deliver('nobody', testEvent('nowhere'))).toBe('unknown_profile');
  });

  it('acks going_idle, then buffers instead of sending', async () => {
    const client = new RelayClient(fixture.port, token(WORK));
    await client.hello();
    client.send({ type: 'going_idle' });
    await client.waitFor((f) => f.type === 'going_idle_ack');

    expect(fixture.server.deliver('work', testEvent('idle one'))).toBe('buffered');
    expect(fixture.server.deliver('work', testEvent('idle two'))).toBe('buffered');
    await delay(50);
    expect(client.of('inbound')).toHaveLength(0);
    expect(fixture.server.bufferedCount('work')).toBe(2);
  });

  it('replays in order on reconnect, exactly once', async () => {
    const first = new RelayClient(fixture.port, token(WORK));
    await first.hello();
    first.send({ type: 'going_idle' });
    await first.waitFor((f) => f.type === 'going_idle_ack');
    fixture.server.deliver('work', testEvent('one'));
    fixture.server.deliver('work', testEvent('two'));
    first.close();
    await first.closed();

    // Fresh token, fresh socket: the buffer drains in order, ack-gated.
    const second = new RelayClient(fixture.port, token(WORK));
    await second.hello();

    const firstReplay = await second.waitFor((f) => f.type === 'inbound');
    expect((firstReplay.event as { text: string }).text).toBe('one');
    expect(typeof firstReplay.bufferId).toBe('string');
    await delay(30);
    expect(second.of('inbound')).toHaveLength(1); // ack-gated: nothing else yet
    second.send({ type: 'inbound_ack', bufferId: firstReplay.bufferId as string });

    await second.waitFor((f) => f.type === 'inbound' && f !== firstReplay);
    const secondReplay = second.of('inbound')[1];
    expect((secondReplay?.event as { text: string }).text).toBe('two');
    second.send({ type: 'inbound_ack', bufferId: secondReplay?.bufferId as string });
    await delay(50);
    expect(fixture.server.bufferedCount('work')).toBe(0);
    second.close();
    await second.closed();

    // A third connection must see nothing: replay is exactly-once as observed.
    const third = new RelayClient(fixture.port, token(WORK));
    await third.hello();
    await delay(100);
    expect(third.of('inbound')).toHaveLength(0);

    // ...and live delivery works again.
    expect(fixture.server.deliver('work', testEvent('live again'))).toBe('live');
    const live = await third.waitFor((f) => f.type === 'inbound');
    expect(live.bufferId).toBeUndefined();
  });
});

describe('outbound', () => {
  it('answers with the executor result under the same requestId', async () => {
    const client = new RelayClient(fixture.port, token(WORK));
    await client.hello();
    client.send({
      type: 'outbound',
      requestId: 'abc123',
      action: { op: 'send', chat_id: '34600000000@s.whatsapp.net', content: 'hello' },
    });
    const result = await client.waitFor((f) => f.type === 'outbound_result');
    expect(result).toEqual({
      type: 'outbound_result',
      requestId: 'abc123',
      result: { success: true, message_id: 'wa-out-1' },
    });
    expect(fixture.executed).toHaveLength(1);
    expect(fixture.executed[0]?.profile).toBe('work');
  });

  it('refuses an action for a platform we do not front', async () => {
    const client = new RelayClient(fixture.port, token(WORK));
    await client.hello();
    client.send({
      type: 'outbound',
      requestId: 'xyz',
      action: { op: 'send', chat_id: 'c', content: 'hi' },
      platform: 'discord',
    });
    const result = await client.waitFor((f) => f.type === 'outbound_result');
    expect(result).toMatchObject({ result: { success: false, error: 'platform not fronted' } });
    expect(fixture.executed).toHaveLength(0);
  });
});

describe('http routes', () => {
  it('stores a policy for the authenticated profile', async () => {
    const res = await fetch(`${base()}/relay/policy`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token(WORK)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'whatsapp', requireAddress: false, extra: 'ignored' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(fixture.store.policy.get('work')).toEqual({
      platform: 'whatsapp',
      requireAddress: false,
    });
  });

  it('rejects a policy without a token', async () => {
    const res = await fetch(`${base()}/relay/policy`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('uploads and downloads media scoped to the owning profile', async () => {
    const upload = await fetch(`${base()}/relay/media`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token(WORK)}`,
        'content-type': 'image/png',
        'x-media-filename': 'shot.png',
      },
      body: Buffer.from('PNG-BYTES'),
    });
    expect(upload.status).toBe(200);
    const { id } = (await upload.json()) as { id: string };
    expect(id).toMatch(/^[0-9a-f]{32}$/);

    const mine = await fetch(`${base()}/relay/media/${id}`, {
      headers: { authorization: `Bearer ${token(WORK)}` },
    });
    expect(mine.status).toBe(200);
    expect(mine.headers.get('content-type')).toBe('image/png');
    expect(mine.headers.get('content-disposition')).toBe('inline; filename="shot.png"');
    expect(await mine.text()).toBe('PNG-BYTES');

    // Another profile must not even learn that the object exists.
    const theirs = await fetch(`${base()}/relay/media/${id}`, {
      headers: { authorization: `Bearer ${token(HOME)}` },
    });
    expect(theirs.status).toBe(404);
    expect(await theirs.json()).toEqual({ error: 'not found' });

    const anonymous = await fetch(`${base()}/relay/media/${id}`);
    expect(anonymous.status).toBe(401);
  });

  it('refuses media above the configured limit', async () => {
    const big = Buffer.alloc(fixture.config.media.maxBytes + 1);
    const res = await fetch(`${base()}/relay/media`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token(WORK)}`, 'content-type': 'application/octet-stream' },
      body: big,
    });
    expect(res.status).toBe(413);
  });

  it('serves /healthz without auth', async () => {
    const client = new RelayClient(fixture.port, token(WORK));
    await client.hello();
    fixture.server.deliver('home', testEvent('queued'));

    const res = await fetch(`${base()}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'ok',
      whatsapp: 'connected',
      profiles: {
        work: { connected: true, buffered: 0 },
        home: { connected: false, buffered: 1 },
      },
    });
  });

  it('404s enrollment, provisioning, debug/inbound and anything unknown', async () => {
    for (const path of ['/relay/enroll', '/relay/provision', '/nope']) {
      const res = await fetch(`${base()}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token(WORK)}` },
      });
      expect(res.status, path).toBe(404);
      expect(await res.json()).toEqual({ error: 'not found' });
    }
    const debugRes = await fetch(`${base()}/debug/inbound`, { method: 'POST', body: '{}' });
    expect(debugRes.status).toBe(404);
  });

  it('429s after ten authentication failures from the same ip', async () => {
    const bad = `Bearer ${makeToken(WORK.gatewayId, 'wrong-secret-wrong-secret-wrong-secret', 300)}`;
    for (let i = 0; i < 10; i += 1) {
      const res = await fetch(`${base()}/relay/policy`, {
        method: 'POST',
        headers: { authorization: bad },
        body: '{}',
      });
      expect(res.status).toBe(401);
    }
    const throttled = await fetch(`${base()}/relay/policy`, {
      method: 'POST',
      headers: { authorization: bad },
      body: '{}',
    });
    expect(throttled.status).toBe(429);

    // A valid token from the same (throttled) ip is refused without verifying.
    const good = await fetch(`${base()}/relay/policy`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token(WORK)}` },
      body: '{}',
    });
    expect(good.status).toBe(429);
  });
});

describe('debug inbound', () => {
  it('is served only when the caller wires it', async () => {
    const injected: unknown[] = [];
    const store = openStore(':memory:', { mediaDir: join(tempDir, 'media2') });
    const server = createRelayServer({
      config: testConfig({ profiles: [WORK] }),
      store,
      log: silentLogger(),
      execute: async () => ({ success: true }),
      health: () => ({ status: 'ok' }),
      debugInbound: async (body) => {
        injected.push(body);
      },
    });
    const { port } = await server.listen();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/debug/inbound`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      });
      expect(res.status).toBe(200);
      expect(injected).toEqual([{ text: 'hi' }]);
    } finally {
      await server.close();
      store.close();
    }
  });
});

describe('wake poke', () => {
  it('fires once when the first event lands for a disconnected profile', async () => {
    await restartWith([testProfile('woken', { wakeUrl: 'http://wake.invalid/hook' })]);

    fixture.server.deliver('woken', testEvent('first'));
    await delay(20);
    expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
    expect(fixture.fetchMock.mock.calls[0]?.[0]).toBe('http://wake.invalid/hook');

    // A second event while the buffer is non-empty is not a new wake trigger.
    fixture.server.deliver('woken', testEvent('second'));
    await delay(20);
    expect(fixture.fetchMock).toHaveBeenCalledTimes(1);

    // Even after the buffer drains, the cooldown suppresses a second poke.
    let next = fixture.store.buffer.nextUnacked('woken');
    while (next !== null) {
      fixture.store.buffer.ack('woken', next.seq);
      next = fixture.store.buffer.nextUnacked('woken');
    }
    fixture.server.deliver('woken', testEvent('third'));
    await delay(20);
    expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not poke while the profile is connected', async () => {
    const woken = testProfile('woken', { wakeUrl: 'http://wake.invalid/hook' });
    await restartWith([woken]);

    const client = new RelayClient(fixture.port, token(woken));
    await client.hello();
    fixture.server.deliver('woken', testEvent('live'));
    await delay(20);
    expect(fixture.fetchMock).not.toHaveBeenCalled();
  });
});

describe('maintenance', () => {
  it('purges expired buffer rows and media on demand', () => {
    const now = Math.floor(Date.now() / 1000);
    fixture.store.buffer.append('work', testEvent('ancient'), now - 3_000_000);
    fixture.store.media.put('work', Buffer.from('old'), 'text/plain', null, now - 3_000_000);
    const swept = fixture.server.runMaintenance(now);
    expect(swept).toEqual({ bufferPurged: 1, mediaPurged: 1 });
    expect(fixture.server.bufferedCount('work')).toBe(0);
  });
});

describe('shutdown', () => {
  it('closes live sessions with 1001 going away', async () => {
    const client = new RelayClient(fixture.port, token(WORK));
    await client.hello();
    const closing = client.closed();
    await fixture.server.close();
    expect(await closing).toEqual({ code: 1001, reason: 'going away' });
    expect(fixture.server.address()).toBeNull();
  });
});

/** Frames the server sent us, typed for readability in failures. */
export type _ServerFrame = ConnectorFrame;
