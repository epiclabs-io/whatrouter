import { describe, expect, it } from "vitest";
import { validateConfig, type ValidateContext } from "../../src/config/load.js";
import { relayUrl, type Config, type Issue } from "../../src/config/schema.js";

const SECRET_A = "a".repeat(32);
const SECRET_B = "b".repeat(40);

interface RawProfile {
  gateway_id: string;
  secret?: string;
  secret_file?: string;
  display_name?: string | null;
  wake_url?: string | null;
  routes?: unknown[];
}

function raw(profiles: Record<string, RawProfile>, extra: Record<string, unknown> = {}): unknown {
  return { profiles, ...extra };
}

function ok(input: unknown, ctx?: ValidateContext): { config: Config; warnings: Issue[] } {
  const result = validateConfig(input, ctx);
  if (!result.ok) {
    throw new Error(`expected valid config, got ${JSON.stringify(result.errors)}`);
  }
  return { config: result.config, warnings: result.warnings };
}

function errors(input: unknown, ctx?: ValidateContext): Issue[] {
  const result = validateConfig(input, ctx);
  if (result.ok) {
    throw new Error("expected validation to fail");
  }
  return result.errors;
}

function find(list: Issue[], path: string): Issue {
  const issue = list.find((e) => e.path === path);
  if (issue === undefined) {
    throw new Error(`no issue at ${path}; got ${JSON.stringify(list)}`);
  }
  return issue;
}

describe("defaults", () => {
  it("fills in every documented default", () => {
    const { config } = ok(
      raw({ work: { gateway_id: "gw-work", secret: SECRET_A, routes: [{ dm: "+34600000000" }] } })
    );
    expect(config.listen).toEqual({ host: "0.0.0.0", port: 8466 });
    expect(config.publicUrl).toBeNull();
    expect(config.dataDir).toBe("./data");
    expect(config.logLevel).toBe("info");
    expect(config.whatsapp).toEqual({
      editStreaming: true,
      sendReadReceipts: false,
      chunkDelayMs: 300,
      sendTimeoutMs: 60000,
    });
    expect(config.buffer).toEqual({ maxAgeSeconds: 1209600, wakeCooldownSeconds: 60 });
    expect(config.media).toEqual({ maxBytes: 26214400, retentionSeconds: 604800 });
    expect(config.defaultProfile).toBeNull();
    expect(config.allowUnroutedOutbound).toBe(false);
    expect(config.management).toBeNull();
    expect(config.groups).toEqual({});
    expect(config.profiles[0]).toMatchObject({
      name: "work",
      gatewayId: "gw-work",
      displayName: null,
      wakeUrl: null,
    });
  });
});

describe("route normalization", () => {
  it("canonicalizes phone numbers, jids and allowed senders", () => {
    const { config } = ok(
      raw({
        work: {
          gateway_id: "gw-work",
          secret: SECRET_A,
          routes: [
            { dm: "+34 600 000 000" },
            { dm: "34600000001@s.whatsapp.net" },
            { dm: "123456789012345@lid" },
            {
              group: "120363001234567890@g.us",
              allowed_senders: ["+34 600 000 000", "999888777@lid"],
            },
          ],
        },
      })
    );
    expect(config.profiles[0]?.routes).toEqual([
      { kind: "dm", id: "34600000000@s.whatsapp.net" },
      { kind: "dm", id: "34600000001@s.whatsapp.net" },
      { kind: "dm", id: "123456789012345@lid" },
      {
        kind: "group",
        id: "120363001234567890@g.us",
        requireMention: undefined,
        allowedSenders: ["34600000000@s.whatsapp.net", "999888777@lid"],
      },
    ]);
  });

  it("keeps require_mention tri-state so the router can apply policy precedence", () => {
    const { config } = ok(
      raw({
        work: {
          gateway_id: "gw-work",
          secret: SECRET_A,
          routes: [
            { group: "1@g.us" },
            { group: "2@g.us", require_mention: false },
            { group: "3@g.us", require_mention: true },
          ],
        },
      })
    );
    expect(
      config.profiles[0]?.routes.map((r) => (r.kind === "group" ? r.requireMention : null))
    ).toEqual([undefined, false, true]);
  });
});

describe("group registry", () => {
  const profiles = { work: { gateway_id: "gw-work", secret: SECRET_A, routes: [] } };

  it("normalizes defaults, bare phones, PN JIDs and LID JIDs", () => {
    const { config, warnings } = ok(
      raw(profiles, {
        groups: {
          "120363001234567890-123@g.us": {
            listen_source: "explicit",
            listen: ["34600000000", "34600000001@s.whatsapp.net", "999888777@lid"],
          },
        },
      })
    );
    expect(config.groups["120363001234567890-123@g.us"]).toEqual({
      displayName: null,
      adminsSeen: null,
      listenSource: "explicit",
      listen: ["34600000000@s.whatsapp.net", "34600000001@s.whatsapp.net", "999888777@lid"],
    });
    expect(find(warnings, "groups.120363001234567890-123@g.us.listen[2]").message).toContain(
      "opaque"
    );
  });

  it("accepts a lone wildcard and rejects wildcard/user mixtures", () => {
    const wildcard = ok(
      raw(profiles, {
        groups: { "1@g.us": { listen_source: "default_admin", listen: ["*"] } },
      })
    );
    expect(wildcard.config.groups["1@g.us"]?.listen).toEqual(["*"]);

    const list = errors(
      raw(profiles, {
        groups: {
          "1@g.us": { listen_source: "explicit", listen: ["*", "34600000000"] },
        },
      })
    );
    expect(find(list, "groups.1@g.us.listen").message).toContain("only listen entry");
  });

  it("requires normalized group keys and nonnegative admins_seen", () => {
    const keyErrors = errors(
      raw(profiles, {
        groups: { "1@G.US": { listen_source: "explicit" } },
      })
    );
    expect(find(keyErrors, "groups.1@G.US").message).toContain("normalized");

    const countErrors = errors(
      raw(profiles, {
        groups: { "1@g.us": { listen_source: "explicit", admins_seen: -1 } },
      })
    );
    expect(find(countErrors, "groups.1@g.us.admins_seen").message).toContain(">=0");
  });

  it("warns for LIDs in DM and allowed-sender routes", () => {
    const { warnings } = ok(
      raw({
        work: {
          gateway_id: "gw-work",
          secret: SECRET_A,
          routes: [
            { dm: "123456789012345@lid" },
            { group: "1@g.us", allowed_senders: ["999888777@lid"] },
          ],
        },
      })
    );
    expect(warnings.map((warning) => warning.path)).toEqual([
      "profiles.work.routes[0].dm",
      "profiles.work.routes[1].group",
      "profiles.work.routes[1].allowed_senders[0]",
    ]);
  });

  it("warns for routes missing registry entries and registered groups missing routes", () => {
    const { warnings } = ok(
      raw(
        {
          work: {
            gateway_id: "gw-work",
            secret: SECRET_A,
            routes: [{ group: "1@g.us" }],
          },
        },
        { groups: { "2@g.us": { listen_source: "explicit", listen: [] } } }
      )
    );
    expect(find(warnings, "profiles.work.routes[0].group").message).toContain("not present");
    expect(find(warnings, "groups.2@g.us").message).toContain("no profile route");
  });
});

describe("cross-field validation", () => {
  it("rejects duplicate gateway_id", () => {
    const list = errors(
      raw({
        work: { gateway_id: "gw", secret: SECRET_A, routes: [{ dm: "+34600000000" }] },
        home: { gateway_id: "gw", secret: SECRET_B, routes: [{ dm: "+34600000001" }] },
      })
    );
    expect(find(list, "profiles.home.gateway_id").message).toContain('duplicate gateway_id "gw"');
    expect(find(list, "profiles.home.gateway_id").message).toContain('profile "work"');
  });

  it("rejects secrets shorter than 32 chars", () => {
    const list = errors(raw({ work: { gateway_id: "gw", secret: "short", routes: [] } }));
    expect(find(list, "profiles.work.secret").message).toContain(
      "secret is too short (5 chars, minimum 32)"
    );
  });

  it("rejects the same secret in two profiles", () => {
    const list = errors(
      raw({
        work: { gateway_id: "gw-work", secret: SECRET_A, routes: [{ dm: "+34600000000" }] },
        home: { gateway_id: "gw-home", secret: SECRET_A, routes: [{ dm: "+34600000001" }] },
      })
    );
    expect(find(list, "profiles.home.secret").message).toBe(
      'secret is also used by profile "work"'
    );
  });

  it("rejects a dm routed to two profiles, naming both", () => {
    const list = errors(
      raw({
        work: { gateway_id: "gw-work", secret: SECRET_A, routes: [{ dm: "+34600000000" }] },
        home: {
          gateway_id: "gw-home",
          secret: SECRET_B,
          routes: [{ dm: "34600000000@s.whatsapp.net" }],
        },
      })
    );
    expect(find(list, "profiles.home.routes[0].dm").message).toBe(
      'chat 34600000000@s.whatsapp.net is routed to both profile "work" and profile "home"'
    );
  });

  it("rejects a group routed to two profiles", () => {
    const list = errors(
      raw({
        work: {
          gateway_id: "gw-work",
          secret: SECRET_A,
          routes: [{ group: "120363001234567890@g.us" }],
        },
        home: {
          gateway_id: "gw-home",
          secret: SECRET_B,
          routes: [{ group: "120363001234567890@g.us" }],
        },
      })
    );
    expect(find(list, "profiles.home.routes[0].group").message).toContain(
      'routed to both profile "work"'
    );
  });

  it("rejects the same chat routed twice inside one profile", () => {
    const list = errors(
      raw({
        work: {
          gateway_id: "gw",
          secret: SECRET_A,
          routes: [{ dm: "+34600000000" }, { dm: "34600000000@c.us" }],
        },
      })
    );
    expect(find(list, "profiles.work.routes[1].dm").message).toBe(
      'chat 34600000000@s.whatsapp.net is routed twice in profile "work"'
    );
  });

  it("collects every error instead of stopping at the first", () => {
    const list = errors(
      raw(
        {
          work: { gateway_id: "gw", secret: "short", routes: [{ dm: "nope" }] },
          home: { gateway_id: "gw", secret: SECRET_B, routes: [{ group: "also-nope" }] },
        },
        { default_profile: "missing" }
      )
    );
    expect(list.map((e) => e.path).sort()).toEqual([
      "default_profile",
      "profiles.home.gateway_id",
      "profiles.home.routes[0].group",
      "profiles.work.routes[0].dm",
      "profiles.work.secret",
    ]);
  });

  it("rejects malformed phones and group jids", () => {
    const list = errors(
      raw({
        work: {
          gateway_id: "gw",
          secret: SECRET_A,
          routes: [
            { dm: "12345" },
            { dm: "not a number" },
            { group: "+34600000000" },
            { group: "120363001234567890@s.whatsapp.net" },
          ],
        },
      })
    );
    expect(find(list, "profiles.work.routes[0].dm").message).toContain(
      'invalid phone number or JID "12345"'
    );
    expect(find(list, "profiles.work.routes[1].dm").message).toContain(
      "invalid phone number or JID"
    );
    expect(find(list, "profiles.work.routes[2].group").message).toContain("expected <digits>@g.us");
    expect(find(list, "profiles.work.routes[3].group").message).toContain("expected <digits>@g.us");
  });

  it("rejects malformed allowed_senders", () => {
    const list = errors(
      raw({
        work: {
          gateway_id: "gw",
          secret: SECRET_A,
          routes: [{ group: "1@g.us", allowed_senders: ["+34600000000", "bogus"] }],
        },
      })
    );
    expect(find(list, "profiles.work.routes[0].allowed_senders[1]").message).toContain(
      'invalid phone number or JID "bogus"'
    );
  });

  it("rejects an unknown default_profile", () => {
    const list = errors(
      raw(
        { work: { gateway_id: "gw", secret: SECRET_A, routes: [{ dm: "+34600000000" }] } },
        { default_profile: "nope" }
      )
    );
    expect(find(list, "default_profile").message).toBe('unknown profile "nope"');
  });

  it("accepts a known default_profile", () => {
    const { config } = ok(
      raw(
        { work: { gateway_id: "gw", secret: SECRET_A, routes: [{ dm: "+34600000000" }] } },
        { default_profile: "work" }
      )
    );
    expect(config.defaultProfile).toBe("work");
  });

  it("rejects a route with both or neither of dm and group", () => {
    const both = errors(
      raw({
        work: {
          gateway_id: "gw",
          secret: SECRET_A,
          routes: [{ dm: "+34600000000", group: "1@g.us" }],
        },
      })
    );
    expect(find(both, "profiles.work.routes[0]").message).toContain(
      'exactly one of "dm" or "group"'
    );
    const neither = errors(
      raw({ work: { gateway_id: "gw", secret: SECRET_A, routes: [{ require_mention: true }] } })
    );
    expect(find(neither, "profiles.work.routes[0]").message).toContain(
      'exactly one of "dm" or "group"'
    );
  });

  it("rejects unknown keys", () => {
    const list = errors(
      raw({ work: { gateway_id: "gw", secret: SECRET_A, routes: [] } }, { lisen: "0.0.0.0:1" })
    );
    expect(list.some((e) => /lisen/.test(`${e.path} ${e.message}`))).toBe(true);
  });

  it("requires at least one profile", () => {
    expect(errors({ profiles: {} }).some((e) => e.path === "profiles")).toBe(true);
    expect(errors({}).some((e) => e.path === "profiles")).toBe(true);
  });

  it("warns (but does not fail) on a profile with no routes", () => {
    const { warnings } = ok(raw({ work: { gateway_id: "gw", secret: SECRET_A, routes: [] } }));
    expect(warnings).toEqual([
      {
        path: "profiles.work.routes",
        message: 'profile "work" has no routes; it will never receive messages',
      },
    ]);
  });
});

describe("secrets", () => {
  it("interpolates ${ENV_VAR} in strings", () => {
    const { config } = ok(
      raw({ work: { gateway_id: "gw", secret: "${WORK_SECRET}", routes: [] } }),
      {
        env: { WORK_SECRET: SECRET_B },
      }
    );
    expect(config.profiles[0]?.secret).toBe(SECRET_B);
  });

  it("reports the variable name when it is unset", () => {
    const list = errors(raw({ work: { gateway_id: "gw", secret: "${WORK_SECRET}", routes: [] } }), {
      env: {},
    });
    expect(find(list, "profiles.work.secret").message).toBe(
      "environment variable WORK_SECRET is not set"
    );
  });

  it("reads secret_file and trims it", () => {
    const { config } = ok(
      raw({ work: { gateway_id: "gw", secret_file: "/run/secrets/work", routes: [] } }),
      {
        readFile: (p) =>
          p === "/run/secrets/work"
            ? `${SECRET_B}\n`
            : (() => {
                throw new Error("ENOENT");
              })(),
      }
    );
    expect(config.profiles[0]?.secret).toBe(SECRET_B);
  });

  it("reports an unreadable secret_file", () => {
    const list = errors(raw({ work: { gateway_id: "gw", secret_file: "/missing", routes: [] } }), {
      readFile: () => {
        throw new Error("ENOENT: no such file");
      },
    });
    expect(find(list, "profiles.work.secret_file").message).toContain(
      'cannot read secret_file "/missing"'
    );
  });

  it("requires exactly one of secret and secret_file", () => {
    const both = errors(
      raw({ work: { gateway_id: "gw", secret: SECRET_A, secret_file: "/x", routes: [] } })
    );
    expect(find(both, "profiles.work.secret").message).toBe(
      'set either "secret" or "secret_file", not both'
    );
    const neither = errors(raw({ work: { gateway_id: "gw", routes: [] } }));
    expect(find(neither, "profiles.work.secret").message).toBe(
      'missing "secret" (or "secret_file")'
    );
  });
});

describe("listen, public_url and relay url", () => {
  it("parses listen and rejects garbage", () => {
    const { config } = ok(
      raw(
        { work: { gateway_id: "gw", secret: SECRET_A, routes: [] } },
        { listen: "127.0.0.1:9000" }
      )
    );
    expect(config.listen).toEqual({ host: "127.0.0.1", port: 9000 });
    const list = errors(
      raw({ work: { gateway_id: "gw", secret: SECRET_A, routes: [] } }, { listen: "nope" })
    );
    expect(find(list, "listen").message).toContain("invalid listen address");
  });

  it("strips the trailing slash from public_url and rejects non-http urls", () => {
    const { config } = ok(
      raw(
        { work: { gateway_id: "gw", secret: SECRET_A, routes: [] } },
        { public_url: "https://wr.example.com/" }
      )
    );
    expect(config.publicUrl).toBe("https://wr.example.com");
    expect(relayUrl(config)).toBe("wss://wr.example.com/relay");

    const list = errors(
      raw({ work: { gateway_id: "gw", secret: SECRET_A, routes: [] } }, { public_url: "ftp://x" })
    );
    expect(find(list, "public_url").message).toContain("expected an http(s) URL");
  });

  it("derives the relay url from listen when public_url is unset", () => {
    const { config } = ok(
      raw({ work: { gateway_id: "gw", secret: SECRET_A, routes: [] } }, { listen: "0.0.0.0:8466" })
    );
    expect(relayUrl(config)).toBe("ws://localhost:8466/relay");
  });

  it("uses ws:// for a plain-http public_url", () => {
    const { config } = ok(
      raw(
        { work: { gateway_id: "gw", secret: SECRET_A, routes: [] } },
        { public_url: "http://10.0.0.5:8466" }
      )
    );
    expect(relayUrl(config)).toBe("ws://10.0.0.5:8466/relay");
  });

  it("rejects a malformed wake_url", () => {
    const list = errors(
      raw({ work: { gateway_id: "gw", secret: SECRET_A, wake_url: "nope", routes: [] } })
    );
    expect(find(list, "profiles.work.wake_url").message).toContain("expected an http(s) URL");
  });
});

describe("management", () => {
  const MGMT = "m".repeat(48);
  const profiles = { work: { gateway_id: "gw-work", secret: SECRET_A, routes: [] } };

  it("accepts an inline secret", () => {
    const { config } = ok(raw(profiles, { management: { secret: MGMT } }));
    expect(config.management).toEqual({ secret: MGMT });
  });

  it("interpolates ${ENV_VAR}", () => {
    const { config } = ok(
      raw(profiles, { management: { secret: "${WHATROUTER_MANAGEMENT_SECRET}" } }),
      { env: { WHATROUTER_MANAGEMENT_SECRET: MGMT } }
    );
    expect(config.management).toEqual({ secret: MGMT });
  });

  it("reports an unset interpolation variable", () => {
    const list = errors(raw(profiles, { management: { secret: "${MISSING_MGMT}" } }), {
      env: {},
    });
    expect(find(list, "management.secret").message).toBe(
      "environment variable MISSING_MGMT is not set"
    );
  });

  it("reads secret_file and trims it", () => {
    const { config } = ok(
      raw(profiles, { management: { secret_file: "/run/secrets/whatrouter-management" } }),
      {
        readFile: (p) => {
          if (p !== "/run/secrets/whatrouter-management") {
            throw new Error("ENOENT");
          }
          return `  ${MGMT}\n`;
        },
      }
    );
    expect(config.management).toEqual({ secret: MGMT });
  });

  it("reports an unreadable secret_file", () => {
    const list = errors(raw(profiles, { management: { secret_file: "/missing" } }), {
      readFile: () => {
        throw new Error("ENOENT");
      },
    });
    expect(find(list, "management.secret_file").message).toContain(
      'cannot read secret_file "/missing"'
    );
  });

  it("requires exactly one of secret and secret_file", () => {
    const both = errors(raw(profiles, { management: { secret: MGMT, secret_file: "/x" } }));
    expect(find(both, "management.secret").message).toBe(
      'set either "secret" or "secret_file", not both'
    );
    const neither = errors(raw(profiles, { management: {} }));
    expect(find(neither, "management.secret").message).toBe('missing "secret" (or "secret_file")');
  });

  it("enforces the minimum secret length", () => {
    const list = errors(raw(profiles, { management: { secret: "short" } }));
    expect(find(list, "management.secret").message).toBe(
      "secret is too short (5 chars, minimum 32)"
    );
    const fromFile = errors(raw(profiles, { management: { secret_file: "/s" } }), {
      readFile: () => "tiny\n",
    });
    expect(find(fromFile, "management.secret_file").message).toContain("secret is too short");
  });

  it("rejects a management secret equal to a profile secret", () => {
    const list = errors(raw(profiles, { management: { secret: SECRET_A } }));
    expect(find(list, "management.secret").message).toBe(
      'management secret must differ from every profile secret (also used by profile "work")'
    );
    const viaFile = errors(raw(profiles, { management: { secret_file: "/s" } }), {
      readFile: () => `${SECRET_A}\n`,
    });
    expect(find(viaFile, "management.secret_file").message).toContain("must differ");
  });

  it("rejects unknown keys in the management block", () => {
    const list = errors(raw(profiles, { management: { secret: MGMT, token: "x" } }));
    expect(list.some((e) => e.path.startsWith("management") && /token/.test(e.message))).toBe(true);
  });

  it("rejects an empty inline secret or a blank secret_file", () => {
    const inline = errors(raw(profiles, { management: { secret: "" } }));
    expect(find(inline, "management.secret").message).toBe("secret is empty (minimum 32 chars)");
    const whitespace = errors(raw(profiles, { management: { secret: " ".repeat(32) } }));
    expect(find(whitespace, "management.secret").message).toBe(
      "secret is empty (minimum 32 chars)"
    );
    const blank = errors(raw(profiles, { management: { secret_file: "/s" } }), {
      readFile: () => "  \n",
    });
    expect(find(blank, "management.secret_file").message).toBe(
      "secret is empty (minimum 32 chars)"
    );
    const viaEnv = errors(raw(profiles, { management: { secret: "${EMPTY}" } }), {
      env: { EMPTY: "" },
    });
    expect(find(viaEnv, "management.secret").message).toContain("secret is empty");
  });

  it("rejects an empty profile secret too", () => {
    const list = errors(raw({ work: { gateway_id: "gw", secret: "", routes: [] } }));
    expect(find(list, "profiles.work.secret").message).toBe("secret is empty (minimum 32 chars)");
    const whitespace = errors(
      raw({ work: { gateway_id: "gw", secret: " ".repeat(32), routes: [] } })
    );
    expect(find(whitespace, "profiles.work.secret").message).toContain("secret is empty");
  });

  it("rejects an empty profile name, which could never be managed", () => {
    const list = errors({ profiles: { "": { gateway_id: "gw", secret: SECRET_A, routes: [] } } });
    expect(list.some((e) => e.message === "profile names must not be empty")).toBe(true);
  });

  it("treats an explicit null block as disabled", () => {
    const { config } = ok(raw(profiles, { management: null }));
    expect(config.management).toBeNull();
  });
});
