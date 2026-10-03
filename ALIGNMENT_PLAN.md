# WhatRouter: intent alignment work order

This is a work order for an engineer who was not part of the review that produced it. It explains
what WhatRouter is meant to be, which questions are already settled, and exactly what to change.
**The last step deletes this file**: once the work lands, the code and the README carry it.

## 0. How to work on this

**Base.** Branch `claude/code-philosophy-review-kf02rb`: commit `5d827c6` (the head of `dev` at
review time) plus this file. At that base all 452 tests pass and typecheck, lint and format are
clean.

**Where the work goes.** Open pull requests against `claude/code-philosophy-review-kf02rb`, not
`dev` or `master`.

- The reviewer reviews and merges them into that branch.
- When everything is approved, the reviewer merges the branch into `dev`.
- Split the work into PRs however you like, but **never mix behaviour changes (Phase 1) with pure
  refactors (Phase 2) in one PR.**

**Order.** Phase 0 → 1 → 2 → 3. Phase 2 moves code that Phase 1 edits; doing it in this order
moves each piece of code only once.

**Line numbers** in this document refer to commit `5d827c6` and will drift as you work. Find the
code by the function or symbol name given next to them.

**Settled decisions are settled.** §3 records what the owner confirmed. If you think one is wrong,
say so in the PR; don't silently do something else.

**Setup and checks:**

- Node 24 is required for `node:sqlite`. Tests also run on Node 22, with an experimental-feature
  warning.
- `npm ci`
- Before every push:

  ```bash
  npm run format:check && npm run lint && npm run typecheck && npm test && npm run build
  ```

- A husky pre-commit hook runs typecheck, lint-staged and format:check.
- Tests never touch the network. Use the WhatsApp fake in `src/whatsapp/fake.ts`, the injectable
  socket in `test/unit/wa-client.test.ts`, and the `fetchImpl` / `nowMs` / `scheduleHoldExpiry`
  seams. Unit tests go in `test/unit/`, integration tests in `test/integration/`, helpers in
  `test/helpers/`.
- Local conformance (`scripts/conformance/run.sh`) needs `uv` and a `hermes-agent` checkout at the
  commit in `scripts/conformance/HERMES_PIN`. After step 0.2, CI runs it for you.

**Commits** follow the repo's Conventional Commits style with a scope, as in `fix(mcp): …` or
`feat(router): …`. The body explains why. One logical change per commit.

**What you can't verify.** Pairing a phone and live WhatsApp and Hermes tests need the owner's
bot number. The owner runs §6 at the end. You rely on the automated tests and CI conformance.

## 1. Context

**WhatRouter** connects one WhatsApp account to many Hermes AI agents. It holds the only WhatsApp
session (via Baileys, an unofficial client) and multiplexes it to any number of
[Hermes Agent](https://github.com/NousResearch/hermes-agent) instances over Hermes' relay
protocol.

- Each Hermes instance is a **profile** with a `gateway_id`, a secret, and **routes**: the DMs and
  groups it owns.
- Inbound messages for an offline agent are buffered in sqlite and replayed in order, each one
  waiting for the agent's acknowledgement.
- An optional management plane can create and delete profiles, manage WhatsApp groups, and
  rewrite the live `config.yaml`:
  - `/mcp`: Streamable HTTP MCP, the tools an agent uses;
  - `/management`: a WebSocket an orchestrator uses to suspend and resume agents.

Code map (at the base commit):

| Path              | What                                                                                                                                                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/cli.ts`      | Commands: `serve`, `pair`, `env`, `check-config`                                                                                                                                                               |
| `src/serve.ts`    | Composition root, plus the `/debug/inbound` parser for fake mode                                                                                                                                               |
| `src/config/`     | `schema.ts` (zod plus the normalized `Config`), `load.ts` (validation), `store.ts` (`ConfigStore`: live, comment-preserving atomic writes)                                                                     |
| `src/relay/`      | `server.ts` (HTTP server, `/relay` WebSocket, holds, wake, media and policy routes, MCP mount; 1,030 lines), `session.ts` (per-connection state machine), `auth.ts`, `frames.ts`, `ndjson.ts`, `descriptor.ts` |
| `src/router/`     | `routes.ts` (route table, tenant check), `relevance.ts` (registry listen gate, mention gate), `event.ts` (wire event), `router.ts` (inbound pipeline, outbound ops)                                            |
| `src/management/` | The `/management` WebSocket (`endpoint.ts`, `frames.ts`, `auth.ts`)                                                                                                                                            |
| `src/mcp/`        | `/mcp` endpoint and its 23 tools                                                                                                                                                                               |
| `src/store/`      | `node:sqlite`: buffer, policies, media index                                                                                                                                                                   |
| `src/whatsapp/`   | `port.ts` (the interface the rest of the code uses), `baileys-client.ts`, `normalize.ts`, `pair.ts`, `fake.ts`, formatting and chunking                                                                        |

**How this plan was made.** On 2026-10-03 the whole codebase was reviewed at `5d827c6`, then the
owner was interviewed in several rounds. Facts verified during the review:

- **The conformance harness is stale.** Its config routes a group that isn't in the `groups:`
  registry added in `cf25e5c`. Booting WhatRouter in fake mode with that config and injecting the
  probe's group message logged `rogue unregistered group dropped`.
- **Hermes passes public URLs straight to `send_media`.** At the pinned commit `2c65d5a`,
  `gateway/relay/adapter.py` `_send_media` says: "`source` is a LOCAL path (uploaded to
  /relay/media first …) or an already-public URL (passed through)". So `send_media` must keep
  fetching public URLs.
- **Media is downloaded before any gate.** `normalizeInbound` downloads it before the router's
  registry, route and mention gates run, even though commit `cf25e5c` says rogue groups are
  dropped "before routing, media, or buffering".
- **The shipped Docker files contradict the docs.** `docker-compose.yml` mounts `config.yaml`
  read-only, which breaks every MCP config write, and the README quick start writes
  `./data/config.yaml`, which compose never mounts.

## 2. Intent (confirmed by the owner)

- **Who:** one operator running WhatRouter for their own Hermes agents (work, home, …), on a LAN
  or a single Docker host. No TLS reverse proxy is assumed.
- **The management plane is core.** `/mcp` and `/management` are the normal way to operate a
  running router. `config.yaml` is the bootstrap and is written by the program afterwards. Hand
  edits happen only while the router is stopped.
- **Agents are isolated by chat and by network.** A compromised Hermes instance may only reach
  chats routed to it, and must not be able to use WhatRouter to reach anything on its network.
- **Docs are minimal.** They state intent and get users started. The code is the source of
  truth: no doc restates config keys, wire frames or tool lists that the code already defines.

Principles (these become the README's "Design intent" section):

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

## 3. Settled decisions

### 3.1 Accepted trade-offs: keep the behaviour and document it

Don't "fix" these. Phase 3 documents them in the README. The rationale column is the reviewer's
wording; list K1-K21 in the Phase 3 PR description so the owner can correct the wording there.

| #   | Trade-off                                                                                                                            | Rationale (owner to confirm the wording)                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| K1  | `/healthz` needs no auth and shows profile names, connection and buffer state, holds and the version                                 | Container health checks need it. Bind privately if names are sensitive.              |
| K2  | `/mcp` and `/management` use plain HTTP and WS; there is no built-in TLS                                                             | LAN or single-host deployment. Put TLS in front if you expose it.                    |
| K3  | One management secret has full control: no scopes, no read-only token, no throttling of failed attempts                              | Personal use. 32+ characters makes guessing impractical.                             |
| K4  | `create_profile` and `rotate_profile_secret` write the generated secret inline in `config.yaml`                                      | The file is written with mode 0600 and already holds other secrets.                  |
| K5  | Management holds live in memory, so a restart clears them                                                                            | A hold only spans the seconds between `close_profile` and suspending the agent.      |
| K6  | Reply memory for chats delivered via `default_profile` is in memory (1,024 chats) and resets on restart and on any MCP config change | The contact writes again, after which the agent can reply.                           |
| K7  | A group route to an unregistered group only triggers a `check-config` warning; its messages are dropped                              | Registration and routing are independent by design.                                  |
| K8  | In a group, a message starting with `/` bypasses mention gating                                                                      | Slash commands are an explicit address to the bot.                                   |
| K9  | Hermes can relax mention gating via `POST /relay/policy` unless the route sets `require_mention`                                     | It affects only that agent's own groups, and the operator can pin the route setting. |
| K10 | `allow_unrouted_outbound` is one global switch                                                                                       | It is an escape hatch, off by default.                                               |
| K11 | No enrollment: `/relay/enroll` and `/relay/provision` return 404                                                                     | The operator pastes four env lines, or uses `create_profile`.                        |
| K12 | Baileys is unofficial and pinned to an exact version                                                                                 | The ban risk is accepted and mitigated with a dedicated number.                      |
| K13 | LIDs are accepted wherever users are named                                                                                           | Validation warns that they are opaque.                                               |
| K14 | Edit streaming is on by default                                                                                                      | Streaming replies are worth WhatsApp's "edited" label; it can be turned off.         |
| K15 | Tokens with `exp=0` (never expire) are accepted                                                                                      | Upstream Hermes accepts them too.                                                    |
| K16 | Hand edits to `config.yaml` only while stopped; there is no file watch or lock                                                       | The management plane owns the file while the router runs.                            |
| K17 | Unacked buffered messages are purged after `buffer.max_age_seconds` (14 d), re-hosted media after `media.retention_seconds` (7 d)    | Bounded disk use.                                                                    |
| K18 | `wa-auth/` and media are unencrypted at rest                                                                                         | Protect the data directory instead.                                                  |
| K19 | `interrupt` frames are only logged                                                                                                   | There are no connector-side turns to cancel.                                         |
| K20 | No WhatsApp group discovery or deletion tool                                                                                         | Discovery adds ban risk; WhatsApp only offers leaving, not deleting.                 |
| K21 | Outbound actions a closed session already started may still reach WhatsApp; their results are dropped                                | Cancelling an in-flight WhatsApp send isn't possible.                                |

### 3.2 Decisions on how to fix things

| #   | Decision                                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | `send_media` keeps fetching public URLs but refuses any URL that resolves to a private, loopback, link-local or otherwise non-public address. **There is no allowlist** for LAN hosts.                                                   |
| D2  | Inbound media is downloaded only after every gate passes, never beyond `media.max_bytes`.                                                                                                                                                |
| D3  | A throttled relay upgrade closes `1013` (retryable), never `4401`.                                                                                                                                                                       |
| D4  | Deleting the `default_profile` profile sets `default_profile: null` (fail closed).                                                                                                                                                       |
| D5  | `default_profile` applies to DMs only; groups need an explicit route.                                                                                                                                                                    |
| D6  | When the router starts, per-profile state (buffer, media, policy) belonging to profile names that aren't in the config is deleted.                                                                                                       |
| D7  | New MCP tools `update_profile` and `rotate_profile_secret`. In `update_profile`, `null` clears a field and leaving a field out keeps it. `rotate_profile_secret` **refuses** profiles whose secret comes from `secret_file` or `${ENV}`. |
| D8  | A group's chat name comes from the registry `display_name`, else the cached live WhatsApp subject. That lookup happens only after the registry gate passes.                                                                              |
| D9  | Docker: compose bind-mounts `./data:/data`; the config lives at `./data/config.yaml`.                                                                                                                                                    |
| D10 | Only settings MCP can change are live (`profiles`, `groups`, `default_profile`); everything else is read once at boot.                                                                                                                   |
| D11 | Split `relay/server.ts` along the interfaces in §4 Phase 2; `relay/` must not import `management/` or `mcp/`.                                                                                                                            |
| D12 | Delete `docs/DESIGN.md`. Its useful content moves to a much shorter README, `config.example.yaml` becomes the config reference, and the management WebSocket contract moves into `src/management/frames.ts`.                             |

## 4. Work

### Phase 0: restore the safety net

**0.1 Fix the conformance config.** In `scripts/conformance/run.sh`, add a `groups:` registry
entry to the heredoc config so the registry gate lets the probe's group through:

```yaml
groups:
  "120363000000000001@g.us":
    listen_source: explicit
    listen: ["*"]
```

Done when `HERMES_CHECKOUT=<checkout at HERMES_PIN> scripts/conformance/run.sh` passes every check.

**0.2 Run conformance in CI.** Add this job to `.github/workflows/ci.yml`. The Hermes repository
is public.

```yaml
conformance:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with: { node-version: "24", cache: npm }
    - run: npm ci
    - id: pin
      run: |
        read -r spec _ < scripts/conformance/HERMES_PIN
        echo "repo=${spec%@*}" >> "$GITHUB_OUTPUT"
        echo "sha=${spec#*@}" >> "$GITHUB_OUTPUT"
    - uses: actions/checkout@v4
      with:
        repository: ${{ steps.pin.outputs.repo }}
        ref: ${{ steps.pin.outputs.sha }}
        path: hermes-agent
    - uses: astral-sh/setup-uv@v6
    - run: scripts/conformance/run.sh
      env:
        HERMES_CHECKOUT: ${{ github.workspace }}/hermes-agent
```

### Phase 1: behaviour fixes

Each step needs tests that fail before the change and pass after it.

**1.1 `send_media` cannot reach private networks (D1).**

Today `resolveMedia` in `src/router/router.ts` (lines 229-265) calls `fetch(sourceUrl)` on any
URL. It also calls `res.arrayBuffer()`, which buffers an unbounded body when there is no
`Content-Length`.

Add `src/util/public-fetch.ts`, with no new dependency:

```ts
export interface PublicFetchOptions {
  maxBytes: number;
  timeoutMs: number; // 30_000, as today
  /** Test seam. Default: the non-public ranges below. */
  isBlocked?: (ip: string) => boolean;
}
export type PublicFetchResult =
  { ok: true; bytes: Uint8Array; mime: string } | { ok: false; error: string };
export function fetchPublic(url: string, opts: PublicFetchOptions): Promise<PublicFetchResult>;
```

- **Schemes:** only `http:` and `https:`. Anything else returns `source_url not allowed`.
- **Blocked ranges:** build them with `net.BlockList`.
  - IPv4: `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`,
    `172.16.0.0/12`, `192.0.0.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `224.0.0.0/4`,
    `240.0.0.0/4`.
  - IPv6: `::/128`, `::1/128`, `64:ff9b::/96`, `fc00::/7`, `fe80::/10`, `ff00::/8`.
  - Convert IPv4-mapped IPv6 (`::ffff:a.b.c.d`) to IPv4 before checking.
- **Where to check:**
  - Pass a `lookup` function to `http.request` / `https.request`; it resolves, then fails if
    _any_ returned address is blocked. Checking the address actually dialled leaves no DNS
    rebinding window.
  - Handle both callback forms: Node calls `lookup` with `{ all: true }` and expects an array
    when `autoSelectFamily` is on.
  - Node skips `lookup` for IP-literal hosts, so check a literal IP directly before the request.
- **Redirects:** follow 301, 302, 303, 307 and 308 manually, at most 3, resolving relative
  `Location` headers. Each hop goes through the same checks. More than 3 returns
  `too many redirects`.
- **Body:** stream it, counting bytes, and destroy the request past `maxBytes`. Too large returns
  `media is larger than <maxBytes> bytes`, the existing wording.
- **Other results:**
  - a blocked address returns `source_url not allowed`;
  - a non-2xx status returns `could not fetch media: HTTP <status>`;
  - network errors and timeouts return `could not fetch media: <message>`;
  - `mime` comes from the final response's `Content-Type` (default `application/octet-stream`).
- In `resolveMedia`, WhatRouter's own `/relay/media/<id>` URLs keep resolving from the store, as
  today. Everything else goes through `fetchPublic`.
- The router's `fetchImpl` test seam becomes a `fetchMedia` option with the same shape as
  `fetchPublic`.

Tests:

- unit tests for the classifier, covering every range, IPv4-mapped addresses and a public
  control;
- unit tests for `fetchPublic` against local servers, with `isBlocked` injected:
  - a default-blocked `127.0.0.1` is refused;
  - an allowed address is fetched;
  - a redirect into a blocked address is refused (for example, server A on `127.0.0.1`
    redirects to `127.0.0.2`, which the injected classifier blocks);
  - more than 3 redirects is refused;
  - a chunked body over the cap is refused;
- integration: `send_media` with `http://169.254.169.254/latest` returns
  `{ success: false, error: "source_url not allowed" }`, and a WhatRouter media URL still sends.

**1.2 Download inbound media only after the gates, with a cap (D2, D8).**

Today `normalizeInbound` in `src/whatsapp/normalize.ts` (lines 333-352) downloads every
attachment in full. It also looks up the group subject (lines 306-317), a WhatsApp request, for
every group message, including rogue groups and messages that will be dropped.

1. **Port (`src/whatsapp/port.ts`).**

   ```ts
   export interface InboundMedia {
     kind: MediaKind;
     mime: string;
     filename?: string;
     caption?: string;
     /** From the proto `fileLength` (number or Long); null when absent. */
     declaredSize: number | null;
     /** Downloads at most `maxBytes`; rejects with MediaTooLargeError beyond that. */
     download(maxBytes: number): Promise<Uint8Array>;
   }
   ```

   Remove `InboundMessage.downloadFailed`. For groups, `normalizeInbound` sets `chatName: ""`;
   the router fills it in.

2. **Normalize.**
   - Don't download. Build `InboundMedia` around `ctx.download`.
   - Remove `NormalizeContext.groupSubject`.
   - The "drop a message with no usable payload" rule becomes
     `kind === "other" && text === "" && media === null`.
   - Generalize `toUnixSeconds` into a `Long`-aware number helper for `fileLength`.

3. **Baileys client (`download`, lines 326-337).** Call
   `downloadMediaMessage(msg, "stream", {}, { logger, reuploadRequest })`. Count chunks, destroy
   the stream, and throw `MediaTooLargeError` (from `src/store/media.ts`) once `maxBytes` is
   exceeded.

4. **Router (`onInbound`, `storeMedia`).**
   - After the registry, route, listen and relevance gates all pass:
     - **Group name:** use `config.groups[id].displayName` if it isn't empty; else
       `await whatsapp.getGroupMetadata(id)` and use `.subject`, which is cached for 5 minutes;
       on any error, or if empty, use the group's digits.
     - **Media:** `storeMedia` becomes async.
       - If `declaredSize > media.max_bytes` (the boot value), don't download; append
         `[<kind> too large to forward]` to the text.
       - Otherwise call `download(maxBytes)` and store the result.
       - If that throws `MediaTooLargeError`, append the same note. On any other error, append
         `[<kind> could not be downloaded]`, the wording that used to live in normalize.
   - Deliver the message in every case.
5. **Fake and debug.** `src/whatsapp/fake.ts` and the `/debug/inbound` parser (`serve.ts`,
   `inboundFromDebugBody`) wrap their bytes in a `download` closure that respects `maxBytes`.

Tests (with a spy on `download` and on `getGroupMetadata`):

- a message from a rogue group, an unrouted DM and an unaddressed group message, each with
  media: no `download` and no `getGroupMetadata` calls;
- a registered group with `display_name`: no `getGroupMetadata` call;
- an oversized `declaredSize`: no `download`, and the note is in the text;
- a stream that crosses the cap: aborted, and the note is in the text;
- a normal image is stored and delivered as today.

**1.3 A throttled relay upgrade is retryable (D3).**

The per-IP throttle (`FailureThrottle`, 10 failures in 60 s) currently closes a throttled
WebSocket with `4401 unauthorized` (`onUpgrade`, `src/relay/server.ts:406`). Hermes treats a
4401 after the handshake as revocation and stops reconnecting. Gateways behind one Docker host
port can share a source IP, so one misconfigured gateway can lock out the others.

- Change: `throttled` → `ws.close(1013, "try again later")`. Expired tokens still close
  `4401 "expired"`, and everything else `4401 "unauthorized"`.
- HTTP routes keep 429.
- Test: after 10 bad attempts from one IP, a correctly signed upgrade from that IP closes 1013,
  not 4401, and succeeds once the window has passed (use the time seams).

**1.4 `delete_profile` fails closed (D4).**

In `src/mcp/tools.ts`, the `delete_profile` mutator (lines 641-658) sets `default_profile` to the
first remaining profile when the deleted one was the default.

- Change: set it to `null` instead.
- Return `defaultProfile: null` and add the result warning
  `default_profile cleared; unrouted DMs are now dropped`.
- Update the tool description to say so.
- Update the existing test and add a case where a profile that isn't the default is deleted and
  `default_profile` is untouched.

**1.5 `default_profile` applies to DMs only (D5).**

- In `resolveProfile` (`src/router/routes.ts:124`), fall back to `default_profile` only when
  `m.chatType === "dm"`.
- In `src/config/load.ts` (lines 577-584), change the warning to
  `registered group "<id>" has no profile route; its messages are dropped`.
- Update the `default_profile` comment in `config.example.yaml`.
- Tests:
  - `router-routes` unit test;
  - a serve integration test: a registered, unrouted group with `default_profile` set is
    dropped.

**1.6 No per-profile state outlives its profile name (D6).**

The buffer, media and policy tables are keyed by profile name. A hand rename orphans the rows
until they expire, and a hand-recreated name inherits another agent's queued messages and media.

- In `startServe`, after opening the store and before `listen()`, add
  `reconcileProfileState(store, configuredNames, log)`:
  - for every profile name present in buffer, media or policies but not in the config, call
    `store.buffer.purgeProfile`, `store.media.purgeProfile` (it also deletes the files) and
    `store.policy.delete`;
  - log a warning per name with the counts.
- `BufferStore.profiles()` already exists, unused. Add the equivalent distinct-profile query to
  `MediaStore` and `PolicyStore`.
- MCP `delete_profile` already purges through `removeProfile`, so leave it alone.
- Test: seed rows for a ghost profile and a real one, start serve, and check that the ghost's rows
  and media files are gone and the real ones remain.

**1.7 MCP covers the whole operator workflow (D7).**

Add two tools to `src/mcp/tools.ts`, following the existing tool patterns (`mutate`,
`warningReply`, zod schemas, annotations).

`update_profile`:

- Input:
  `{ name: string; display_name?: string | null; wake_url?: url | null; routes?: Route[] }`,
  where `Route` is the existing `routeSchema`.
- Leaving a field out keeps it. `null` clears `display_name` or `wake_url`. `routes`, when given,
  replaces the whole list, and `[]` removes every route.
- At least one field besides `name` is required.
- Unknown profile → error `unknown profile: <name>`.
- Persist routes with the existing `persistedRoutes`. `ConfigStore.mutate` validates the whole
  document, so a route that collides with another profile's is rejected with the loader's
  message.
- Annotation: `destructiveConfigWrite`, since replacing routes can remove access.
- Returns `{ name, displayName, wakeUrl, routes }` plus the config warnings.

`rotate_profile_secret`:

- Input: `{ name: string }`.
- In the mutator, inspect the raw YAML node. The document isn't interpolated, so `${…}` is still
  literal there.
  - If the profile has a `secret_file` key → error
    `profile "<name>" reads its secret from secret_file; rotate it there`.
  - If the `secret` string contains `${` → error
    `profile "<name>" reads its secret from an environment variable; rotate it there`.
  - Otherwise write a new secret.
- Extract the generator `create_profile` uses into a shared `generateSecret(config)`. It
  generates `randomBytes(32).toString("base64url")`, avoiding every profile secret and the
  management secret.
- After the commit, the relay closes that profile's live session with `4401 "unauthorized"` via a
  new `revokeSession(profile)`, so the old instance stops until it restarts with the new secret.
  It reuses `closeDetached` and does not touch the buffer or holds.
- Returns the same shape as `create_profile`: `name`, `gatewayId`, `secret`, `relayUrl`, `env[]`.
  The text says the credentials are shown once.
- Annotation: `destructiveConfigWrite`.

Don't add tools to rename a profile or change its `gateway_id`; delete and create covers those.

Tests:

- `update_profile`: each field set, cleared and left alone; `routes: []`; a route collision is
  rejected; an unknown profile.
- `rotate_profile_secret`: an inline secret is rotated and the config reloaded; a `secret_file`
  and a `${ENV}` profile are refused with the file unchanged; a connected profile is closed 4401;
  the old token gets 4401 on reconnect and the new token connects.

**1.8 Docker layout matches the docs and allows MCP writes (D9).**

- `docker-compose.yml`:
  - replace the `whatrouter-data` named volume and the `./config.yaml:/data/config.yaml:ro`
    mount (line 37) with one `./data:/data` bind mount;
  - drop the top-level `volumes:` block;
  - rewrite the header comments for this flow: `mkdir data && cp config.example.yaml
data/config.yaml`, edit, `docker compose run --rm whatrouter check-config`,
    `docker compose run --rm -it whatrouter pair`, `docker compose up -d`;
  - note that `./data` must be writable by uid 1000 (the image's `node` user); if it isn't,
    `sudo chown 1000:1000 data`.
- `Dockerfile` header comments (lines 1-7): use `-v "$PWD/data:/data"`.
- Leave the CI `docker` job's read-only `check-config` mount alone; validation needs no writes.

### Phase 2: structure (no behaviour change)

Behaviour must not change. Existing tests may be rewritten to the new module seams, but they must
cover the same behaviour.

**2.1 One config source; live versus boot settings (D10).**

Today there are four ways to pass config:

- `ServeOptions.config` / `configStore` / `configPath`;
- `RelayServerOptions.config` / `getConfig` / `configStore`;
- `RouterOptions.config` / `getConfig`.

Reads are mixed as a result. For example, the `/relay/media` upload uses the live
`media.max_bytes` (`server.ts:578`) while the store enforces the boot value, and the wake cooldown
and purge ages are read live. A hand edit can therefore half-apply after the next MCP mutation.

- Every module takes `getConfig: () => Config`. Only the MCP tools also receive the `ConfigStore`,
  for writes. Tests pass `() => config`.
- Read **live** (call `getConfig()` each time): `profiles`, `groups`, `default_profile`.
- Read **once at boot** (capture in the composition root): everything else. That is `listen`,
  `public_url`, `data_dir`, `log_level`, `whatsapp.*` (the descriptor is built once),
  `buffer.*`, `media.*`, `management`, `allow_unrouted_outbound`.
- Remove the duplicate `ConfigStore.current` getter and keep `get()`.

**2.2 Split `src/relay/server.ts` and invert the management dependency (D11).**

Today `relay/server.ts` imports `management/` and `mcp/` and builds both endpoints. Target
modules and interfaces follow. These are a sketch: adjust names if the code reads better, but keep
the boundaries and the dependency rule.

```ts
// src/http/server.ts: node:http plus shared helpers. Knows no routes.
export type RequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
export interface HttpRoute {
  method?: string; // undefined = any method
  path: string;
  prefix?: boolean; // true: match path + "/..."
  handle: RequestHandler;
}
export interface HttpServer {
  listen(): Promise<{ host: string; port: number }>;
  /** closeIdleConnections, then closeAllConnections after the 2 s grace. */
  close(): Promise<void>;
}
export function createHttpServer(opts: {
  listen: { host: string; port: number };
  routes: HttpRoute[]; // first match wins; no match = 404 {"error":"not found"}
  upgrades: Record<string, UpgradeHandler>; // unknown path = 400 + destroy (as today)
  log: Logger;
}): HttpServer;
// Deduplicated helpers (today in relay/server.ts, mcp/endpoint.ts, management/endpoint.ts):
export function readBody(
  req: IncomingMessage,
  limit: number
): Promise<{ ok: true; body: Buffer } | { ok: false; reason: "too_large" }>;
export function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  headers?: Record<string, string>
): void;
export function rawToString(data: RawData): string;
```

```ts
// src/relay/gate.ts: relay authentication and the per-IP failure throttle.
export type AuthFailureReason =
  "missing_token" | "malformed" | "unknown_id" | "bad_signature" | "expired" | "throttled";
export type AuthOutcome =
  { ok: true; profile: ProfileConfig } | { ok: false; reason: AuthFailureReason };
export interface RelayGate {
  /** Records failures in the throttle. */
  authenticate(req: IncomingMessage): AuthOutcome;
  /** throttled -> 1013 "try again later"; expired -> 4401 "expired"; else 4401 "unauthorized". */
  wsClose(reason: AuthFailureReason): { code: number; reason: string };
  /** throttled -> 429; expired -> 401 "expired"; else 401 "unauthorized". */
  httpError(reason: AuthFailureReason): { status: number; error: string };
  prune(nowMs: number): void;
}
export function createRelayGate(opts: { getConfig: () => Config; now?: () => number }): RelayGate;
```

```ts
// src/relay/hub.ts: live relay sessions (one Session per profile) and delivery.
export type DeliveryOutcome = "live" | "buffered" | "unknown_profile";
export interface RelayHub {
  /** Called by the /relay upgrade handler after the gate accepted the profile and it isn't held. Rejects duplicates with 1008. */
  attach(ws: WebSocket, profile: ProfileConfig, ip: string): void;
  /** Live when possible, else buffered; buffering while disconnected may wake the profile. Never throws. */
  deliver(profileName: string, event: RelayEvent): DeliveryOutcome;
  isConnected(profileName: string): boolean;
  /** Detaches now (later inbound buffers) and closes the socket with a 5 s grace. Returns whether a session existed. */
  detach(profileName: string, code: number, reason: string): boolean;
  /** Wake poke: configured, not connected, not held, outside the cooldown. */
  maybeWake(profileName: string): void;
  /** 1001 "going away" to every session; terminates detached sockets. */
  close(): Promise<void>;
}
export function createRelayHub(opts: {
  getConfig: () => Config;
  store: Store;
  log: Logger;
  descriptor: CapabilityDescriptor;
  execute: (profile: ProfileConfig, action: OutboundAction) => Promise<OutboundResult>;
  isHeld: (profileName: string) => boolean;
  onDelivered?: (d: {
    profile: ProfileConfig;
    messageId: string;
    delivery: "live" | "buffered";
  }) => void;
  wakeCooldownSeconds: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): RelayHub;
```

```ts
// src/relay/http.ts: the relay's HTTP routes.
export function relayRoutes(opts: {
  gate: RelayGate;
  store: Store;
  log: Logger;
  maxMediaBytes: number;
  /** Built in serve.ts from hub, holds, store, the WhatsApp state and the version. */
  health: () => Record<string, unknown>;
  now?: () => number;
}): HttpRoute[]; // GET /healthz, POST /relay/policy, POST /relay/media, GET /relay/media/:id
```

```ts
// src/management/holds.ts: reconnect holds placed by close_profile.
export const HOLD_MS = 20_000;
export interface Holds {
  isHeld(profileName: string): boolean;
  /** For /healthz; null when not held. */
  blockedUntilMs(profileName: string): number | null;
  closeProfile(profileName: string): CloseProfileResult | FailureResult;
  releaseProfile(profileName: string): ReleaseProfileResult | FailureResult;
  /** Profile deleted: cancel any hold silently. */
  forget(profileName: string): void;
  /** Shutdown: cancel every timer. */
  close(): void;
}
export function createHolds(opts: {
  getConfig: () => Config;
  hub: Pick<RelayHub, "detach" | "isConnected" | "maybeWake">;
  bufferedCount: (profileName: string) => number;
  log: Logger;
  nowMs?: () => number;
  scheduleHoldExpiry?: (fn: () => void, delayMs: number) => () => void;
}): Holds;
```

- **`src/debug-inbound.ts`** takes `inboundFromDebugBody` and the `POST /debug/inbound` route out
  of `serve.ts`. Mount it only in fake mode.
- **`src/serve.ts`** is the only module that knows everything. It wires:
  - gate → `/relay` upgrade → `holds.isHeld` → `hub.attach`;
  - `hub.onDelivered` → `management.publish`;
  - the `/management` upgrade, using `secretMatches` and `ManagementEndpoint`; this helper may
    live in `management/`;
  - `/mcp` → `createMcpEndpoint({ …, closeProfile: holds.closeProfile, releaseProfile:
holds.releaseProfile, removeProfile, revokeSession, health })`;
  - `removeProfile` = `holds.forget`, `hub.detach(name, 1001, "profile deleted")`, then purge
    store state;
  - `revokeSession` = `hub.detach(name, 4401, "unauthorized")`;
  - the hourly maintenance timer: `gate.prune` and the store purges, using boot ages;
  - the startup reconciliation from 1.6, and the health snapshot.
- **Circular dependency:** the hub needs `isHeld` and holds needs the hub. Create the hub with
  `isHeld: (p) => holds.isHeld(p)` and assign `holds` right after.
- **Done when:**
  - `grep -rn "management/\|mcp/" src/relay` finds nothing;
  - `relay/server.ts` is gone;
  - all tests pass;
  - conformance passes.

**2.3 Remove dead code, duplicates and stale comments.**

Dead (no production caller at the base commit):

- **The durable `flips` table:** `setBufferedOnly`, `isBufferedOnly`, and the flip half of
  `clearFlipIfEmpty` (`relay/session.ts` `#onGoingIdle` and `#pump`; `store/buffer.ts`).
  - The table is written but never read: every new `Session` already starts with
    `liveOk = false`, which buffers until drained.
  - In `#pump`, replace the flip call with `buffer.count(profile) === 0`.
  - Add migration 2 in `store/db.ts`: `DROP TABLE IF EXISTS flips`.
  - The conformance `going_idle` and replay checks must stay green.
- **Media:** `MediaStore.delete`, `MediaPutResult.url`, `MediaStoreOptions.urlFor`,
  `OpenStoreOptions.mediaUrlFor`.
- **Other unused exports:** `loadConfig` (`config/load.ts`), `resetMediaUrlWarning`
  (`relay/media-url.ts`), `BaileysClient.onStateChange`, `BaileysClient.authDir()`.
- **Test-only accessors:** `RouteTable.rememberedSize`, and the `RelayServer` accessors
  `bufferedCount` and `address`. Don't carry them into the new modules; assert through behaviour
  or `/healthz`. `isConnected` survives on the hub because holds use it.
- **`makeToken` (`relay/auth.ts`):** production never mints tokens, and its comment wrongly says
  `whatrouter env` uses it. Move it to `test/helpers/`.
- **`InboundMessage.timestamp` and `mentionedIds`:** they never reach the wire or a decision.
- **`RelayPolicy.platform`, `freeResponseScopes`, `allowOtherBots` (`store/policy.ts`):** stored,
  never read. Keep only `requireAddress`.
- **`formattedIdentity` (`config/store.ts:43-46`):** a pass-through to `formatUserIdentity`.

Duplicates:

- `resolveVersion` in `whatsapp/baileys-client.ts` and `whatsapp/pair.ts` becomes one export.
- The exit codes copied into `serve.ts:37` (commented "to avoid an import cycle") move to
  `src/exit-codes.ts`, imported by both `cli.ts` and `serve.ts`.
- The 30 s ping / 60 s pong heartbeat loop is copied in the relay sessions and in
  `management/endpoint.ts`; share one helper.

Stale comments and constants:

- `relay/descriptor.ts:33`: "Off by default". The default is on (`afe6e4e`).
- `relay/frames.ts:3-4`: mentions "WP2".
- `relay/server.ts:1029`: the "WP4" `mediaUrl` re-export goes; import from `relay/media-url.ts`.
- `config/schema.ts:75,138`: the management block gates `/mcp` as well as `/management`.
- `mcp/tools.ts:185`: MCP server `version: "1.0.0"`; use the package version.

### Phase 3: docs (the code is the source of truth) (D12)

**3.1 Delete `docs/DESIGN.md`.** Where its content goes:

| Content                                                                 | Goes to                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Work packages, validation protocol, agent orchestration notes           | Deleted; git history keeps them                                                                                                                                                                                                        |
| Wire protocol, descriptor, event shape, op table                        | Already in `relay/frames.ts`, `relay/descriptor.ts`, `router/event.ts`, `router/router.ts`. The README links the upstream contract: <https://hermes-agent.nousresearch.com/docs/developer-guide/relay-connector-contract>              |
| Token test vectors                                                      | Already in `test/unit/relay-auth.test.ts`                                                                                                                                                                                              |
| Management WebSocket contract (guarantees, close codes, hold semantics) | The header comment of `src/management/frames.ts`. Add what only the README has today (README lines 421-463): the close codes, the 64 KiB frame and 1 MiB message limits, the 1 MiB unread-output rule, and that events are best effort |
| Decisions and risks                                                     | README "Design intent and trade-offs": principles plus K1-K21 (§2 and §3.1 here)                                                                                                                                                       |

These comments cite DESIGN.md or the old "WP" work packages. Make them self-contained, or point
them at the upstream contract:

- `src/relay/session.ts:7`
- `src/relay/descriptor.ts:3`
- `src/router/relevance.ts:6`
- `src/router/event.ts:3`
- `src/store/buffer.ts:2`
- `test/helpers/relay.ts:1` ("WP2")
- `test/helpers/router.ts:1` ("WP4")

`src/relay/frames.ts:4` and `src/relay/server.ts:1029` are already covered in 2.3.

**3.2 Rewrite the README** to roughly 250 lines (from 576), in this order:

1. **What and why:** keep the current three-paragraph intro and the ban-risk disclaimer.
2. **Architecture:** the ASCII sketch updated for the Phase 2 modules, a three-sentence protocol
   summary (buffering, acks, wake), and the trust model updated for D1 and full-control
   management.
3. **Design intent and trade-offs:** the seven principles, then K1-K21, one or two lines each.
4. **Quick start (Docker):** it must work verbatim with the `./data` layout (D9). Include
   generating and setting `management.secret`, since management is core.
5. **Quick start (Node):** keep the current sequence.
6. **Hermes side:** the four env lines (keep the short table) and `hermes gateway restart`.
7. **Configuration**, one paragraph covering:
   - `config.example.yaml` is the commented reference;
   - which settings are live and which are read at boot (D10);
   - hand edits only while stopped;
   - `${ENV}` and `secret_file`.
8. **Management:** one paragraph each.
   - `/mcp`: the tools describe themselves via `tools/list`.
   - `/management`: the contract is in `src/management/frames.ts`.
   - Note that the listener should be bound privately (K1, K2).
9. **Operations:** health, logs, stop, backup, upgrade, secret rotation (now
   `rotate_profile_secret`, or stop, edit, start for `secret_file` / `${ENV}`), config edits. One
   or two lines each.
10. **Troubleshooting:** keep the table.
    - Add a row for `1013 try again later` (throttling).
    - Update "The bot ignores a group": a route is now required, and `default_profile` no longer
      applies to groups.
    - Drop rows that can no longer happen.
11. **Development:** scripts, conformance, and the repo layout updated for Phase 2. No DESIGN
    link.

Removed:

- the config reference tables (README:193-281);
- the MCP tool table (README:476-500);
- the management framing and close-code detail (README:398-453), now in `frames.ts`;
- every stale statement, for example README:298-300, which says edit streaming is off by default.

**3.3 Make `config.example.yaml` the reference.**

- Every key appears, commented out if optional, with its default and a one-line meaning. This is
  the content of the deleted README tables, compressed.
- Mark the keys MCP manages live.
- Say plainly that the top-level `listen` is the bind address while `groups.*.listen` is the sender
  allowlist. Don't rename either key; that would break existing configs.
- The CI `docker` job validates this file, so it must stay valid and warning-free.

**3.4 MCP tool descriptions stand alone.** With the README table gone, check that each tool's
description in `src/mcp/tools.ts` carries its own semantics:

- `register_group`: the sole-admin default rule;
- `join_group_by_invite` and `create_group`: they don't register or route the group;
- `delete_profile`: D4;
- `update_profile` and `rotate_profile_secret`: D7, including the refusal case.

**3.5 Deliver.** In the Phase 3 PR description, list K1-K21 with their rationales for the owner
to confirm.

## 5. Definition of done

- `npm run format:check && npm run lint && npm run typecheck && npm test && npm run build` pass.
- CI, including the conformance job from 0.2, is green on the branch.
- This finds nothing (the lockfile is excluded because its hashes match by accident):

  ```bash
  grep -rn "DESIGN.md\|WP[0-9]" --exclude-dir={node_modules,.git,dist} --exclude=package-lock.json .
  ```

- `relay/` imports neither `management/` nor `mcp/`.
- This file is deleted, in the last PR.

## 6. Owner's live checklist (run by the owner before the merge to `dev`)

Follow the new README Docker quick start verbatim on a clean host, then:

1. Pair the bot number. A DM from a routed number reaches the agent and the reply arrives.
2. With MCP:
   1. `register_group` a test group;
   2. `update_profile` to add a group route;
   3. a mention is delivered.

   Then remove the route: messages from the group are dropped even with `default_profile` set.

3. `rotate_profile_secret` on a profile with an inline secret: the old Hermes instance is closed
   4401 and stops; the new env lines work. A `secret_file` profile is refused.
4. Add the bot to an unregistered group and send a large video. The logs show
   `rogue unregistered group dropped` and no media download.
5. `delete_profile` on the default profile: `default_profile` is now `null` in
   `data/config.yaml`.
6. Ask the agent to send an image from a public URL (it works), then from
   `http://192.168.x.x/…` (refused).

## 7. Deliberately out of scope

- Built-in TLS, scoped or read-only management tokens, and throttling of management auth
  (K2, K3).
- Persisting holds or reply memory (K5, K6).
- A per-profile `allow_unrouted_outbound` (K10).
- A LAN allowlist for `send_media` (D1).
- Renaming profiles or changing `gateway_id` through MCP.
- Renaming the `listen` key, `X-Forwarded-For` support (there's no proxy), encryption at rest,
  group discovery, and stricter ESLint rule sets.
