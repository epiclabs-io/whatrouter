import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run, type CliIo } from '../../src/cli.js';

const EXAMPLE = 'config.example.yaml';

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => void out.push(l), err: (l) => void err.push(l) }, out, err };
}

let tempDir: string | null = null;

async function writeConfig(name: string, body: string): Promise<string> {
  tempDir ??= await mkdtemp(join(tmpdir(), 'whatrouter-cli-'));
  const path = join(tempDir, name);
  await writeFile(path, body, 'utf8');
  return path;
}

afterEach(() => {
  tempDir = null;
});

const VALID = `
listen: 127.0.0.1:9100
profiles:
  work:
    gateway_id: gw-work
    secret: ${'w'.repeat(40)}
    routes:
      - dm: "+34600000000"
`;

// Two profiles fighting over the same DM.
const BROKEN = `
profiles:
  work:
    gateway_id: gw-work
    secret: ${'w'.repeat(40)}
    routes:
      - dm: "+34600000000"
  home:
    gateway_id: gw-home
    secret: ${'h'.repeat(40)}
    routes:
      - dm: "34600000000@s.whatsapp.net"
`;

describe('check-config', () => {
  it('exits 0 and prints a summary for the shipped example', async () => {
    const { io, out, err } = capture();
    expect(await run(['check-config', EXAMPLE], io)).toBe(0);
    expect(err).toEqual([]);
    expect(out.join('\n')).toContain('listen: 0.0.0.0:8466');
    expect(out.join('\n')).toContain('data_dir: /data');
    expect(out.join('\n')).toContain('profiles: 2 (4 routes)');
    expect(out.join('\n')).toContain('work [gw-work]: 1 dm, 1 group');
    expect(out.at(-1)).toBe('config OK');
  });

  it('exits 2 and prints every error for an invalid config', async () => {
    const path = await writeConfig('broken.yaml', BROKEN);
    const { io, out, err } = capture();
    expect(await run(['check-config', path], io)).toBe(2);
    expect(out).toEqual([]);
    expect(err).toEqual([
      'error: profiles.home.routes[0].dm: chat 34600000000@s.whatsapp.net is routed to both profile "work" and profile "home"',
    ]);
  });

  it('exits 2 when the file is missing', async () => {
    const { io, err } = capture();
    expect(await run(['check-config', '/nonexistent/whatrouter.yaml'], io)).toBe(2);
    expect(err[0]).toContain('cannot read config file');
  });

  it('accepts --config instead of a positional path', async () => {
    const path = await writeConfig('valid.yaml', VALID);
    const { io, out } = capture();
    expect(await run(['--config', path, 'check-config'], io)).toBe(0);
    expect(out.join('\n')).toContain('listen: 127.0.0.1:9100');
  });
});

describe('env', () => {
  it('prints exactly the four Hermes .env lines', async () => {
    const { io, out, err } = capture();
    expect(await run(['env', 'work', '--config', EXAMPLE], io)).toBe(0);
    expect(err).toEqual([]);
    expect(out).toEqual([
      'GATEWAY_RELAY_URL=wss://whatrouter.example.com/relay',
      'GATEWAY_RELAY_ID=gw-work',
      'GATEWAY_RELAY_SECRET=replace-me-work-0000000000000000000000',
      'GATEWAY_RELAY_PLATFORMS=whatsapp',
    ]);
  });

  it('derives a ws:// url from listen when public_url is unset', async () => {
    const path = await writeConfig('valid.yaml', VALID);
    const { io, out } = capture();
    expect(await run(['env', 'work', '--config', path], io)).toBe(0);
    expect(out[0]).toBe('GATEWAY_RELAY_URL=ws://127.0.0.1:9100/relay');
  });

  it('exits 2 for an unknown profile or a missing profile argument', async () => {
    const unknown = capture();
    expect(await run(['env', 'nope', '--config', EXAMPLE], unknown.io)).toBe(2);
    expect(unknown.err[0]).toContain('unknown profile "nope"');

    const missing = capture();
    expect(await run(['env', '--config', EXAMPLE], missing.io)).toBe(2);
    expect(missing.err[0]).toContain('env requires a profile name');
  });
});

describe('stubs and usage', () => {
  it('serve validates the config, then reports that it is not implemented yet', async () => {
    const path = await writeConfig('valid.yaml', VALID);
    const { io, err } = capture();
    expect(await run(['--config', path, 'serve'], io)).toBe(1);
    expect(err).toEqual(['serve: not implemented yet (WP4)']);
  });

  it('serve is the default command', async () => {
    const path = await writeConfig('valid.yaml', VALID);
    const { io, err } = capture();
    expect(await run(['--config', path], io)).toBe(1);
    expect(err).toEqual(['serve: not implemented yet (WP4)']);
  });

  it('serve exits 2 on an invalid config instead of starting', async () => {
    const path = await writeConfig('broken.yaml', BROKEN);
    const { io, err } = capture();
    expect(await run(['--config', path, 'serve'], io)).toBe(2);
    expect(err.every((line) => line.startsWith('error:'))).toBe(true);
  });

  // The happy path opens a WhatsApp socket, so the wiring is checked with a --code
  // value that `runPair` rejects before it ever builds one (see wa-pair.test.ts).
  it('pair passes --code through to the pairing flow', async () => {
    const path = await writeConfig('valid.yaml', VALID);
    const { io, err } = capture();
    expect(await run(['--config', path, 'pair', '--code', 'not-a-phone'], io)).toBe(1);
    expect(err[0]).toContain('--code needs a phone number');
  });

  it('prints warnings but still succeeds', async () => {
    const path = await writeConfig('warn.yaml', `profiles:\n  work:\n    gateway_id: gw\n    secret: ${'w'.repeat(40)}\n    routes: []\n`);
    const { io, err } = capture();
    expect(await run(['check-config', path], io)).toBe(0);
    expect(err[0]).toContain('warning: profiles.work.routes: profile "work" has no routes');
  });

  it('--help exits 0 and an unknown command exits 2', async () => {
    const help = capture();
    expect(await run(['--help'], help.io)).toBe(0);
    expect(help.out.join('\n')).toContain('Usage:');

    const bad = capture();
    expect(await run(['nonsense'], bad.io)).toBe(2);
    expect(bad.err[0]).toContain('unknown command "nonsense"');

    const badFlag = capture();
    expect(await run(['--wat'], badFlag.io)).toBe(2);
    expect(badFlag.err[0]).toContain('error:');
  });
});
