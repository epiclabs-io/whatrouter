# WhatRouter — Design & Protocol Specification

> Source of truth for implementers. Derived from the approved plan (2026-09-22). Field names are verbatim from Hermes `gateway/relay/*.py`.

## Context

Hermes Agent (NousResearch/hermes-agent) has an experimental **Relay** transport: the gateway dials
*out* over one authenticated WebSocket to a **connector** that owns the real platform credentials
and sockets, and exchanges normalized `MessageEvent`s (inbound) and `action`s (outbound). The only
open-source connector today is `nabi-allenby/hermes-relay-connector` (Rust, Discord).

WhatRouter is the WhatsApp equivalent, simplified: **one WhatsApp account (a dedicated bot
number), owned by WhatRouter, multiplexed to N Hermes instances by a static YAML config.** Each
Hermes instance is a *profile* with a long-lived `gateway_id` + `secret`; routes bind WhatsApp DMs
(by phone) and groups (by JID) to a profile. No enrollment/provisioning API, no admin API, no
multi-tenant NAS/OIDC. One extra CLI command (`pair`) does the one-off QR / pairing-code login and
persists the Baileys auth state so later launches just work.

Hermes already ships a *native* Baileys bridge (`hermes whatsapp`), but it is 1 account ↔ 1
instance. WhatRouter's value is 1 account ↔ N instances with per-chat routing, plus credential
isolation and durable buffering while an instance is offline.

Implementation is delegated to Opus agents in work packages; Fable (me) orchestrates and validates
every package (diff review, tests, protocol conformance) before merge.

## Decisions (user-confirmed + research-driven)

| Topic | Decision |
|---|---|
| Buffering | Durable, ack-gated per-profile buffer in **`node:sqlite`** (built into Node 24, no native build; verified working locally). Same §3.2 semantics as the Rust connector. |
| Media | **In v1.** Inbound media downloaded and re-hosted at `/relay/media/{id}` (HMAC-bearer gated); outbound `send_media` implemented. |
| Build | **Vite SSR build** → `dist/whatrouter.js` (deps externalized), `tsx` for dev, **Vitest** for tests. ESM throughout (Baileys 7 is ESM-only). |
| Pairing | `whatrouter pair` supports **QR in terminal and phone-number pairing code** (`--code <phone>`). |
| Enrollment | **Not implemented.** `/relay/enroll` and `/relay/provision` return 404. Operators paste 4 env lines into each Hermes `.env`; `whatrouter env <profile>` prints them. (Hermes skips self-provision when `GATEWAY_RELAY_SECRET` is set — verified in `gateway/relay/__init__.py`.) |
| WhatsApp lib | `@whiskeysockets/baileys` **7.0.0-rc14**, pinned exact (Hermes' own bridge pins rc13; 6.7.x lacks LID handling). |
| Unrouted chats | Fail-closed drop by default; optional `default_profile`. |
| Outbound isolation | A profile may only act on chats routed to it (fail-closed), unless `allow_unrouted_outbound: true`. |
| Edit streaming | Descriptor `supports_edit: false` by default (avoid edit storms / "edited" labels on WhatsApp); `edit` op still advertised and implemented. Config flag to flip. |
| Account mode | Dedicated bot number. `fromMe` messages are ignored (echo suppression). |
| License | MIT (matches upstream). |
| Port | 8466 default. Env prefix `WHATROUTER_`. |

## Architecture

```
            WhatsApp (Baileys multi-device session; creds live ONLY here)
                              │  one socket, one account
                              ▼
 ┌─────────────────────────── WhatRouter ────────────────────────────┐
 │ whatsapp/   Baileys client: connect/reconnect, pair, normalize     │
 │             inbound → InboundMessage, execute outbound ops        │
 │ router/     routes.yaml → profile; relevance gate (mention/reply)  │
 │             tenant check on outbound                              │
 │ relay/      WS server /relay (HMAC bearer), NDJSON frames,        │
 │             per-profile session actor, sqlite buffer + replay,     │
 │             wake poke, /relay/policy, /relay/media, /healthz       │
 │ store/      node:sqlite: buffer, flips, policies, media index      │
 └───────────────────────────────────────────────────────────────────┘
                              ▲  outbound-only dials (wss://…/relay)
          hermes gateway "work"        hermes gateway "home"   …
          GATEWAY_RELAY_ID/SECRET/URL, GATEWAY_RELAY_PLATFORMS=whatsapp
```

Trust model: WhatRouter is the sole holder of WhatsApp credentials and the sole crypto boundary.
Each Hermes instance authenticates per-profile; a compromised instance can only impersonate
itself and can only reach chats routed to it.

## Wire protocol reference (MUST match `gateway/relay/ws_transport.py` byte-for-byte)

Sources verified 2026-09-22: `gateway/relay/{ws_transport,auth,descriptor,transport,media}.py` at
NousResearch/hermes-agent `main`; `src/{protocol,auth,relay_ws,deliver}.rs` and
`conformance/probe_transport.py` at nabi-allenby/hermes-relay-connector.

### Framing
Newline-delimited JSON over WS **text** messages. **Every frame we send ends with `\n`** (the
gateway reader holds a partial line forever). Our reader must buffer partial lines and accept
several frames per WS message. Unknown `type` values are ignored (additive-only evolution).

### Frames
gateway → connector:
- `{"type":"hello","platform":"whatsapp","botId":"<may be empty>","command_manifest"?:…}` — one per fronted identity; reply with a `descriptor` per hello. Accept any `platform`/`botId`; warn if platform ∉ {`whatsapp`,`relay`}.
- `{"type":"outbound","requestId":"<hex>","action":{"op":…,…},"platform"?:"whatsapp","botId"?:…}` → must answer `outbound_result` with same `requestId`. If `platform` present and ≠ `whatsapp` → `{success:false,error:"platform not fronted"}`.
- `{"type":"inbound_ack","bufferId":"<seq>"}` — advance buffer cursor only if it matches the in-flight seq.
- `{"type":"interrupt","session_key":…,"reason"?:…}` — log only (no running turns connector-side).
- `{"type":"going_idle"}` — durably set buffered-only flip FIRST, then send `going_idle_ack`.

connector → gateway:
- `{"type":"descriptor","descriptor":{…}}`
- `{"type":"inbound","event":{…},"bufferId"?:"<seq>"}` — `bufferId` present ⇔ replayed from buffer (requires ack); absent ⇔ live.
- `{"type":"outbound_result","requestId":…,"result":{…}}`
- `{"type":"going_idle_ack"}`
- (`interrupt_inbound`, `passthrough_forward`: not used by WhatRouter.)

### Upgrade auth
`Authorization: Bearer <token>`, `token = base64url_nopad("{gatewayId}:{exp}:{sig}")`,
`sig = hex(HMAC_SHA256(key=secret, msg="{gatewayId}:{exp}"))`, `exp` = unix seconds (0 = never;
gateway mints TTL 300 s). Decode tolerating padding; **split from the right** (payload may contain
colons); peek payload to find the profile; verify with constant-time compare.
Rejections: **accept the upgrade, then close with code 4401** (an HTTP 401 would not engage the
gateway's 4401 logic). Close reason `"expired"` when only `exp` passed (gateway then reconnects
normally); `"unauthorized"` for unknown id / bad signature. A second live connection for the same
profile: close the *new* one with 1008 `"duplicate session"` (never 4401). Graceful shutdown: 1001.
WS ping every 30 s, 60 s pong timeout (detect zombies).

Required unit-test vectors (generated from the real Python `auth.py`, `time.time()=1754700000`):
- `sign("abc","key") == "9c196e32dc0175f86f4b1cb89289d6619de6bee699e4c378e68309ed97a1a6ab"`
- `make_token("gw-test","topsecret",ttl=300) == "Z3ctdGVzdDoxNzU0NzAwMzAwOjQ0OGNlNjE1NjY2MzU0MGM3YzY5NjZhMzRjZGJkMWMzNDAwOGNjMDU2OGEyODgzMWJiZjZjMjkxZWRmOWU5ZDA"`
- `make_token("gw:with:colons","s2",ttl=0) == "Z3c6d2l0aDpjb2xvbnM6MDpkOWEyNGQyNThmNDM1YjQ1ZTJhOWM1MDNmNzBmODY2M2ZjYzNhNzAyOWYzNDc3ZmZhZjkxZTJkZDY4OTRjNWUz"`
- `verify(VEC_SIMPLE, now=1754700301) → null` (expired); padded token also accepted.

### CapabilityDescriptor (WhatsApp)
```json
{"contract_version":1,"platform":"whatsapp","label":"WhatsApp","max_message_length":4096,
 "supports_draft_streaming":false,"supports_edit":false,"supports_threads":false,
 "markdown_dialect":"whatsapp","len_unit":"chars","emoji":"💬",
 "platform_hint":"WhatsApp via WhatRouter. Use plain markdown; it is converted to WhatsApp formatting (*bold*, _italic_, ~strike~, ```code```).",
 "pii_safe":false,"supports_context":false,
 "supported_ops":["send","edit","delete","typing","react","send_media","get_chat_info"]}
```
Gateway treats `markdown_dialect ∉ {"", "plain"}` as "code blocks OK"; an explicit
`supported_ops` list is mandatory (empty ⇒ gateway assumes legacy `send,edit,typing,follow_up`).
`supports_edit` follows config `whatsapp.edit_streaming` (default false).

### Inbound `event` shape (consumed by `_event_from_wire`)
```json
{"text":"…","message_type":"text|command|photo|video|audio|voice|document|sticker|location",
 "message_id":"<wa id>","reply_to_message_id":"<quoted stanzaId>|null",
 "reply_to":{"text":"…","author":"…","is_own":false},
 "media_urls":["<public_url>/relay/media/<id>"],
 "media":[{"url":"<same url>","kind":"image|voice|audio|video|document|sticker","mime":"…","size":123,"filename":"…","caption":"…"}],
 "source":{"platform":"whatsapp","chat_id":"<canonical>","chat_type":"dm|group",
           "chat_name":"<group subject | sender pushName>","user_id":"<canonical sender>",
           "user_name":"<pushName>","thread_id":null,"chat_topic":null,
           "user_id_alt":"<other form (lid/pn)>","chat_id_alt":"<raw remoteJid if ≠ chat_id>",
           "message_id":"<wa id>"}}
```
`media[i].url` MUST equal an entry of `media_urls` (gateway resolves mime by URL lookup).
`message_type` = `command` when text starts with `/`.

### Outbound ops → results (`result` object)
| op | fields | WhatsApp mapping | result |
|---|---|---|---|
| `send` | `chat_id, content, reply_to?, metadata?` | markdown→WA, chunk ≤4096 (prefer `\n`, then space), first chunk `quoted` if `reply_to` known in message store; serialized send queue; 60 s timeout | `{success, message_id (last chunk), error?}` |
| `edit` | `chat_id, message_id, content` | `sendMessage(jid,{text, edit:{id,fromMe:true,remoteJid}})`; overflow chunks as new sends | `{success, error?}` |
| `delete` | `chat_id, message_id` | `sendMessage(jid,{delete:key})` | `{success}` |
| `typing` | `chat_id, content?` | `sendPresenceUpdate('composing', jid)`; `content:""` → `'paused'` | `{success:true}` |
| `react` | `chat_id, message_id, emoji, remove?` | `sendMessage(jid,{react:{text: remove?'':emoji, key}})`, key from message store (fallback `{id,remoteJid,fromMe:false}`) | `{success}` never throws |
| `send_media` | `chat_id, media_kind, source_url, content?, filename?, reply_to?` | fetch bytes (own media store direct; else HTTP ≤25 MB, 30 s); `image→{image,caption}`, `video→{video,caption}`, `voice→{audio,ptt:true,mimetype:'audio/ogg; codecs=opus'}` (ffmpeg→ogg/opus if present, else non-ptt audio), `audio→{audio}`, `document→{document,fileName,mimetype,caption}` | `{success, message_id, error?}` |
| `get_chat_info` | `chat_id` | group: `groupMetadata(jid).subject`; dm: pushName or digits | `{success:true, chat_info:{name,type}}` |
| anything else | | | `{success:false, error:"unsupported op: <op>"}` |
Before any op: resolve `chat_id` → route; if not routed to this profile (and not `allow_unrouted_outbound`) → `{success:false,error:"chat not routed to this profile"}`.

### Buffer / delivery state machine (per profile, mirrors `relay_ws.rs`)
- Live delivery only when: session connected ∧ hello seen ∧ ¬idle_flipped ∧ no in-flight bufferId ∧ buffer empty.
- Otherwise append to sqlite buffer (`seq` autoincrement per profile); **pump**: send oldest unacked with `bufferId=seq`, wait for matching `inbound_ack`, delete row, repeat; when empty clear the durable flip → live.
- On `hello`: send descriptor, then pump (drain trigger). On `going_idle`: durable flip → ack.
- Disconnected + first buffered event → GET `wake_url` (payload-free, best-effort, 60 s cooldown) if configured.
- Purge unacked rows older than `buffer_max_age_seconds` (default 14 d) hourly. Buffer survives restarts.

### HTTP routes
| Route | Auth | Purpose |
|---|---|---|
| `GET /relay` | HMAC bearer (upgrade) | WebSocket |
| `POST /relay/policy` | HMAC bearer | Store `{platform, requireAddress, freeResponseScopes, allowOtherBots}` per profile → `200 {}` |
| `POST /relay/media` | HMAC bearer; raw body; `Content-Type`, `X-Media-Filename` | Store ≤25 MB → `{id}`; owned by profile |
| `GET /relay/media/{id}` | HMAC bearer of owning profile | Bytes + `Content-Type` + `Content-Disposition` |
| `GET /healthz` | none | `{status, whatsapp:"connected|connecting|disconnected|unpaired", profiles:{id:{connected, buffered}}}` |
| `/relay/enroll`, `/relay/provision` | | 404 by design |
| `POST /debug/inbound` | only when `WHATROUTER_FAKE_WHATSAPP=1` | inject a fake inbound (tests/conformance) |
Auth failures: log at warn, per-IP throttle (10 failures/60 s → 429 for HTTP).

## WhatsApp mapping rules (Baileys 7)

- **Socket**: `makeWASocket({version (fetchLatestBaileysVersion with 15 s timeout, fallback cached/default), auth:{creds, keys: makeCacheableSignalKeyStore(state.keys, logger)}, logger: pino, browser:['WhatRouter','Chrome','120.0'], syncFullHistory:false, markOnlineOnConnect:false, getMessage: bounded store lookup else {conversation:''}, cachedGroupMetadata: LRU})`. Auth state: `useMultiFileAuthState(<data_dir>/wa-auth)`; `creds.update → saveCreds`.
- **Reconnect**: on `connection.update.connection==='close'`: `DisconnectReason.loggedOut` → mark `unpaired`, log "run whatrouter pair", stop; code 515 → reconnect in 1 s; else backoff 3 s → 60 s. Reconnects go through a scheduler that catches rejections (Hermes bridge pattern).
- **Identity/LID**: bot ids = normalized `{sock.user.id, sock.user.lid}` (strip `:device`). Sender: `key.participant || key.remoteJid`; alt: `key.participantAlt || key.remoteJidAlt`. **Canonical id** = the `@s.whatsapp.net` form when either is PN, else `@lid`. DM `chat_id` = canonical sender; group `chat_id` = `…@g.us`. Keep `canonical → last raw remoteJid` map for outbound targeting (send to raw when known, else canonical).
- **Route matching**: DM routes accept `+34600000000`, `34600000000`, `34600000000@s.whatsapp.net`, `<n>@lid` (digits compared); group routes accept `<n>@g.us`. A chat matching two profiles is a **config error**.
- **Ingest filter**: skip `type ∉ {notify, append}`, `msg.message == null`, `key.fromMe`, `status@broadcast`, `@newsletter`, protocol/reaction/poll-update messages. Unwrap `ephemeralMessage / viewOnceMessage(V2) / documentWithCaptionMessage`. Bounded message store (512) for quoting/reacting/getMessage.
- **Relevance (groups)**: deliver when route `require_mention` (default true) is false, OR text starts with `/`, OR `contextInfo.mentionedJid ∩ botIds ≠ ∅`, OR reply-to-bot (`contextInfo.participant ∈ botIds`). Precedence: route setting > gateway `/relay/policy.requireAddress` > default true. Optional `allowed_senders` on group routes.
- **Reply context**: `reply_to_message_id = contextInfo.stanzaId`; `reply_to.text` from quoted message (conversation / extendedText / captions / `[Document: name]`); `reply_to.is_own = participant ∈ botIds`.
- **Media inbound**: `downloadMediaMessage(msg,'buffer',{}, {logger, reuploadRequest: sock.updateMediaMessage})`; failures never drop the message (append `[image could not be downloaded]`). Kinds: image→`photo`, video/gif→`video`, ptt→`voice`, audio→`audio`, document→`document`, sticker→`sticker`, location→`location` with `[Location: name lat,lng]` text.
- **Formatting out**: port Hermes `WhatsAppBehaviorMixin` markdown→WhatsApp: stash fenced + inline code; italic `*x*`→`_x_` before bold `**x**`→`*x*`; `~~x~~`→`~x~`; `# H`→`*H*`; `[t](u)`→`t (u)`; restore code. Then chunk.
- **Send safety**: single serialized send queue (overlapping `sendMessage` calls have caused cross-chat misdelivery upstream), 60 s per-send timeout, 300 ms delay between chunks, remember sent ids.
- **Read receipts**: off by default (`whatsapp.send_read_receipts`).

## Config (`config.yaml`, validated with zod; `WHATROUTER_CONFIG` path, default `/data/config.yaml` in Docker, `./config.yaml` locally)

```yaml
listen: 0.0.0.0:8466
public_url: https://whatrouter.example.com   # base for media URLs; warn+fallback to http://localhost:8466
data_dir: /data                              # wa-auth/, whatrouter.sqlite, media/
log_level: info
whatsapp:
  edit_streaming: false
  send_read_receipts: false
  chunk_delay_ms: 300
  send_timeout_ms: 60000
buffer:
  max_age_seconds: 1209600
  wake_cooldown_seconds: 60
media:
  max_bytes: 26214400
  retention_seconds: 604800
default_profile: null            # null = drop unrouted chats
allow_unrouted_outbound: false
profiles:
  work:
    gateway_id: gw-work
    secret: ${WORK_SECRET}       # ${ENV} interpolation; or secret_file: /run/secrets/work
    display_name: Work Agent
    wake_url: null
    routes:
      - dm: "+34600000000"
      - group: "120363001234567890@g.us"
        require_mention: true
        allowed_senders: ["+34600000000"]
```
Startup validation errors (exit 2): duplicate `gateway_id`, secret < 32 chars, chat routed to two
profiles, malformed JIDs/phones, unpaired auth state in `serve` mode (message: run `whatrouter pair`).

## Repository layout & tooling

```
package.json            type: module; bin: {"whatrouter": "dist/whatrouter.js"}; engines node>=24
tsconfig.json           strict, NodeNext, target ES2023
vite.config.ts          build.ssr='src/main.ts', target node24, all deps external, out dist/whatrouter.js
vitest.config.ts        environment node; test/**/*.test.ts
src/main.ts             CLI: serve (default) | pair [--code <phone>] | env <profile> | check-config
src/config/{schema,load}.ts
src/relay/{auth,frames,descriptor,session,server,media-routes,policy}.ts
src/store/{db,buffer,media,policy}.ts        node:sqlite (DatabaseSync), WAL
src/router/{routes,relevance,router}.ts
src/whatsapp/{port,baileys-client,normalize,format,chunk,jid,outbound,pair,fake}.ts
src/util/{log,http}.ts
test/unit/**, test/integration/**, test/fixtures/baileys/*.json
scripts/conformance/{probe.py,run.sh}         drives the REAL hermes relay transport against us
Dockerfile, docker-compose.yml, config.example.yaml, README.md, LICENSE, .github/workflows/ci.yml
```
Runtime deps: `@whiskeysockets/baileys@7.0.0-rc14` (exact), `@hapi/boom`, `ws`, `yaml`, `zod`,
`pino`, `qrcode-terminal`, `sharp` (Baileys peer, prebuilt binaries). Dev: `typescript`, `vite`,
`vitest`, `tsx`, `@types/node`, `@types/ws`, `pino-pretty`.
Dockerfile: multi-stage on `node:24-bookworm-slim`; runtime installs `ffmpeg` (native voice
notes) + `npm ci --omit=dev`; non-root `node`; `VOLUME /data`; `EXPOSE 8466`;
`HEALTHCHECK` via `node -e "fetch('http://127.0.0.1:8466/healthz')…"`;
`ENTRYPOINT ["node","dist/whatrouter.js"]`, `CMD ["serve"]`. Pairing in Docker:
`docker run --rm -it -v whatrouter-data:/data whatrouter pair`.

Key interface (defined first so packages can proceed in parallel):
```ts
// src/whatsapp/port.ts
export interface WhatsAppPort {
  start(): Promise<void>; stop(): Promise<void>;
  state(): 'unpaired'|'connecting'|'connected'|'disconnected';
  botIds(): string[];
  onMessage(handler: (m: InboundMessage) => Promise<void>): void;
  sendText(chat: string, text: string, opts?: {replyTo?: string}): Promise<{messageId: string}>;
  editText(chat: string, messageId: string, text: string): Promise<void>;
  deleteMessage(chat: string, messageId: string): Promise<void>;
  typing(chat: string, on: boolean): Promise<void>;
  react(chat: string, messageId: string, emoji: string): Promise<void>;
  sendMedia(chat: string, media: OutboundMedia): Promise<{messageId: string}>;
  chatInfo(chat: string): Promise<{name: string; type: 'dm'|'group'}>;
}
// InboundMessage: already-normalized (canonical ids, kind, text, quoted, mentions, media buffers).
```
`FakeWhatsAppPort` (in-memory, records outbound, injects inbound) powers integration tests and
the conformance run; the router/relay layers never import Baileys.

## Work packages (Opus agents; I validate each before merge)

Order: WP1 → (WP2 ∥ WP3) → WP4 → WP5. WP2/WP3 run in separate git worktrees off the WP1 commit.

**WP1 — Scaffold, config, CLI skeleton, tooling** (1 agent)
- package.json/tsconfig/vite/vitest/eslint-free; `src/main.ts` with subcommand parsing; `src/config` schema+loader with `${ENV}` interpolation and all validation rules above; `src/util/log.ts`; `src/whatsapp/port.ts` + `InboundMessage` types; `src/relay/frames.ts` types for all frames; `config.example.yaml`; LICENSE; CI workflow (typecheck, test, build, docker build).
- Accept: `npm run typecheck && npm test && npm run build` green; `node dist/whatrouter.js check-config config.example.yaml` reports each validation error case (tests cover duplicates/overlaps).

**WP2 — Relay core** (1 agent)
- `relay/auth.ts` (token vectors above), `relay/frames.ts` line assembler, `store/*` (sqlite schema, buffer append/next/ack/flip/purge, policies, media index), `relay/session.ts` state machine (pure, socket-agnostic, unit-testable), `relay/server.ts` (Node `http` + `ws`, routes table, 4401-after-accept, duplicate-session 1008, ping/pong, per-IP throttle), `relay/media-routes.ts`, `relay/policy.ts`, wake poke, `/healthz`.
- Accept: unit tests for every state transition (hello→drain, going_idle→ack→buffer, ack-gated replay, stale ack ignored, reconnect drains, expired vs bad token reasons); integration test with real `ws` client speaking the frames; sqlite survives process restart (test reopens DB).

**WP3 — WhatsApp adapter** (1 agent)
- `whatsapp/baileys-client.ts` implementing `WhatsAppPort`; `jid.ts` (normalize, canonical, alt), `normalize.ts` (Baileys msg → `InboundMessage`, fixtures for: conversation, extendedText with quote+mentions, group message with `participantAlt`, image, ptt, document, sticker, location, ephemeral wrapper, fromMe), `format.ts` + `chunk.ts` (markdown→WA, chunk tests incl. code fences and 4096 boundary), `outbound.ts` (op payload builders with timeout + serialized queue), `pair.ts` (QR + `--code`), `fake.ts`.
- Accept: no network in tests (Baileys socket mocked/injected); fixtures cover LID cases; `whatrouter pair` manually verified by me against a phone (see Verification).

**WP4 — Router + wiring + conformance** (1 agent, after WP2+WP3 merge)
- `router/*`: route table, canonical matching, relevance gate (precedence rules), tenant check; `InboundMessage` → relay event JSON (exact shape above incl. `media[]`/`media_urls` re-hosting); outbound action dispatch → `WhatsAppPort`; `main.ts serve` composition; `/debug/inbound` behind `WHATROUTER_FAKE_WHATSAPP=1`; `scripts/conformance/probe.py` + `run.sh` (port of HRC's probe: handshake fields, live inbound parsed by real `_event_from_wire`, all op result shapes, unadvertised op failure, going_idle flip, ordered ack-gated replay across reconnect, no redelivery, bad-secret 4401 not latching, expired reason).
- Accept: integration tests: DM/group routing incl. LID alt, mention gating, two profiles zero cross-talk, profile B cannot `send` to A's chat, media upload/download auth scoping, unrouted drop vs `default_profile`.

**WP5 — README, Docker, compose, DX** (1 agent; can draft in parallel with WP4)
- README: what/why, architecture diagram, protocol summary + link to upstream contract, security model, quickstart (docker run pair → config → serve → Hermes `.env` lines → `hermes gateway restart`), `whatrouter env`, troubleshooting (4401, unpaired/loggedOut, LID/phone mismatch, mention gating, media URLs need `public_url`), limitations & ban-risk note (unofficial API; dedicated number), development section (tsx/vitest/conformance).
- Dockerfile + docker-compose.yml (volume, env, port); `.dockerignore`.
- Accept: `docker build` passes; `docker run … check-config` works; README commands copy-paste correctly (I follow them verbatim).

### Validation protocol (me, per package)
1. Read the full diff; check against the acceptance list and this spec (field names verbatim).
2. Run `npm run typecheck`, `npm test`, `npm run build`; for WP5 `docker build`.
3. Adversarial probes: frame without trailing `\n`; token with colons in id; expired token → reason `expired`; two profiles same secret; message for an unrouted chat; 4096-boundary chunk inside a code fence; profile A `send` to B's chat.
4. Return findings to the same agent via SendMessage; re-validate; merge only when clean. No scope creep beyond the WP.

## Verification (end-to-end)

1. **Unit + integration**: `npm test` (Vitest) green; coverage on auth, frames, session, store, router, normalize, format.
2. **Conformance vs real Hermes transport**: `HERMES_CHECKOUT=/path/to/hermes-agent scripts/conformance/run.sh` — starts WhatRouter with `WHATROUTER_FAKE_WHATSAPP=1`, drives `gateway.relay.ws_transport.WebSocketRelayTransport` (python + `websockets`; no LLM key, no full install) through all checks. I run this myself.
3. **Docker**: `docker build -t whatrouter .`; `docker run --rm -v wr:/data -v $PWD/config.yaml:/data/config.yaml whatrouter check-config`; `serve` exits 2 with pairing instructions when unpaired.
4. **Live pairing smoke (needs the user's phone)**: `docker run --rm -it -v wr:/data whatrouter pair` → scan → "connected as <number>" → restart `serve` → `/healthz` shows `connected`; repeat launch needs no QR.
5. **Live E2E with one Hermes instance**: paste `whatrouter env work` output into `~/.hermes/.env`, `hermes gateway restart`; DM the bot number from a routed phone → Hermes reply arrives (markdown converted, quoted reply); group with `require_mention` only answers @mentions; send a photo and a voice note → Hermes receives media; stop the gateway, send 3 messages, restart → delivered in order once.

## Risks / assumptions
- Relay contract is **experimental** (v1, additive-only); pin the verified upstream commit in `scripts/conformance/HERMES_PIN` and re-run conformance on upgrade.
- Baileys is unofficial; WhatsApp may restrict accounts. README recommends a dedicated number and no unsolicited outbound.
- LID resolution: when neither `key.*Alt` nor auth-state mapping yields a phone, the canonical id is the `@lid` JID; routes may therefore need the LID for some first-contact senders (documented; logged at info with the LID so operators can add it).
- `node:sqlite` is stable enough in Node 24 (verified: no experimental warning locally); Docker base pinned to Node 24.
- Baileys `getMessage`/retry semantics and 515 restart handled as in Hermes' bridge; edit is best-effort (WhatsApp allows edits of own messages for ~15 min).

## Implementation notes (post-review, 2026-09-22)

Deviations from the layout above that were accepted during review; the behaviour is unchanged.

- Frame assembly lives in `src/relay/ndjson.ts`; the policy and media HTTP routes live inside `src/relay/server.ts` (no separate `media-routes.ts` / `policy.ts`). Policies persist in `src/store/policy.ts`.
- `Session.idleFlipped` starts `false` on every new connection; the durable flip only gates live delivery and is cleared by the drain, exactly as in the Rust connector.
- `execute` answers `unsupported op: <op>` before the tenant check; every other op is tenant-checked first.
- The chat→profile memory that lets a `default_profile`-routed chat be replied to is in memory only (bounded at 1024); after a restart the chat must send again before a reply passes the tenant check.
- `config.example.yaml` ships `data_dir: /data` so the Docker quick start works verbatim; Node users set a relative path.
- The runtime image is ~750 MB, ~465 MB of which is Debian's `ffmpeg` (voice-note transcoding). A static ffmpeg would roughly halve it.
- Verified: `scripts/conformance/run.sh` passes 47/47 against `NousResearch/hermes-agent@2c65d5a` (see `scripts/conformance/HERMES_PIN`).
