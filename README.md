# WhatRouter

WhatRouter is a [Hermes Agent](https://github.com/NousResearch/hermes-agent) Relay connector for
WhatsApp: one WhatsApp account (a dedicated bot number) owned by WhatRouter, multiplexed to N
Hermes instances by a static YAML config. Each Hermes instance is a *profile* with its own
`gateway_id` and secret; routes bind DMs (by phone) and groups (by JID) to exactly one profile,
and messages are durably buffered while an instance is offline.

Quick start: `cp config.example.yaml config.yaml`, edit it, then
`npx whatrouter check-config config.yaml`. `whatrouter env <profile>` prints the four
`GATEWAY_RELAY_*` lines for that instance's `~/.hermes/.env`.

Design and protocol notes live in [docs/DESIGN.md](docs/DESIGN.md); full docs coming in WP5.
