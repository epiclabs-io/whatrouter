<p align="center">
  <img src="docs/assets/logo.jpg" alt="WhatRouter logo" width="220">
</p>

# WhatRouter

WhatRouter is a [Hermes Agent](https://github.com/NousResearch/hermes-agent) **Relay connector for
WhatsApp**. It owns one WhatsApp account - a dedicated bot number, linked once with a QR code or a
pairing code - and multiplexes it to any number of Hermes instances, using a live YAML file to
decide which chat belongs to which instance. Each instance is a _profile_ with its own
`gateway_id` and secret; routes bind DMs (by phone number) and groups (by JID) to exactly one
profile. Messages for an instance that is offline are buffered durably and replayed, in order and
exactly once, when it comes back.

**Why not `hermes whatsapp`?** Hermes ships a native Baileys bridge, but it is one account to one
instance: the agent process holds the WhatsApp credentials, and a second instance needs a second
phone number. WhatRouter inverts that. It is the sole holder of the WhatsApp session, each Hermes
instance authenticates to it with its own secret over an outbound WebSocket, and a per-chat route
table decides who sees what - so your work agent and your home agent can share one number without
sharing credentials or seeing each other's chats, and neither of them loses a message while it is
being restarted or upgraded.

**Not affiliated with Nous Research or WhatsApp.** This is a community project that implements the
published Hermes relay connector contract. WhatsApp access goes through
[Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial reverse-engineered client:
WhatsApp does not support it and may restrict or ban accounts that use it. Use a dedicated number
you can afford to lose, never send unsolicited outbound messages, and keep the traffic
conversational.

## Architecture

```text
             WhatsApp (one Baileys session; credentials stay here)
                                  |
                     whatsapp/ port + adapter
                                  |
                      router/ routes and gates
                                  |
        +--------------------- serve.ts ---------------------+
        | composition root: boot snapshot and live config    |
        +----------+---------------+---------------+----------+
                   |               |               |
             relay/gate       relay/hub       relay/http
              auth/rate       sessions,       health, policy,
                limit         buffer, wake    authenticated media
                   \               |               /
                    +-------- http/server --------+
                              /    |    \
                         /relay   /mcp   /management
                            ^              |
             outbound WebSockets      management/holds
                  from Hermes
```

Hermes gateways dial `/relay`; WhatRouter never needs an inbound connection to an agent. Delivery
is ack-gated: anything that cannot go out live enters a durable per-profile sqlite buffer and is
replayed oldest first, one message at a time. If buffered work appears while a profile is offline,
its optional `wake_url` is poked subject to the reconnect hold and wake cooldown.

WhatRouter alone holds the WhatsApp credentials. Profile secrets and route checks isolate agents,
and media that an agent asks WhatRouter to fetch for `send_media` can never come from a private or
otherwise non-public address. The management secret can change every profile, session, route, and
WhatsApp group; bind the listener privately and protect the transport if it leaves a trusted host
or LAN.

The relay wire format follows the
[upstream connector contract](https://hermes-agent.nousresearch.com/docs/developer-guide/relay-connector-contract).

## Design intent and trade-offs

1. **One WhatsApp account, many agents, no shared credentials.** WhatRouter alone holds the
   WhatsApp session. Each agent has its own secret and sees only the chats routed to it.
2. **Follow the Hermes relay contract exactly.** The `/relay` wire format matches upstream and is
   checked against the real Hermes transport in `scripts/conformance`.
3. **Fail closed.** Unknown DMs are dropped unless `default_profile` is set, unregistered groups
   are dropped, outbound actions are tenant-checked, and a new group listen list allows nobody.
4. **Never lose a message, never duplicate one.** An ack-gated durable buffer replays each
   profile's messages in order after a restart on either side.
5. **Few moving parts.** One process, built-in sqlite, one YAML file, static secrets, and explicit
   one-off pairing. No enrollment, OIDC, or REST API.
6. **Low ban risk.** Use a dedicated number, conversational traffic, no avoidable WhatsApp
   requests, and no group discovery.
7. **Easy to operate.** `check-config` reports every problem, `env` prints exactly what Hermes
   needs, and exit codes are meaningful.

Accepted trade-offs:

- **K1:** `/healthz` is unauthenticated and exposes profile names, connection/buffer state, holds,
  and version. Container health checks need it; bind privately if names are sensitive.
- **K2:** `/mcp` and `/management` use plain HTTP and WebSocket, with no built-in TLS. This targets
  LAN or single-host deployments; put TLS in front if exposed.
- **K3:** One management secret has full control, with no scopes, read-only token, or auth-failure
  throttle. This is for personal use; use at least 32 random characters.
- **K4:** `create_profile` and `rotate_profile_secret` store generated secrets inline in
  `config.yaml`. The file is mode 0600 and already contains sensitive configuration.
- **K5:** Management holds are in memory, so restart clears them. A hold only bridges the short
  interval between `close_profile` and suspending an agent.
- **K6:** Reply memory for `default_profile` DMs is in memory, limited to 1,024 chats, and resets on
  restart or any MCP config change. The contact can write again to restore it.
- **K7:** A route to an unregistered group is only a `check-config` warning, and its messages are
  dropped. Registration and routing remain independent.
- **K8:** A group message starting with `/` bypasses mention gating because a slash command is an
  explicit address to the bot.
- **K9:** Hermes may relax mention gating through `/relay/policy` unless the route pins
  `require_mention`. The policy affects only that agent's own groups.
- **K10:** `allow_unrouted_outbound` is one global escape hatch. It is off by default.
- **K11:** There is no enrollment: `/relay/enroll` and `/relay/provision` return 404. The operator
  pastes four environment lines or uses `create_profile`.
- **K12:** Baileys is unofficial and pinned exactly. The ban risk is accepted and reduced by using
  a dedicated number.
- **K13:** LIDs are accepted wherever users are named. Validation warns because they are opaque.
- **K14:** Edit streaming is on by default. Streaming replies are worth WhatsApp's "edited" label,
  and the setting can be disabled.
- **K15:** Tokens with `exp=0` (never expire) are accepted because upstream Hermes accepts them.
- **K16:** Hand-edit `config.yaml` only while stopped; there is no file watch or lock. The
  management plane owns the file while running.
- **K17:** Unacked messages expire after `buffer.max_age_seconds` (14 days by default), and
  re-hosted media after `media.retention_seconds` (7 days), bounding disk use.
- **K18:** `wa-auth/` and media are unencrypted at rest. Protect the data directory.
- **K19:** `interrupt` frames are logged only; there are no connector-side turns to cancel.
- **K20:** There is no WhatsApp group discovery or deletion tool. Discovery adds ban risk, and
  WhatsApp offers leaving rather than deleting.
- **K21:** An outbound action already started when a session closes may still reach WhatsApp, but
  its result is dropped. An in-flight WhatsApp send cannot be cancelled.

## Quick start (Docker)

```bash
git clone <repo-url> whatrouter && cd whatrouter
mkdir -p data
cp config.example.yaml data/config.yaml
openssl rand -hex 32 # generate a unique value for each profile
openssl rand -hex 32 # generate the management secret
```

Edit `data/config.yaml`: keep `data_dir: /data`, set a reachable `public_url`, replace every
placeholder secret, and configure profiles, routes, registered groups, and `management.secret`.
The management plane is the normal operating interface. The single `./data:/data` mount must stay
writable because MCP rewrites `/data/config.yaml` atomically; do not add a separate read-only config
mount. If the host directory is not writable by the image's UID 1000, run
`sudo chown 1000:1000 data`.

```bash
docker compose run --rm whatrouter check-config
docker compose run --rm -it whatrouter pair
# If this terminal cannot display a QR:
docker compose run --rm -it whatrouter pair --code +34600000000
docker compose up -d
curl -s localhost:8466/healthz
docker compose logs -f
```

Pair from WhatsApp on the bot phone under Settings -> Linked devices -> Link a device. `serve`
never prints a QR; pairing is an explicit one-off. Send a routed DM to verify delivery; in a routed
group, mention or reply to the bot unless the route allows unaddressed messages.

## Quick start (Node)

Node 24 or newer is required for built-in `node:sqlite`. `ffmpeg` on `PATH` is optional; without
it, voice replies fall back to ordinary audio attachments.

```bash
npm ci
npm run build
cp config.example.yaml config.yaml # set data_dir to a writable path such as ./data
node dist/whatrouter.js check-config config.yaml
node dist/whatrouter.js --config config.yaml pair
node dist/whatrouter.js --config config.yaml serve
```

`npm link` installs the `whatrouter` binary into your npm prefix. Config resolution is
`--config <path>`, then `$WHATROUTER_CONFIG`, then `./config.yaml`. Exit codes are 0 for success,
1 for runtime failure, and 2 for bad configuration or usage.

## Hermes side

For a profile named `work`, print its environment and copy it securely to that Hermes host:

```bash
docker compose run --rm whatrouter env work
```

| Variable                                               | Meaning                                                               |
| ------------------------------------------------------ | --------------------------------------------------------------------- |
| `GATEWAY_RELAY_URL=wss://whatrouter.example.com/relay` | Relay endpoint derived from `public_url`; otherwise a local fallback. |
| `GATEWAY_RELAY_ID=gw-work`                             | The profile's `gateway_id`.                                           |
| `GATEWAY_RELAY_SECRET=<32+ chars>`                     | Secret used by Hermes to sign relay tokens.                           |
| `GATEWAY_RELAY_PLATFORMS=whatsapp`                     | Platform fronted through this relay.                                  |

Append the lines to `~/.hermes/.env`, then run `hermes gateway restart`. From the agent's point of
view the platform is `whatsapp`; DMs use phone or LID JIDs and groups use `<digits>@g.us`. Replies
use WhatsApp markdown and are split at 4096 characters. An off-host Hermes needs `public_url` to
reach re-hosted inbound media.

## Configuration

[`config.example.yaml`](config.example.yaml) is the commented reference for every key, default,
and credential source, including `${ENV_VAR}` interpolation and `secret_file`. Only `profiles`,
`groups`, and `default_profile` are live after an MCP write; listener, management, WhatsApp,
buffer, media, logging, public URL, and unrestricted-outbound settings are captured at boot.
Hand-edit only while stopped, then run `check-config` before restarting. `default_profile` is a
DM-only fallback: groups must be registered and explicitly routed.

## Management

`/mcp` is the normal configuration and WhatsApp-management interface. It uses authenticated,
stateful Streamable HTTP MCP; clients discover the current tools, input schemas, and descriptions
through `tools/list` rather than a duplicated table here.

`/management` is the singleton lifecycle-orchestration WebSocket for pending-message events and
profile reconnect holds. Its framing, guarantees, limits, hold behavior, and close codes are the
header contract in [`src/management/frames.ts`](src/management/frames.ts).

Both interfaces use the same full-control management secret and are absent when `management` is
not configured. `/healthz` remains unauthenticated. There is no built-in TLS, so bind WhatRouter
privately and protect every network leg if management is exposed beyond a trusted host or LAN.

## Operations

- **Health:** `GET /healthz` reports version, WhatsApp state, and each profile's connection,
  buffered count, and active hold. The container health check uses it.
- **Logs:** JSON goes to stdout. `WHATROUTER_LOG_LEVEL=debug` overrides the configured level at
  startup.
- **Stop:** SIGTERM closes relay and management sockets normally, stops WhatsApp, and closes sqlite;
  `docker compose stop` is graceful.
- **Retention:** buffered messages and media are purged hourly using the configured boot-time ages.
- **Backup:** back up the complete data directory. Stop first, or use sqlite's `.backup` for the
  database. Treat `wa-auth/` as full linked-device access and never commit or share it.
- **Upgrade:** `git pull && docker compose build && docker compose up -d`. Migrations run on open;
  pairing and buffered messages survive.
- **Secret rotation:** use MCP `rotate_profile_secret` for an inline profile secret, update the
  returned Hermes environment, and restart that gateway. For `${ENV}` or `secret_file`, rotate the
  source while WhatRouter is stopped, restart it, update Hermes, and restart the gateway.
- **Config edits:** stop WhatRouter, edit, run `check-config`, and start it again. While running,
  only MCP should mutate the file.

## Troubleshooting

| Symptom                                          | Cause and fix                                                                                                                                                              |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `4401 unauthorized`                              | Relay ID or secret matches no profile. Compare with `whatrouter env <profile>` and restart Hermes after correcting it.                                                     |
| `4401 expired`                                   | The machines' clocks differ by roughly five minutes or more. Fix NTP.                                                                                                      |
| Hermes says auth was revoked                     | Hermes deliberately latches a post-handshake 4401. Fix credentials, then run `hermes gateway restart`.                                                                     |
| `1008 duplicate session`                         | Two gateways use one `gateway_id`; the new connection is refused. Give each its own profile.                                                                               |
| `1013 try again later`                           | Repeated relay-auth failures from this IP triggered the one-minute throttle. Correct the credentials and wait.                                                             |
| `1013 profile temporarily suspended`             | Management started a 20-second reconnect hold. Hermes retries; `/healthz` shows `blockedUntilMs`.                                                                          |
| Docker reports `EACCES` under `data`             | Keep `data_dir: /data` and make `./data` writable by UID 1000.                                                                                                             |
| `serve` exits 2 with a pairing hint              | Pair once using the same data volume before serving.                                                                                                                       |
| WhatsApp state is `unpaired` after logout        | The linked device was removed or invalidated. Remove that data directory's `wa-auth/` only when intentionally re-pairing.                                                  |
| One contact never arrives                        | Its ID may be an opaque `<digits>@lid`. Copy the JID from `unrouted chat dropped` into a DM route.                                                                         |
| The bot ignores a group                          | Register it, allow the sender in `groups.*.listen`, add an explicit profile route, then check mention and `allowed_senders` gates. `default_profile` never selects groups. |
| An unrouted DM is neither delivered nor buffered | Add a DM route or set `default_profile`; dropping it is fail-closed behavior.                                                                                              |
| Hermes cannot fetch media                        | Set `public_url` to an address the Hermes host can reach, then restart WhatRouter.                                                                                         |
| Media is rejected                                | It exceeds `media.max_bytes` (25 MiB by default).                                                                                                                          |
| `check-config` prints path errors                | Fix every listed issue. Exit code 2 also covers bad commands and flags.                                                                                                    |

## Development

```bash
npm ci
npm run dev -- check-config config.example.yaml
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

Conformance starts WhatRouter with fake WhatsApp and drives the real Hermes relay transport through
handshake, routing, outbound operations, buffering, `going_idle`, replay, management holds, and
authentication failures:

```bash
HERMES_CHECKOUT=/path/to/hermes-agent scripts/conformance/run.sh
```

It requires [uv](https://docs.astral.sh/uv/) (which fetches a few Python packages) and an existing
Hermes checkout, but no phone, LLM key, or installation into that checkout.

| Path                   | Contents                                                                      |
| ---------------------- | ----------------------------------------------------------------------------- |
| `src/config/`          | YAML schema, interpolation, validation, and atomic live store.                |
| `src/http/`            | Shared HTTP/WebSocket server and request helpers.                             |
| `src/relay/`           | Relay auth, gate, hub, routes, frames, descriptor, and session state machine. |
| `src/management/`      | Lifecycle WebSocket contract, endpoint, and reconnect holds.                  |
| `src/mcp/`             | MCP endpoint and self-describing management tools.                            |
| `src/router/`          | Route table, inbound gates, event mapping, and outbound tenant checks.        |
| `src/store/`           | `node:sqlite` buffer, policies, and media index.                              |
| `src/whatsapp/`        | Port, Baileys adapter, pairing, normalization, formatting, and fake.          |
| `src/util/`            | Logging, bounded streams, and guarded public-URL fetching.                    |
| `test/`                | Unit/integration tests and recorded Baileys fixtures.                         |
| `scripts/conformance/` | Probe against the real Hermes transport.                                      |

MIT licensed. See [LICENSE](LICENSE).
