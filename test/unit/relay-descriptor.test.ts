import { describe, expect, it } from 'vitest';
import { buildDescriptor } from '../../src/relay/descriptor.js';
import { testConfig } from '../helpers/relay.js';

describe('buildDescriptor', () => {
  it('is byte-for-byte the WhatsApp descriptor from the spec', () => {
    expect(buildDescriptor(testConfig())).toEqual({
      contract_version: 1,
      platform: 'whatsapp',
      label: 'WhatsApp',
      max_message_length: 4096,
      supports_draft_streaming: false,
      supports_edit: false,
      supports_threads: false,
      markdown_dialect: 'whatsapp',
      len_unit: 'chars',
      emoji: '💬',
      platform_hint:
        'WhatsApp via WhatRouter. Use plain markdown; it is converted to WhatsApp formatting (*bold*, _italic_, ~strike~, ```code```).',
      pii_safe: false,
      supports_context: false,
      supported_ops: ['send', 'edit', 'delete', 'typing', 'react', 'send_media', 'get_chat_info'],
    });
  });

  it('follows whatsapp.edit_streaming for supports_edit', () => {
    const config = testConfig();
    config.whatsapp.editStreaming = true;
    expect(buildDescriptor(config).supports_edit).toBe(true);
  });

  it('never advertises an empty op list (the gateway would assume the legacy set)', () => {
    expect(buildDescriptor(testConfig()).supported_ops.length).toBeGreaterThan(0);
  });
});
