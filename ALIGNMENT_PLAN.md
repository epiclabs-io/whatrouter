# WhatRouter: intent alignment plan

Outcome of the 2026-10-03 code review and owner interview. It records the intent the code is
meant to serve, the shortcuts that are deliberate, and the steps that bring code and docs in line.
**Delete this file in the last step**: once the work lands, the code and the README carry it.

## 1. Confirmed intent

- **Who:** one operator running WhatRouter for their own Hermes agents (work, home, ...), on a LAN
  or a single Docker host. No TLS reverse proxy is assumed.
- **Management plane is core.** `/mcp` (agent-facing tools) and `/management` (orchestrator
  WebSocket) are the normal way to operate a running router. `config.yaml` is the bootstrap and
  is written by the program afterwards. Hand edits happen only while the router is stopped.
- **Agents are isolated by chat and by network.** A compromised Hermes instance may only reach
  chats routed to it, and must not be able to use WhatRouter to reach anything on its network.
- **Docs are minimal.** They state intent and get users started. The code is the source of
  truth: no doc restates config keys, wire frames or tool lists that the code already defines.

### Principles (these become the README's "Design intent" section)

1. **One WhatsApp account, many agents, no shared credentials.** WhatRouter alone holds the
   WhatsApp session. Each agent has its own secret and sees only the chats routed to it.
2. **Follow the Hermes relay contract exactly.** The `/relay` wire format matches upstream and is
   checked against the real Hermes transport (`scripts/conformance`).
3. **Fail closed.** Unknown DMs are dropped (unless `default_profile` is set), unregistered groups
   are dropped, outbound actions are tenant-checked, and a new listen list lets nobody through.
4. **Never lose a message, never duplicate one.** An ack-gated, durable per-profile buffer
   replays everything in order after a restart on either side.
5. **Few moving parts.** One process, built-in sqlite, one YAML file, static secrets, and
   pairing as an explicit one-off. No enrollment, OIDC or REST API.
6. **Low ban risk.** A dedicated number, conversational traffic only, no avoidable WhatsApp
   requests, and no group discovery.
7. **Easy to operate.** `check-config` reports every problem at once, `env` prints exactly what
   Hermes needs, and exit codes are meaningful.

## 2. Decisions

### Accepted trade-offs (keep; document in the README)

Confirmed in the interview:

| #   | Trade-off                                                                                                                            | Why it is acceptable                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| K1  | `/healthz` needs no auth and shows profile names, connection and buffer state, holds and the version                                 | Container health checks need it. Bind privately if names are sensitive.              |
| K2  | `/mcp` and `/management` use plain HTTP and WS; there is no built-in TLS                                                             | LAN or single-host deployment. Put TLS in front if you expose it.                    |
| K3  | One management secret has full control: no scopes, no read-only token, no throttling of failed attempts                              | Personal use. 32+ characters makes guessing impractical.                             |
| K4  | `create_profile` (and `rotate_profile_secret`, step 1.7) write the generated secret inline in `config.yaml`                          | The file is written with mode 0600 and already holds other secrets.                  |
| K5  | Management holds live in memory, so a restart clears them                                                                            | A hold only lasts 20 s, and the orchestrator re-issues it.                           |
| K6  | Reply memory for chats delivered via `default_profile` is in memory (1,024 chats) and resets on restart and on any MCP config change | The contact writes again, after which the agent can reply.                           |
| K7  | A group route to an unregistered group only triggers a `check-config` warning; its messages are dropped                              | Registration and routing are independent by design.                                  |
| K8  | In a group, a message starting with `/` bypasses mention gating                                                                      | Slash commands are an explicit address to the bot.                                   |
| K9  | Hermes can relax mention gating via `POST /relay/policy` unless the route sets `require_mention`                                     | It affects only that agent's own groups, and the operator can pin the route setting. |
| K10 | `allow_unrouted_outbound` is one global switch                                                                                       | It is an escape hatch, off by default.                                               |

Carried over from the original design (still valid):

| #   | Trade-off                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- |
| K11 | No enrollment: `/relay/enroll` and `/relay/provision` return 404. The operator pastes four env lines (or uses `create_profile`).      |
| K12 | Baileys is unofficial and pinned to an exact version; ban risk is accepted and mitigated with a dedicated number.                     |
| K13 | LIDs are accepted wherever users are named, with a warning that they are opaque.                                                      |
| K14 | Edit streaming is on by default, so WhatsApp shows "edited" labels.                                                                   |
| K15 | Tokens with `exp=0` (never expire) are accepted, as upstream Hermes does.                                                             |
| K16 | Hand edits to `config.yaml` happen only while stopped; there is no file watch or lock.                                                |
| K17 | Unacked buffered messages are purged after `buffer.max_age_seconds` (14 d) and re-hosted media after `media.retention_seconds` (7 d). |
| K18 | `wa-auth/` and media are unencrypted at rest; protect the data directory.                                                             |
| K19 | `interrupt` frames are only logged (there are no connector-side turns to cancel).                                                     |
| K20 | There is no WhatsApp group discovery or deletion tool.                                                                                |
| K21 | Outbound actions a closed session already started may still reach WhatsApp; their results are dropped.                                |

### Changes (fix)

| Finding                                                                                                                           | Step     |
| --------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Conformance harness is stale: its config has no `groups:` registry, so the probe's group messages are dropped as rogue (verified) | 0.1, 0.2 |
| `send_media` fetches any URL an agent supplies (SSRF), and reads bodies without a size limit                                      | 1.1      |
| Inbound media is downloaded in full, with no size cap, before the registry, route and mention gates                               | 1.2      |
| A throttled relay upgrade is closed 4401, which Hermes latches as revoked; gateways sharing a source IP lock each other out       | 1.3      |
| `delete_profile` hands `default_profile` to an arbitrary other profile                                                            | 1.4      |
| `default_profile` also receives registered groups that have no route                                                              | 1.5      |
| Buffer, media and policy rows are keyed by profile name, so a hand rename orphans them and a re-created name inherits them        | 1.6      |
| MCP cannot edit an existing profile's routes, display name or wake URL, or rotate its secret                                      | 1.7      |
| `docker-compose.yml` mounts the config read-only (breaking MCP writes) and doesn't match the README quick start                   | 1.8      |
| Mixed live and boot config reads; four ways to pass config                                                                        | 2.1      |
| `relay/server.ts` is 1,030 lines and owns management and MCP                                                                      | 2.2      |
| Dead code, duplicated helpers and stale comments                                                                                  | 2.3      |
| About 1,100 lines of docs that restate code and contradict each other and the code                                                | 3.x      |

## 3. Steps

Each step lands on its own with `npm run typecheck && npm run lint && npm test` green. Phase 1
changes behaviour, Phase 2 must not, and Phase 3 is docs only.

### Phase 0: restore the safety net

**0.1 Fix the conformance config.** In `scripts/conformance/run.sh`, register the probe's group
so the registry gate lets it through:

```yaml
groups:
  "120363000000000001@g.us":
    listen_source: explicit
    listen: ["*"]
```

Done when `HERMES_CHECKOUT=… scripts/conformance/run.sh` passes every check against
`HERMES_PIN`.

**0.2 Run conformance in CI.** Add a `conformance` job to `.github/workflows/ci.yml`:

- check out `NousResearch/hermes-agent` at the commit in `scripts/conformance/HERMES_PIN`;
- install uv with `astral-sh/setup-uv`;
- run `run.sh`.

This harness enforces principle 2 and has already gone stale once without anyone noticing.

### Phase 1: behaviour fixes

**1.1 `send_media` cannot reach private networks.** Hermes passes public URLs straight through
(`gateway/relay/adapter.py` `_send_media`: "an already-public URL (passed through)"), so
restricting to WhatRouter's own media URLs would break it.

- Add `src/util/public-fetch.ts`, with no new dependency:
  - accept only `http:` and `https:`;
  - use `node:http(s)` with a `lookup` hook that rejects these addresses:
    - loopback, `0.0.0.0/8`;
    - RFC 1918 private ranges;
    - `100.64/10`;
    - link-local `169.254/16`, which includes cloud metadata;
    - multicast;
    - `::1`, `fc00::/7`, `fe80::/10`;
    - IPv4-mapped forms of all of the above.

    The hook checks the address actually dialled, so DNS rebinding can't slip past it.

  - follow at most 3 redirects, re-checking each hop;
  - stream the body and abort past `media.max_bytes`. This replaces `res.arrayBuffer()` at
    `router/router.ts:254`, which today buffers an unbounded chunked body;
  - keep the existing 30 s timeout.
- `router/router.ts:245` uses it. WhatRouter's own `/relay/media/<id>` URLs still resolve locally
  (`router.ts:230-243`).
- Make the address check injectable so integration tests can reach a local server.
- Tests:
  - classifier unit tests;
  - `send_media` to `http://127.0.0.1:…` and to `http://169.254.169.254/` fails;
  - a redirect from a public to a private address fails;
  - an oversized chunked body fails;
  - a WhatRouter media URL still works.

**1.2 Download inbound media only after the gates, with a cap.**

- `whatsapp/port.ts`: `InboundMedia` drops `bytes` and gains `declaredSize: number | null`
  (from the proto `fileLength`) and `download(maxBytes): Promise<Uint8Array>`. Drop
  `InboundMessage.downloadFailed`.
- `whatsapp/normalize.ts:333-352`: stop downloading; build the descriptor around `ctx.download`.
  Make the group-subject lookup lazy too, so a rogue group triggers no WhatsApp metadata request.
- `whatsapp/baileys-client.ts:326-337`: download as a `'stream'` and abort once `maxBytes` is
  exceeded.
- `router/router.ts:112-134`: `storeMedia` becomes async and runs only after the registry,
  route, listen and relevance gates have passed.
  - If `declaredSize > media.max_bytes`, skip the download.
  - Otherwise download with the cap.
  - On failure, append `[<kind> could not be downloaded]` or `[<kind> too large]` to the text.
    This logic moves here from normalize. The message is still delivered.
- Update `whatsapp/fake.ts` and the `/debug/inbound` parser to wrap their bytes in a closure.
- Tests:
  - a rogue group, an unrouted chat, and an unaddressed group message each with media → the
    download is never called;
  - an oversized declared size → no download, and the note is added;
  - a stream that crosses the cap is aborted, and the note is added.

**1.3 A throttled relay upgrade can be retried; it is not treated as revoked.** In
`relay/server.ts:406`, a `throttled` outcome closes with `1013 "try again later"`. Expired tokens
still close `4401 expired` and everything else `4401 unauthorized`. HTTP routes keep 429.

Test: after 10 bad attempts from one IP, a valid gateway from that IP gets 1013 rather than 4401,
and connects once the window passes.

**1.4 `delete_profile` fails closed.** In `mcp/tools.ts:650-655`, when the deleted profile was
`default_profile`, set `default_profile: null` instead of the first remaining profile.

- The result reports `defaultProfile: null` with the warning "default_profile cleared; unrouted
  DMs are now dropped".
- Update the tool description.
- Test: the MCP integration case.

**1.5 `default_profile` applies to DMs only.** In `router/routes.ts:124`, fall back only when
`m.chatType === "dm"`; groups need an explicit route.

- Change the `config/load.ts:577-584` warning to `registered group "<id>" has no profile route;
its messages are dropped`.
- Update the `default_profile` comment in `config.example.yaml`.
- Tests:
  - router unit test;
  - serve integration test: a registered, unrouted group with `default_profile` set is dropped.

**1.6 No per-profile state outlives its profile name.** When `serve` starts, after opening the
store and before listening:

- delete buffer, media (rows and files) and policy rows whose profile is not in the config;
- log a warning with the counts for each removed name.

`BufferStore.profiles()`, unused today, provides the buffer side; add the same query for media
and policy. MCP `delete_profile` already purges through `removeProfile`.

Test: rows seeded for a ghost profile are gone after start, and rows for a real profile remain.

**1.7 MCP covers the whole operator workflow.** Add to `mcp/tools.ts`:

- `update_profile { name, display_name?, wake_url?, routes? }`:
  - `routes` replaces the whole list, the same semantics as `set_listen_list`;
  - `ConfigStore` validates it, so route conflicts are rejected;
  - warnings are returned.
- `rotate_profile_secret { name }`:
  - generates a new secret with the `create_profile` generator and returns the new env lines
    once;
  - after the config write, closes the live relay session with `4401 unauthorized`, so the old
    instance stops until it restarts with the new secret;
  - keeps buffered messages;
  - the relay exposes `revokeSession(profile)` for this.
- Profile rename and `gateway_id` changes are not added; delete and create covers them.
- Tests:
  - both tools;
  - a route conflict is rejected;
  - rotation closes the live session, the old token gets 4401, and the new one connects.

**1.8 Docker layout matches the docs and allows MCP writes.**

- `docker-compose.yml`: replace the `whatrouter-data` named volume and
  `./config.yaml:/data/config.yaml:ro` (line 37) with `./data:/data`.
- Rewrite the compose header for the flow `mkdir data && cp config.example.yaml data/config.yaml`,
  and note that `./data` must be writable by uid 1000, the image's `node` user.
- Align the `Dockerfile` header comments (lines 3-7) with `-v "$PWD/data:/data"`.
- The CI `docker` job's read-only check-config mount stays, since validation needs no writes.

Done when the README Docker quick start works verbatim on a clean host, and an MCP
`register_group` persists into `./data/config.yaml`.

### Phase 2: structure (no behaviour change)

**2.1 One config source; explicit live and boot settings.**

- Replace `config` + `getConfig` + `configStore` + `configPath`:
  - affected: `ServeOptions`, `RelayServerOptions` and `RouterOptions`;
  - every module takes `getConfig: () => Config`, and only MCP also takes the `ConfigStore` for
    writes;
  - tests pass `() => config`.
- Settings MCP can change are **live**: `profiles`, `groups`, `default_profile`. Everything else
  is **read once at boot**.
- Today the reads are mixed:
  - `/relay/media` upload uses the live `media.max_bytes` (`server.ts:578`) while the store
    enforces the boot value;
  - the wake cooldown and purge ages are read live.

  So a hand edit can half-apply after the next MCP mutation.

- Drop the duplicate `ConfigStore.current` accessor and keep `get()`.

**2.2 Split `relay/server.ts` and invert the management dependency.** Today `relay/` imports
`management/` and `mcp/` and builds both. Target:

| Module                    | Owns (current location)                                                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/http/server.ts`      | `node:http` server, request and upgrade dispatch by path, listen and close with grace; shared `readBody` / `sendJson` / `rawToString` (`server.ts:194-239`, `mcp/endpoint.ts:33-46,168-186`, `management/endpoint.ts:61`) |
| `src/relay/gate.ts`       | `authenticate(req)`, the per-IP `FailureThrottle`, close-code mapping (`server.ts:147-192, 259-339`)                                                                                                                      |
| `src/relay/hub.ts`        | relay sessions: attach, duplicate, ping/pong, detach, revoke; live-or-buffer `deliver()`; wake poke. Takes `isHeld(profile)` and `onDelivered(…)` callbacks (`server.ts:425-504, 679-710, 955-982`)                       |
| `src/relay/http.ts`       | `/relay/policy`, `/relay/media` upload and download, `/healthz` (`server.ts:508-663`)                                                                                                                                     |
| `src/management/holds.ts` | hold map, expiry timers, wake-on-expiry, `closeProfile` / `releaseProfile` (`server.ts:714-821`)                                                                                                                          |
| `src/debug-inbound.ts`    | `POST /debug/inbound` body parsing (`serve.ts:493-648`)                                                                                                                                                                   |
| `src/serve.ts`            | composition only:<br>• hub ↔ holds ↔ management endpoint (`onDelivered` → `publish`) ↔ MCP endpoint<br>• the maintenance timer<br>• the startup reconciliation from 1.6                                                   |

Afterwards `relay/` imports neither `management/` nor `mcp/`; `serve.ts` is the only module that
knows all of them. Keep the existing test seams (`nowMs`, `scheduleHoldExpiry`, `fetchImpl`) on
the modules that own them now.

**2.3 Remove dead code, duplicates and stale comments.**

Dead (no production caller):

- The durable `flips` table: `setBufferedOnly`, `isBufferedOnly`, and the flip half of
  `clearFlipIfEmpty` (`relay/session.ts:181,242`, `store/buffer.ts`).
  - Every new session already starts with `liveOk=false`, so "buffer until drained" holds without
    the table.
  - Use `count(profile) === 0` instead, and add migration 2: `DROP TABLE IF EXISTS flips`.
  - The conformance `going_idle` and replay checks must stay green.
- `MediaStore.delete`, `MediaPutResult.url`, `MediaStoreOptions.urlFor`,
  `OpenStoreOptions.mediaUrlFor`, `loadConfig`, `resetMediaUrlWarning`,
  `BaileysClient.onStateChange`, `BaileysClient.authDir()`.
- `RelayServer.isConnected` / `bufferedCount` / `address` and `RouteTable.rememberedSize`: these
  exist only for tests. Assert through `health()` and observable behaviour instead.
- `makeToken`: move it to `test/helpers`. Production never mints tokens; the comment at
  `relay/auth.ts:25` says `whatrouter env` uses it, but it doesn't.
- `InboundMessage.timestamp` and `mentionedIds`: they never reach the wire or a decision.
- `RelayPolicy.platform`, `freeResponseScopes`, `allowOtherBots`: stored, never read. Keep
  `requireAddress`.
- The `formattedIdentity` pass-through (`config/store.ts:43-46`).

Duplicates:

- `resolveVersion` (`whatsapp/baileys-client.ts:468`, `whatsapp/pair.ts:56`) becomes one export.
- Exit codes are duplicated in `serve.ts:37` "to avoid an import cycle"; move them to
  `src/exit-codes.ts`.
- The ping/pong heartbeat loop exists in both the relay and the management endpoint.

Stale comments and constants:

- `relay/descriptor.ts:33`: "Off by default"; the default is on.
- `relay/frames.ts:3-4`: refers to "WP2".
- `relay/server.ts:1029`: the "WP4" re-export; delete the re-export.
- `config/schema.ts:75,138`: the management block also gates `/mcp`.
- `mcp/tools.ts:185`: MCP server `version: "1.0.0"`; use the package version.

### Phase 3: docs (the code is the source of truth)

**3.1 Delete `docs/DESIGN.md`.** Where its content goes:

| Content                                                                 | Goes to                                                                                                                                   |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Work packages, validation protocol, orchestration notes                 | Deleted; git history keeps them                                                                                                           |
| Wire protocol, descriptor, event shape, op table                        | Already in `relay/frames.ts`, `relay/descriptor.ts`, `router/event.ts`, `router/router.ts`, plus the upstream contract link in the README |
| Token test vectors                                                      | Already in `test/unit/relay-auth.test.ts`                                                                                                 |
| Management WebSocket contract (guarantees, close codes, hold semantics) | The `src/management/frames.ts` header, which today lacks the close codes and the 1 MiB backpressure rule (README:443-453)                 |
| Decisions, risks, implementation notes                                  | README "Design intent and trade-offs" (§2 of this plan)                                                                                   |

**3.2 Rewrite the README** to roughly 250 lines (from 576), in this order:

1. **What and why:** the current three-paragraph intro and the ban-risk disclaimer.
2. **Architecture:** the ASCII sketch, a three-sentence protocol summary (buffering, acks, wake),
   and the trust model, updated for agent network isolation and full-control management.
3. **Design intent and trade-offs:** the seven principles, then K1-K21, one or two lines each.
4. **Quick start (Docker):** tested verbatim with `./data`. Include setting
   `management.secret`, since management is core.
5. **Quick start (Node).**
6. **Hermes side:** the four env lines (keep the short table) and `hermes gateway restart`.
7. **Configuration**, one paragraph covering:
   - `config.example.yaml` is the commented reference;
   - which settings are live and which are read at boot;
   - hand edits only while stopped;
   - `${ENV}` and `secret_file`.
8. **Management:** one paragraph each.
   - `/mcp`: tools describe themselves (`tools/list`).
   - `/management`: the contract lives in `src/management/frames.ts`.
   - Add a "bind privately" note.
9. **Operations:** health, logs, stop, backup, upgrade, secret rotation (now
   `rotate_profile_secret`), config edits. One or two lines each.
10. **Troubleshooting:** keep the table. Add the 1013 throttling row and drop rows that can no
    longer happen.
11. **Development:** scripts, conformance, and the repo layout updated for Phase 2. No DESIGN link.

Removed:

- the config reference tables (README:193-281);
- the MCP tool table (README:476-500);
- the management framing and close-code detail (README:398-453);
- the contradictions, such as README:298-300 saying edit streaming is off by default and the
  quick start's `data/config.yaml` that compose never mounted.

**3.3 Make `config.example.yaml` the reference.**

- Every key appears, commented out if optional, with its default and a one-line meaning. This is
  the content of the deleted README tables, compressed.
- Mark the keys MCP manages live.
- Say plainly that the top-level `listen` is the bind address while `groups.*.listen` is the
  sender allowlist. Don't rename either key; that would break existing configs.

**3.4 MCP tool descriptions stand alone.** With the README table gone, each description must
carry its own semantics:

- `register_group`: the sole-admin rule;
- `join_group_by_invite` and `create_group`: they don't register or route the group;
- `delete_profile`: the new default handling;
- the new tools from 1.7.

### Phase 4: final verification

- `npm run format:check && npm run lint && npm run check` passes.
- CI conformance (0.2) passes against `HERMES_PIN`.
- Run the README Docker quick start verbatim on a clean host:
  1. pair, then complete a DM round trip;
  2. `register_group`, then `update_profile` adds the group route, then a mention is delivered;
  3. `rotate_profile_secret`: the old gateway gets 4401 and the new env works;
  4. a rogue group's media is never downloaded (check the logs).
- `grep -rn "DESIGN.md\|WP[0-9]" .` finds nothing outside git history.
- Delete this file.

## 4. Deliberately out of scope

- Built-in TLS, scoped or read-only management tokens, and throttling of management auth (K2, K3).
- Persisting holds or reply memory (K5, K6).
- A per-profile `allow_unrouted_outbound` (K10).
- Renaming the `listen` key, `X-Forwarded-For` support (there's no proxy), encryption at rest,
  group discovery, and stricter ESLint rule sets.
