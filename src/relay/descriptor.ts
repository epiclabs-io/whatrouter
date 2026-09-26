/**
 * The capability descriptor we answer every `hello` with. Field-for-field the
 * table in docs/DESIGN.md: the gateway keys behaviour off these names.
 */
import type { CapabilityDescriptor } from "./frames.js";
import type { Config } from "../config/schema.js";

/** WhatsApp's own text limit; the outbound chunker uses the same number. */
export const WHATSAPP_MAX_MESSAGE_LENGTH = 4096;

/** `supported_ops` must be explicit: an empty list makes the gateway assume the legacy set. */
export const WHATSAPP_SUPPORTED_OPS = [
  "send",
  "edit",
  "delete",
  "typing",
  "react",
  "send_media",
  "get_chat_info",
] as const;

const PLATFORM_HINT =
  "WhatsApp via WhatRouter. Use plain markdown; it is converted to WhatsApp formatting " +
  "(*bold*, _italic_, ~strike~, ```code```).";

export function buildDescriptor(config: Config): CapabilityDescriptor {
  return {
    contract_version: 1,
    platform: "whatsapp",
    label: "WhatsApp",
    max_message_length: WHATSAPP_MAX_MESSAGE_LENGTH,
    supports_draft_streaming: false,
    // Off by default: edit storms leave an "edited" label on every message.
    supports_edit: config.whatsapp.editStreaming,
    supports_threads: false,
    markdown_dialect: "whatsapp",
    len_unit: "chars",
    emoji: "💬",
    platform_hint: PLATFORM_HINT,
    pii_safe: false,
    supports_context: false,
    supported_ops: [...WHATSAPP_SUPPORTED_OPS],
  };
}
