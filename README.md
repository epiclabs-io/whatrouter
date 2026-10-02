<p align="center">
  <img src="docs/assets/logo.jpg" alt="WhatRouter logo" width="220">
</p>

# WhatRouter

WhatRouter is a [Hermes Agent](https://github.com/NousResearch/hermes-agent) **Relay connector for
WhatsApp**. It owns one WhatsApp account — a dedicated bot number, linked once with a QR code or a
pairing code — and multiplexes it to any number of Hermes instances, using a live YAML file to
decide which chat belongs to which instance. Each instance is a _profile_ with its own
`gateway_id` and secret; routes bind DMs (by phone number) and groups (by JID) to exactly one
profile. Messages for an instance that is offline are buffered durably and replayed, in order and
exactly once, when it comes back.

**Why not `hermes whatsapp`?** Hermes ships a native Baileys bridge, but it is one account to one
instance: the agent process holds the WhatsApp credentials, and a second instance needs a second
phone number. WhatRouter inverts that. It is the sole holder of the WhatsApp session, each Hermes
instance authenticates to it with its own secret over an outbound WebSocket, and a per-chat route
table decides who sees what — so your work agent and your home agent can share one number without
sharing credentials or seeing each other's chats, and neither of them loses a message while it is
being restarted or upgraded.

**Not affiliated with Nous Research or WhatsApp.** This is a community project that implements the
published Hermes relay connector contract. WhatsApp access goes through
[Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial reverse-engineered client:
WhatsApp does not support it and may restrict or ban accounts that use it. Use a dedicated number
you can afford to lose, never send unsolicited outbound messages, and keep the traffic
conversational.

## Architecture

```
            WhatsApp (Baileys multi-device session; credentials live ONLY here)
                              |  one socket, one account
                              v
 +------------------------- WhatRouter -----------------------------+
 | whatsapp/   Baileys client: connect/reconnect, pair, normalize    |
 |             inbound -> InboundMessage, execute outbound ops       |
 | router/     config routes -> profile; relevance gate (mention/    |
 |             reply); tenant check on outbound                      |
 | relay/      WS server /relay (HMAC bearer), NDJSON frames,        |
 |             per-profile session actor, sqlite buffer + replay,    |
 |             wake poke, /relay/policy, /relay/media, /healthz      |
 | management/ WS /management + Streamable HTTP MCP /mcp, one secret |
 | store/      node:sqlite: buffer, idle flips, policies, media      |
 +-------------------------------------------------------------------+
                              ^  outbound-only dials (wss://.../relay)
          hermes gateway "work"        hermes gateway "home"   ...
          GATEWAY_RELAY_URL / _ID / _SECRET / _PLATFORMS=whatsapp
```

Trust model:

- WhatRouter is the only process holding WhatsApp credentials. They never leave
  `<data_dir>/wa-auth`.
- Each Hermes instance authenticates per profile with a long-lived shared secret; a compromised
  instance can impersonate only itself.
- A profile may only act on chats routed to it. Outbound to anything else is refused
  (`chat not routed to this profile`) unless `allow_unrouted_outbound: true`.
- Nothing dials in to Hermes: gateways always dial out, so instances can sit behind NAT with no
  inbound ports and no certificates of their own.
- The optional management credential controls every profile and WhatsApp group operation. It is
  separate from all profile credentials and is shared only by `/management` and `/mcp`.

**The protocol in one paragraph.** Each Hermes instance opens one outbound WebSocket to
`GET /relay` with an `Authorization: Bearer` token derived by HMAC-SHA256 from its profile secret
(`base64url("{gatewayId}:{exp}:{sig}")`, minted per connection with a 300 s TTL). The socket then
carries newline-delimited JSON frames: the gateway sends `hello`, WhatRouter answers with a
capability descriptor (platform, message limits, markdown dialect, the exact list of supported
ops); inbound WhatsApp messages travel as `inbound` frames and outbound agent actions as
`outbound` frames answered by `outbound_result`. Delivery is ack-gated: anything that cannot go
out live is appended to a per-profile sqlite buffer and replayed one at a time with a `bufferId`
the gateway must acknowledge, so a restart loses nothing and duplicates nothing. If an instance is
offline and a `wake_url` is configured, WhatRouter pokes it once per cooldown window.

Details: [docs/DESIGN.md](docs/DESIGN.md) — and the upstream contract this implements:
<https://hermes-agent.nousresearch.com/docs/developer-guide/relay-connector-contract>.

## Quick start (Docker)

Compose builds the image from this checkout, so start by cloning the repo onto the host that will
run WhatRouter (it needs a stable, reachable address if your Hermes instances live elsewhere).

**1. Write the config into the writable data volume.** The live Docker path is
`/data/config.yaml`; do not mount that file separately read-only because MCP management tools
update it.

```bash
git clone <repo-url> whatrouter && cd whatrouter
mkdir -p data
cp config.example.yaml data/config.yaml
openssl rand -hex 32          # one per profile, paste into data/config.yaml
```

Edit `data/config.yaml`:

- **Keep `data_dir: /data`** (the volume). A relative path such as `./data` resolves under
  `/app` inside the container, which is not writable, and pairing fails with
  `EACCES: permission denied, mkdir 'data'`.
- Set `public_url` to the address your Hermes instances will dial
  (`https://whatrouter.example.com`, or `http://<host-ip>:8466` on a LAN).
- Give every Hermes instance a profile with a unique `gateway_id` and secret, and list the DMs and
  groups it should receive.

**2. Validate it.**

```bash
docker compose run --rm whatrouter check-config
```

Prints a summary and `config OK`, or one line per problem and exit code 2.

**3. Link the WhatsApp account (once).**

```bash
docker compose run --rm -it whatrouter pair
```

Scan the QR with WhatsApp on the bot phone: Settings -> Linked devices -> Link a device. If the
terminal cannot render a QR code, use the pairing-code flow instead and type the printed eight
characters into "Link with phone number instead":

```bash
docker compose run --rm -it whatrouter pair --code +34600000000
```

It prints `Paired as <number>. Credentials saved to /data/wa-auth.` and exits 0. `serve` never
prints a QR code; pairing is always this explicit one-off.

**4. Start it.**

```bash
docker compose up -d
curl -s localhost:8466/healthz
docker compose logs -f
```

**5. Point each Hermes instance at it.** For the profile named `work`:

```bash
docker compose run --rm whatrouter env work >> ~/.hermes/.env
hermes gateway restart
```

That appends exactly four lines:

| Line                                                   | Meaning                                                                                                    |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `GATEWAY_RELAY_URL=wss://whatrouter.example.com/relay` | Where the gateway dials. Derived from `public_url`; falls back to `ws://localhost:8466/relay`.             |
| `GATEWAY_RELAY_ID=gw-work`                             | The profile's `gateway_id`. Identifies which profile is connecting.                                        |
| `GATEWAY_RELAY_SECRET=<32+ chars>`                     | The shared secret that signs the bearer token. Setting it also stops Hermes from trying to self-provision. |
| `GATEWAY_RELAY_PLATFORMS=whatsapp`                     | The platforms this gateway fronts through the relay.                                                       |

If Hermes runs on another host, run the `env` command on the WhatRouter host and copy the four
lines across — that is the only place the secret exists.

**6. Test it.** Send a WhatsApp DM to the bot number from one of the phone numbers you routed to
`work`. The message shows up in that instance's logs and the agent replies in the chat. In a
routed group, mention the bot (or reply to it) unless you set `require_mention: false`.

## Quick start (Node, no Docker)

Node 24 or newer, because WhatRouter uses the built-in `node:sqlite`. `ffmpeg` on `PATH` is
optional: without it, voice replies are sent as ordinary audio attachments instead of voice notes.

```bash
npm ci
npm run build

cp config.example.yaml config.yaml   # edit it; set data_dir to a writable path such as ./data
node dist/whatrouter.js check-config config.yaml
node dist/whatrouter.js --config config.yaml pair
node dist/whatrouter.js --config config.yaml serve
```

`npm link` puts a `whatrouter` binary on your `PATH`, after which the same commands read
`$WHATROUTER_CONFIG` (or `./config.yaml`) by default. It writes to the global npm prefix, so it
needs either `sudo` or a user-owned prefix (`npm config set prefix ~/.local`):

```bash
npm link                  # or: sudo npm link
whatrouter check-config
whatrouter env work
```

The config path is resolved in this order: `--config <path>`, then `$WHATROUTER_CONFIG`, then
`./config.yaml`. In the Docker image `WHATROUTER_CONFIG=/data/config.yaml`; keep that live file in
the writable `/data` volume. Exit codes are 0 for
success, 1 for a runtime failure (pairing timed out, WhatsApp logged out), and 2 for a bad config
or bad usage.

## Configuration reference

Top level:

| Key                            | Type                 | Default             | Meaning                                                                                                                                                                                                                               |
| ------------------------------ | -------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listen`                       | `host:port`          | `0.0.0.0:8466`      | Address the HTTP/WebSocket server binds.                                                                                                                                                                                              |
| `public_url`                   | http(s) URL or null  | null                | Base URL Hermes dials and media URLs are built from. Without it everything falls back to `http://localhost:<port>` — fine on one host, broken everywhere else.                                                                        |
| `data_dir`                     | path                 | `./data`            | Holds `wa-auth/`, `whatrouter.sqlite`, `media/`. The example sets `/data` (the Docker volume); use a relative path when running with Node.                                                                                            |
| `log_level`                    | `trace`…`fatal`      | `info`              | Overridden by `$WHATROUTER_LOG_LEVEL`.                                                                                                                                                                                                |
| `whatsapp.edit_streaming`      | bool                 | `true`              | Let the agent stream by editing its message; also flips `supports_edit` in the descriptor. On by default; WhatsApp labels edited messages, and rapid edits can look bot-like, so set it to `false` if that matters for your use case. |
| `whatsapp.send_read_receipts`  | bool                 | `false`             | Mark routed incoming messages as read.                                                                                                                                                                                                |
| `whatsapp.chunk_delay_ms`      | int >= 0             | `300`               | Pause between chunks of a long reply.                                                                                                                                                                                                 |
| `whatsapp.send_timeout_ms`     | int > 0              | `60000`             | Per-send timeout before an op fails.                                                                                                                                                                                                  |
| `buffer.max_age_seconds`       | int > 0              | `1209600` (14 d)    | Unacked buffered events older than this are purged hourly.                                                                                                                                                                            |
| `buffer.wake_cooldown_seconds` | int >= 0             | `60`                | Minimum gap between `wake_url` pokes for one profile.                                                                                                                                                                                 |
| `media.max_bytes`              | int > 0              | `26214400` (25 MiB) | Cap on stored and uploaded media.                                                                                                                                                                                                     |
| `media.retention_seconds`      | int > 0              | `604800` (7 d)      | How long re-hosted media stays fetchable.                                                                                                                                                                                             |
| `default_profile`              | profile name or null | null                | Profile that receives chats no route matches. Null means drop them (fail-closed).                                                                                                                                                     |
| `allow_unrouted_outbound`      | bool                 | `false`             | Let a profile send to chats not routed to it. Leave it false unless you know why you need it.                                                                                                                                         |
| `management.secret`            | string >= 32 chars   | —                   | Enables both management protocols, WebSocket `/management` and Streamable HTTP MCP `/mcp` (see [Management](#management)). Must differ from every profile secret. Omit `management` to disable both.                                  |
| `management.secret_file`       | path                 | —                   | Read the management secret from a file instead (contents trimmed). Exactly one of `secret` / `secret_file`.                                                                                                                           |
| `groups`                       | map                  | `{}`                | Registered-group allowlist and account-wide sender listen policy. Keys are normalized `<digits>(-<digits>)?@g.us` JIDs.                                                                                                               |
| `profiles`                     | map                  | —                   | At least one. The key is the profile name used by `whatrouter env <name>`.                                                                                                                                                            |

Per profile (`profiles.<name>`):

| Key            | Type                | Default                       | Meaning                                                                                   |
| -------------- | ------------------- | ----------------------------- | ----------------------------------------------------------------------------------------- |
| `gateway_id`   | string              | required                      | Must match `GATEWAY_RELAY_ID`. Unique across profiles.                                    |
| `secret`       | string >= 32 chars  | required unless `secret_file` | Must match `GATEWAY_RELAY_SECRET`. Unique across profiles.                                |
| `secret_file`  | path                | —                             | Read the secret from a file instead (contents trimmed). Mutually exclusive with `secret`. |
| `display_name` | string or null      | null                          | Human label for logs.                                                                     |
| `wake_url`     | http(s) URL or null | null                          | Poked with a bare GET when a message arrives while the instance is offline.               |
| `routes`       | list                | `[]`                          | Chats this profile owns. A profile with no routes is a warning, not an error.             |

Per route — exactly one of `dm` or `group`:

| Key               | Applies to | Meaning                                                                                                                  |
| ----------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| `dm`              | DM         | A phone number or user JID. Accepted forms: `+34600000000`, `34600000000`, `34600000000@s.whatsapp.net`, `<digits>@lid`. |
| `group`           | group      | The group JID, `<digits>@g.us`. WhatsApp groups have no other stable id.                                                 |
| `require_mention` | group      | Only deliver messages that address the bot. Default true.                                                                |
| `allowed_senders` | group      | If present, only these senders' messages are delivered. Same forms as `dm`.                                              |

Per registered group (`groups.<group JID>`):

| Key             | Type                               | Meaning                                                                                      |
| --------------- | ---------------------------------- | -------------------------------------------------------------------------------------------- |
| `display_name`  | string or null                     | Operator-facing label; registration defaults it to the live WhatsApp subject.                |
| `admins_seen`   | nonnegative integer or null        | Admin count observed at registration; informational, not an authorization decision.          |
| `listen_source` | `default_admin` or `explicit`      | Whether registration selected the listen list or a caller explicitly supplied/replaced it.   |
| `listen`        | user identities or exactly `["*"]` | Account-wide sender gate. Empty drops everyone; `"*"` accepts everyone and must stand alone. |

Group registration and profile routing are independent. Every inbound group must first be present
in `groups` and pass its `listen` gate; unregistered (rogue) groups are logged and dropped. It must
then resolve to a profile through a group route or `default_profile`. A route does not register a
group, and registration does not route it. Route-level `allowed_senders`, when present, is an
additional narrowing after `groups.<jid>.listen`; it never broadens the registry policy.

When MCP registers a group without an explicit `listen`, it uses `["*"]` only if live metadata
shows exactly one admin and that admin is the bot. Every other case defaults to `[]`. In all places
that name users, WhatRouter accepts a bare phone number, `<digits>@s.whatsapp.net`, or
`<digits>@lid`. LIDs are supported but opaque and potentially non-portable, so config validation
warns wherever one appears. Mutable writes keep phone identities as human-readable quoted bare
numbers and keep LIDs explicit.

A group message is delivered when `require_mention` is off, **or** the text starts with `/`, **or**
the bot is @mentioned, **or** the message is a reply to the bot. The setting is resolved route
first, then the `requireAddress` policy the gateway pushed over `POST /relay/policy`, then the
default of `true`.

Secrets can stay out of the file: any string may contain `${ENV_VAR}`, which is substituted from
the environment at load time (an unset variable is a config error), and `secret_file:` reads the
value from a path — a Docker or Kubernetes secret mount, for example.

`data_dir` layout:

| Path                                   | Contents                                                                      |
| -------------------------------------- | ----------------------------------------------------------------------------- |
| `wa-auth/`                             | Baileys credentials and signal keys. **Full access to the WhatsApp account.** |
| `whatrouter.sqlite` (+ `-wal`, `-shm`) | Inbound buffer, idle flips, gateway policies, media index.                    |
| `media/`                               | Re-hosted inbound media, served from `/relay/media/<id>`.                     |

`check-config` reports every problem at once, not just the first: duplicate `gateway_id`, a secret
under 32 characters or shared by two profiles, `secret` and `secret_file` both set, a chat routed
to two profiles, malformed phone numbers or JIDs, an unknown `default_profile`, an unset `${ENV}`
reference, a bad `listen`/`public_url`/`wake_url`, a management secret that is too short or
equal to a profile secret, or an unknown key.

## The Hermes side

Each Hermes instance needs the four `GATEWAY_RELAY_*` lines in `~/.hermes/.env` (see the quick
start) and the `websockets` extra installed, which is what the relay transport dials with. Env
changes only take effect after `hermes gateway restart`.

From the agent's point of view the platform is `whatsapp`. Chat ids are WhatsApp JIDs:
`34600000000@s.whatsapp.net` (or `<digits>@lid`) for DMs and `<digits>@g.us` for groups, with the
group subject or the sender's push name as the chat name. Markdown in replies is converted to
WhatsApp's own formatting (`*bold*`, `_italic_`, `~strike~`, fenced code) and long replies are
split at 4096 characters, preferring newlines. Inbound photos, videos, voice notes, audio,
documents and stickers are downloaded, re-hosted at `<public_url>/relay/media/<id>` behind the
same HMAC auth, and handed to the agent as ordinary media URLs.

Advertised ops: `send`, `edit`, `delete`, `typing`, `react`, `send_media`, `get_chat_info`.
Anything else is answered with `unsupported op: <op>`. Not supported, by platform or by choice:
threads (`supports_threads: false`), draft streaming, polls, and — unless you set
`whatsapp.edit_streaming: true` — streaming by edit.

## Operations

**Health.** `GET /healthz` needs no auth and answers:

```json
{
  "status": "ok",
  "whatsapp": "connected",
  "profiles": {
    "work": { "connected": true, "buffered": 0 },
    "home": { "connected": false, "buffered": 3 }
  }
}
```

`whatsapp` is one of `connected`, `connecting`, `disconnected`, `unpaired`. Per profile,
`connected` means that Hermes instance currently holds a relay socket and `buffered` is how many
events are waiting for it. While a [management hold](#management) is in force the profile
also carries `blockedUntilMs` (epoch milliseconds); the field is absent otherwise. The
container's `HEALTHCHECK` polls this endpoint.

**Logs** are newline-delimited JSON on stdout (pretty-printed only on an interactive terminal).
`WHATROUTER_LOG_LEVEL=debug docker compose up` raises the level without touching the config.

**Stopping.** `serve` shuts down on SIGTERM: it closes the relay sockets with code 1001 (gateways
treat that as a normal restart and reconnect) and the management socket, if any, with 1001 too, stops the WhatsApp socket and closes sqlite, so
`docker compose stop` and `systemctl stop` are clean. `tini` is PID 1 in the image precisely so
the signal reaches node.

**Buffering.** An event that cannot be delivered live is written to sqlite and replayed on
reconnect, oldest first, one at a time, each waiting for the gateway's ack — so ordering holds and
nothing is redelivered. Events unacked for longer than `buffer.max_age_seconds` (14 days) are
purged hourly. The buffer survives restarts of both sides. If a profile has a `wake_url`, the
first event that lands while it is offline triggers one GET (no payload, best effort, at most once
per `buffer.wake_cooldown_seconds`), which is enough to start an instance that is suspended rather
than crashed.

**Media** is stored under `<data_dir>/media` and expires after `media.retention_seconds` (7 days).
Every URL is scoped to the owning profile and requires that profile's bearer token, so one
instance cannot read another's attachments. Media only works off-host when `public_url` is set.

**Backups.** Everything is in the `/data` volume; back it up whole. Copy `whatrouter.sqlite` with
the service stopped, or with `sqlite3 ... ".backup"` while it runs.
**Never commit, share or copy `wa-auth/` anywhere it does not belong** — it is full access to the
WhatsApp account, equivalent to a linked device, and it is not encrypted.

**Upgrading.** `git pull && docker compose build && docker compose up -d`. The sqlite schema
migrates forward on open, `wa-auth` is unaffected and buffered events survive, so instances
reconnect and drain on their own. Re-pairing is only needed if WhatsApp logged the session out.

**Rotating a profile secret.** Generate a new one (`openssl rand -hex 32`), put it in
`/data/config.yaml`, `docker compose restart whatrouter`, then update that one instance's
`~/.hermes/.env` (`whatrouter env <profile>` prints the new lines) and `hermes gateway restart`.
Between those two steps the instance sees close code 4401 and stops reconnecting until it is
restarted with the new secret; other profiles are unaffected, and its messages are buffered.

## Management

The optional management toolset has two interfaces with one `management.secret`:

- `/management` is a singleton WebSocket for push events plus `close_profile` and
  `release_profile`; it is intended for a lifecycle orchestrator.
- `/mcp` is Streamable HTTP MCP for agent-facing tools that inspect and change groups, profiles,
  relay holds, and health.

They are management protocols, not a REST API. The Hermes relay protocol on `/relay` is unchanged.

**Setup.** Add a `management:` block with `secret` (or `secret_file`) and restart. Without the
block, `/management` is an unknown WebSocket path and `/mcp` returns 404. Generate the secret with
`openssl rand -hex 32`; it must be at least 32 characters and differ from every profile secret.

**Auth.** `GET /management` with `Authorization: Bearer <management secret>` and a WebSocket
upgrade. The secret is compared in constant time and never logged. A missing or wrong secret
completes the handshake and is then closed `4401 unauthorized`. Failed attempts are not throttled
and do not count towards the relay's per-IP limit, so they can never lock out agents sharing that
address. Profile secrets and relay tokens never grant management access.

**Security boundary.** The management secret is a long-lived bearer credential with control over
every agent session, dynamic profile credentials, live config, and WhatsApp group membership and
settings. Plain HTTP or WebSocket exposes both the bearer and management data to observers and
active attackers. Use `https://` for `/mcp` and `wss://` for `/management` outside a trusted
host-local path. A TLS-terminating proxy protects only the client-to-proxy leg, so also trust or
protect the proxy-to-WhatRouter network, bind WhatRouter privately, and firewall the listener.
There are no CORS response headers. `/mcp` rejects a supplied cross-origin `Origin`, but non-browser
clients can omit `Origin`, so this is not an authentication or network-exposure boundary. Rotate
the secret by changing the config and restarting WhatRouter.
Exactly one management client may be connected; a second one is closed `1008 duplicate
management session`.

**Framing.** NDJSON over text messages: one JSON object per line, each terminated by `\n`. A
frame may be split across, or share, WebSocket messages. Every request carries a `requestId`
(non-empty, at most 128 characters) and gets exactly one `result` with the same `requestId`.

```text
-> {"type":"subscribe","requestId":"sub-1","events":["message_pending"]}
<- {"type":"result","requestId":"sub-1","result":{"success":true,"events":["message_pending"],
    "pending":[{"profile":"work","gatewayId":"gw-work","bufferedCount":3}]}}

<- {"type":"event","event":"message_pending",
    "data":{"profile":"work","gatewayId":"gw-work","messageId":"WA123","delivery":"live"}}

-> {"type":"close_profile","requestId":"close-1","profile":"work"}
<- {"type":"result","requestId":"close-1","result":{"success":true,"profile":"work",
    "wasConnected":true,"blockedUntilMs":1790870420123,"retryAfterMs":20000}}

-> {"type":"release_profile","requestId":"release-1","profile":"work"}
<- {"type":"result","requestId":"release-1","result":{"success":true,"profile":"work",
    "wasHeld":true}}
```

(Wrapped here for reading; on the wire each frame is a single line.)

- `subscribe` replaces the whole subscription; `"events":[]` unsubscribes, and repeating the same
  request is harmless. An unsupported event name fails the request and leaves the previous
  subscription in place. No event is sent before a successful subscribe result. `pending` lists
  every profile whose durable buffer is non-empty at that moment — this is how a client recovers
  from events it missed while disconnected.
- `message_pending` means WhatRouter accepted a new inbound WhatsApp message for the profile:
  `delivery` is `live` (sent to the connected agent) or `buffered` (stored for later). It does
  not mean the agent processed it. It is sent once per new message and never for buffer replays
  after a reconnect or for unrouted messages, and it carries no text, sender, chat or media.
- `close_profile` closes that profile's relay session and refuses its reconnects for 20 seconds.
  The result is sent only after live delivery is already off, so the orchestrator can suspend the
  agent as soon as it arrives. A known but already-disconnected profile also succeeds
  (`wasConnected:false`) and still starts the hold; every successful call restarts the full 20 s.
  An unknown profile answers `{"success":false,"error":"unknown profile"}`.
- `release_profile` cancels an active reconnect hold early. A known profile always succeeds:
  `wasHeld:true` means this request cancelled an active hold; `false` makes retries idempotent.
  It permits future reconnect attempts but does not dial Hermes itself, alter the detached old
  socket, clear buffered messages, or invoke `wake_url`. An attempt already refused with `1013`
  remains refused; Hermes enters on its next retry. Unknown profiles fail as above.
- Any other problem with a request that has a valid `requestId` is answered with
  `{"success":false,"error":"…"}`.

**Guarantees.** Events are best effort and not durable: there is no ack, no replay log, and
publishing never delays or fails inbound delivery. Output is bounded at 1 MiB unread per client:
any frame that would take the queue past that limit is not sent, and the client is closed
`1013 management client too slow`. The buffer itself stays
durable, so nothing is lost for the agent.

**Close codes** on `/management`: `4401 unauthorized` (bad secret), `1008 duplicate management
session`, `1008 invalid management frame` (malformed JSON, a non-object, or a missing, empty or
oversized `requestId`), `1003 text frames only` (binary message), `1009` (a single frame over
64 KiB of UTF-8, or a single WebSocket message over 1 MiB),
`1013 management client too slow`, `1001 going away` (WhatRouter shutting down).

**What the agent sees.** Its relay socket is closed `1001 closed by management`; reconnects during
the hold are closed `1013 profile temporarily suspended`. Hermes treats both as retryable (it
latches only on `4401`), so it keeps re-dialing with backoff and reconnects by itself once the
hold ends, replaying everything buffered meanwhile. During the hold `wake_url` pokes are
suppressed; when the hold expires naturally, if the profile is still offline with buffered
messages, one normal wake poke is sent (subject to `buffer.wake_cooldown_seconds`). A manual
`release_profile` does not send this poke because the orchestrator owns the decision to abort or
resume the container.

**Caveats.** Holds live in memory only: restarting WhatRouter clears them, and the agent may
reconnect immediately. Outbound actions the agent had already started when its session was closed
cannot be cancelled — they may still reach WhatsApp, but their results are no longer reported to
the agent.

### MCP tools

`/mcp` uses standard stateful Streamable HTTP MCP (`GET`, `POST`, and `DELETE`) with
`Authorization: Bearer <management secret>`. Sessions expire after 15 minutes idle and the server
allows at most 32 at once; when full, a new session evicts the least recently used idle one
(clients that restart without `DELETE` cannot lock management out). These methods are MCP transport operations, not REST resources.

| Tool                         | Semantics                                                                                                                                                                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_groups`                | List the config registry only; it does not discover or list every WhatsApp group.                                                                                                                                                   |
| `get_group`                  | Return registry data and live WhatsApp metadata for a registered group.                                                                                                                                                             |
| `register_group`             | Add a known group JID to the registry; defaults `listen` using the sole-admin rule above (live lookup). With an explicit `listen`, no WhatsApp lookup is made, so it works offline.                                                 |
| `update_group`               | Change a registered group's config `display_name`.                                                                                                                                                                                  |
| `forget_group`               | Remove registry policy without leaving the WhatsApp group or changing profile routes.                                                                                                                                               |
| `get_listen_list`            | Read a registered group's account-wide sender gate.                                                                                                                                                                                 |
| `set_listen_list`            | Replace that gate and mark its source `explicit`; `"*"` must be the sole entry.                                                                                                                                                     |
| `list_group_members`         | Return live participants and admin roles for a registered group.                                                                                                                                                                    |
| `modify_group_members`       | Add, remove, promote, or demote listed users in a registered group.                                                                                                                                                                 |
| `list_group_join_requests`   | Return live pending join requests for a registered group.                                                                                                                                                                           |
| `review_group_join_requests` | Approve or reject listed pending requests.                                                                                                                                                                                          |
| `get_group_invite_code`      | Return the current invite code, or null.                                                                                                                                                                                            |
| `revoke_group_invite_code`   | Revoke the old invite code and return its replacement.                                                                                                                                                                              |
| `join_group_by_invite`       | Join using an invite code; does not register or route the joined group.                                                                                                                                                             |
| `create_group`               | Create a group with optional participants; does not register or route it.                                                                                                                                                           |
| `leave_group`                | Leave a registered group and optionally forget its registry entry after success. Errors report `left`/`forgotten`; if the leave happened, call `forget_group` rather than retrying.                                                 |
| `update_group_settings`      | Change subject, description, announcement/restriction, disappearing messages, member-add, or join-approval settings. Applied in order, stopping at the first failure; the result lists applied, failed, and not-attempted settings. |
| `list_profiles`              | List live configured profile data with secrets removed.                                                                                                                                                                             |
| `create_profile`             | Generate a profile and return new relay credentials and environment lines.                                                                                                                                                          |
| `delete_profile`             | Close and delete a profile; refuses the last profile and repairs `default_profile` if needed.                                                                                                                                       |
| `close_profile`              | Close its relay socket and start/reset the same 20-second reconnect hold as the WebSocket command.                                                                                                                                  |
| `release_profile`            | Cancel that hold without reconnecting or waking Hermes.                                                                                                                                                                             |
| `get_health`                 | Return router version, WhatsApp state, relay connections, holds, and buffer counts.                                                                                                                                                 |

WhatsApp exposes no group deletion operation here: use `leave_group`, optionally with `forget`,
or `forget_group` without leaving. There is also deliberately no WhatsApp group discovery or
list-all tool; management starts from a known group JID, an invite, or `create_group`.

Config-changing tools validate the complete candidate document, serialize writes per config path,
write and fsync a mode-0600 temporary file, atomically rename it, fsync the directory, then reload
the in-memory config. Group policy and profiles created or deleted through MCP therefore take
effect without a process restart. The YAML document is edited in place so unrelated keys and
comments are preserved.

**Orchestrator workflow.**

1. Connect to `/management` and `subscribe` to `message_pending`. Resume (start) every agent
   listed in `pending`.
2. When an agent has been idle long enough, send `close_profile` for it. Once the result arrives,
   suspend its container; new messages now buffer.
3. If `message_pending` arrives while suspension is still in progress, send `release_profile` and
   abort the suspension. If the container is already suspended, resume it and optionally release
   the hold rather than waiting until `blockedUntilMs`. Hermes drains the buffer after reconnecting.
4. After reconnecting the management socket, `subscribe` again and use `pending` to catch up.

| Symptom                                                  | Cause and fix                                                                                                                                                                                                                                                          |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway logs close code `4401 unauthorized`              | `GATEWAY_RELAY_ID` or `GATEWAY_RELAY_SECRET` matches no profile. Compare against `whatrouter env <profile>`; trailing whitespace in the `.env` value counts.                                                                                                           |
| Close code `4401` with reason `expired`                  | Only the token's expiry failed: the two machines' clocks differ by more than ~5 minutes. Fix NTP on both; the gateway then reconnects by itself.                                                                                                                       |
| Hermes says auth was revoked and stops reconnecting      | Hermes latches after a post-handshake 4401 on purpose, so a wrong secret cannot hammer the connector. Fix the secret, then `hermes gateway restart`; WhatRouter alone cannot unlatch it.                                                                               |
| Close code `1008 duplicate session`                      | Two Hermes instances share a `gateway_id`. The _new_ connection is refused, not the live one. Give each instance its own profile.                                                                                                                                      |
| Close code `1013 profile temporarily suspended`          | The management API closed this profile less than 20 seconds ago. Hermes keeps retrying and gets in once the hold expires; `/healthz` shows `blockedUntilMs` meanwhile.                                                                                                 |
| In Docker: `EACCES: permission denied, mkdir 'data'`     | `data_dir` is relative, so it resolves under `/app`, which the unprivileged `node` user cannot write. Set `data_dir: /data` — the volume.                                                                                                                              |
| `serve` exits 2 with a `whatrouter pair` hint            | The WhatsApp account is not linked in this `data_dir`. Run `docker compose run --rm -it whatrouter pair` once, then start again — and check both commands use the same volume.                                                                                         |
| Logs say the session was logged out; state is `unpaired` | The linked device was removed from the phone, or WhatsApp invalidated it. Delete `<data_dir>/wa-auth` and pair again.                                                                                                                                                  |
| Messages from one contact never arrive                   | Their chat id is a LID (`<digits>@lid`), not a phone JID — common for first contact and privacy-enabled accounts, and the LID digits are unrelated to the phone number. Find the `unrouted chat dropped` log line, copy the id it prints, and add it as a `dm:` route. |
| The bot ignores a group                                  | The group must be registered, its `listen` gate must accept the sender, and a profile route or `default_profile` must select an agent. Then check mention gating and route-level `allowed_senders`.                                                                    |
| Nothing arrives and nothing is buffered                  | The chat matches no route and `default_profile` is null, so it is dropped by design. Add a route or set `default_profile`.                                                                                                                                             |
| Hermes cannot fetch media (`localhost` URLs, timeouts)   | `public_url` is unset or wrong, so media URLs point at WhatRouter's own localhost. Set it to an address the Hermes host can reach, then restart.                                                                                                                       |
| Media upload rejected                                    | Larger than `media.max_bytes` (25 MiB by default), which is also close to WhatsApp's own limit.                                                                                                                                                                        |
| `check-config` prints `error: <path>: ...`               | One line per problem, each with its config path. Exit code 2 also covers unknown commands and bad flags.                                                                                                                                                               |

## Development

```bash
npm ci
npm run dev -- check-config config.example.yaml   # tsx, no build step
npm test                                          # vitest
npm run check                                     # typecheck + test + build
```

Conformance against the real Hermes relay transport — it starts WhatRouter with
`WHATROUTER_FAKE_WHATSAPP=1` (an in-memory WhatsApp, so no phone and no network) and drives
`gateway.relay.ws_transport` from a Hermes checkout through the handshake, live and buffered
inbound, every outbound op result shape, the `going_idle` flip, ack-gated replay across a
reconnect, and the 4401 cases:

```bash
HERMES_CHECKOUT=/path/to/hermes-agent scripts/conformance/run.sh
```

It needs [uv](https://docs.astral.sh/uv/) on `PATH`; it does not install Hermes and needs no LLM
key.

Repository layout:

| Path                   | Contents                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `src/config/`          | YAML schema (zod), `${ENV}` interpolation, validation.                               |
| `src/relay/`           | HTTP/WebSocket server, HMAC auth, NDJSON frames, session state machine, descriptor.  |
| `src/router/`          | Route table, relevance gating, tenant checks, event mapping.                         |
| `src/store/`           | `node:sqlite`: buffer, idle flips, policies, media index.                            |
| `src/whatsapp/`        | Baileys client, pairing, JID handling, normalization, markdown, chunking, fake port. |
| `src/util/`            | Logging.                                                                             |
| `test/`                | Vitest unit and integration tests, plus recorded Baileys fixtures.                   |
| `scripts/conformance/` | Probe that drives the real Hermes transport against a running WhatRouter.            |
| `docs/DESIGN.md`       | Authoritative architecture and wire-protocol spec.                                   |

MIT licensed. See [LICENSE](LICENSE).
