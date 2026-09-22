import { describe, expect, it } from 'vitest';
import { encodeFrame, LineAssembler, parseGatewayFrame } from '../../src/relay/ndjson.js';
import { buildDescriptor } from '../../src/relay/descriptor.js';
import { testConfig } from '../helpers/relay.js';

describe('encodeFrame', () => {
  it('always ends with a newline (the gateway reader holds partial lines forever)', () => {
    const line = encodeFrame({ type: 'going_idle_ack' });
    expect(line).toBe('{"type":"going_idle_ack"}\n');
  });

  it('encodes a descriptor frame as one line', () => {
    const line = encodeFrame({ type: 'descriptor', descriptor: buildDescriptor(testConfig()) });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toContain('\n');
    expect(JSON.parse(line)).toMatchObject({ type: 'descriptor' });
  });
});

describe('LineAssembler', () => {
  it('holds a partial line and never loses the tail', () => {
    const asm = new LineAssembler();
    expect(asm.push('{"a":1}')).toEqual([]);
    expect(asm.push('\n{"b":2}\n{"c"')).toEqual(['{"a":1}', '{"b":2}']);
    expect(asm.push(':3}\n')).toEqual(['{"c":3}']);
    expect(asm.pending).toBe('');
  });

  it('yields several frames from one chunk', () => {
    const asm = new LineAssembler();
    expect(asm.push('{"x":1}\n{"y":2}\n')).toEqual(['{"x":1}', '{"y":2}']);
  });

  it('skips blank and whitespace-only lines', () => {
    const asm = new LineAssembler();
    expect(asm.push('\n\n  \n{"a":1}\n')).toEqual(['{"a":1}']);
    expect(asm.push('')).toEqual([]);
  });

  it('trims trailing carriage returns', () => {
    const asm = new LineAssembler();
    expect(asm.push('{"a":1}\r\n')).toEqual(['{"a":1}']);
  });

  it('reassembles a frame split byte by byte', () => {
    const asm = new LineAssembler();
    const line = '{"type":"going_idle"}\n';
    const out: string[] = [];
    for (const ch of line) out.push(...asm.push(ch));
    expect(out).toEqual(['{"type":"going_idle"}']);
  });
});

describe('parseGatewayFrame', () => {
  it('parses known frames', () => {
    expect(parseGatewayFrame('{"type":"hello","platform":"whatsapp"}')).toEqual({
      type: 'hello',
      platform: 'whatsapp',
    });
  });

  it('returns null for malformed JSON and for unknown frame types', () => {
    expect(parseGatewayFrame('{not json')).toBeNull();
    expect(parseGatewayFrame('null')).toBeNull();
    expect(parseGatewayFrame('[1,2,3]')).toBeNull();
    expect(parseGatewayFrame('{"type":"from_the_future"}')).toBeNull();
    expect(parseGatewayFrame('{"type":"hello"}')).toBeNull();
  });
});
