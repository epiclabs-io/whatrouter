import { describe, expect, it } from 'vitest';
import { isGatewayFrame } from '../../src/relay/frames.js';

describe('isGatewayFrame', () => {
  it('accepts well-formed gateway frames', () => {
    expect(isGatewayFrame({ type: 'hello', platform: 'whatsapp', botId: '' })).toBe(true);
    expect(isGatewayFrame({ type: 'outbound', requestId: 'ab12', action: { op: 'send', chat_id: 'x', content: 'hi' } })).toBe(true);
    expect(isGatewayFrame({ type: 'inbound_ack', bufferId: '7' })).toBe(true);
    expect(isGatewayFrame({ type: 'interrupt' })).toBe(true);
    expect(isGatewayFrame({ type: 'going_idle' })).toBe(true);
  });

  it('rejects malformed or unknown frames (the contract is additive-only)', () => {
    expect(isGatewayFrame({ type: 'from_the_future' })).toBe(false);
    expect(isGatewayFrame({ type: 'hello' })).toBe(false);
    expect(isGatewayFrame({ type: 'outbound', requestId: 'ab12', action: {} })).toBe(false);
    expect(isGatewayFrame({ type: 'inbound_ack', bufferId: 7 })).toBe(false);
    expect(isGatewayFrame(null)).toBe(false);
    expect(isGatewayFrame('hello')).toBe(false);
    expect(isGatewayFrame([{ type: 'going_idle' }])).toBe(false);
  });
});
