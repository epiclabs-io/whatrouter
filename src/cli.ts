/**
 * CLI surface. `run()` is exported (and side-effect free apart from the injected
 * writers) so tests can drive it without spawning a process.
 */
import { parseArgs } from "node:util";
import { loadConfigFile } from "./config/load.js";
import { ConfigStore } from "./config/store.js";
import { ConfigError, relayUrl, type Config, type Issue } from "./config/schema.js";
import { runServe } from "./serve.js";
import { createLogger } from "./util/log.js";
import { runPair } from "./whatsapp/pair.js";

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_CONFIG = 2;

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

const processIo: CliIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

const USAGE = `whatrouter - Hermes Relay connector for WhatsApp

Usage:
  whatrouter [--config <path>] serve
  whatrouter [--config <path>] pair [--code <phone>]
  whatrouter [--config <path>] env <profile>
  whatrouter check-config [path]

Commands:
  serve           Run the relay server and the WhatsApp client (default).
  pair            Link the WhatsApp account: QR code, or pairing code with --code.
  env             Print the GATEWAY_RELAY_* lines for a profile's Hermes .env.
  check-config    Validate the config file and print a summary.

Options:
  --config <path>  Config file (default: $WHATROUTER_CONFIG, else ./config.yaml).
  --code <phone>   Pair with a phone-number code instead of a QR code.
  -h, --help       Show this help.`;

function configPath(explicit: string | undefined): string {
  return explicit ?? process.env["WHATROUTER_CONFIG"] ?? "./config.yaml";
}

function reportIssues(io: CliIo, kind: "error" | "warning", issues: Issue[]): void {
  for (const issue of issues) {
    io.err(`${kind}: ${issue.path}: ${issue.message}`);
  }
}

/** Loads the config, printing every error; returns null when it is invalid. */
async function load(
  io: CliIo,
  path: string
): Promise<{ config: Config; warnings: Issue[] } | null> {
  try {
    const loaded = await loadConfigFile(path);
    reportIssues(io, "warning", loaded.warnings);
    return loaded;
  } catch (err) {
    if (err instanceof ConfigError) {
      reportIssues(io, "error", err.errors);
      return null;
    }
    throw err;
  }
}

function summarize(io: CliIo, path: string, config: Config): void {
  const routeCount = config.profiles.reduce((n, p) => n + p.routes.length, 0);
  io.out(`config: ${path}`);
  io.out(`listen: ${config.listen.host}:${config.listen.port}`);
  io.out(`public_url: ${config.publicUrl ?? "(none)"}`);
  io.out(`data_dir: ${config.dataDir}`);
  io.out(`default_profile: ${config.defaultProfile ?? "(none, unrouted chats are dropped)"}`);
  io.out(`profiles: ${config.profiles.length} (${routeCount} routes)`);
  for (const profile of config.profiles) {
    const dms = profile.routes.filter((r) => r.kind === "dm").length;
    const groups = profile.routes.filter((r) => r.kind === "group").length;
    io.out(`  ${profile.name} [${profile.gatewayId}]: ${dms} dm, ${groups} group`);
  }
  io.out("config OK");
}

export async function run(argv: string[], io: CliIo = processIo): Promise<number> {
  let values: {
    config?: string | undefined;
    code?: string | undefined;
    help?: boolean | undefined;
  };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: "string" },
        code: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (err) {
    io.err(`error: ${err instanceof Error ? err.message : String(err)}`);
    io.err(USAGE);
    return EXIT_CONFIG;
  }

  if (values.help === true) {
    io.out(USAGE);
    return EXIT_OK;
  }

  const command = positionals[0] ?? "serve";

  switch (command) {
    case "serve": {
      const path = configPath(values.config);
      try {
        const configStore = await ConfigStore.load(path);
        reportIssues(io, "warning", [...configStore.warnings]);
        return await runServe({
          config: configStore.get(),
          configStore,
          log: createLogger({ level: configStore.get().logLevel, name: "whatrouter" }),
          io,
        });
      } catch (err) {
        if (err instanceof ConfigError) {
          reportIssues(io, "error", err.errors);
          return EXIT_CONFIG;
        }
        throw err;
      }
    }

    case "pair": {
      const loaded = await load(io, configPath(values.config));
      if (loaded === null) {
        return EXIT_CONFIG;
      }
      return await runPair({
        config: loaded.config,
        code: values.code,
        log: createLogger({ level: loaded.config.logLevel, name: "pair" }),
        io,
      });
    }

    case "env": {
      const name = positionals[1];
      if (name === undefined) {
        io.err("error: env requires a profile name");
        io.err(USAGE);
        return EXIT_CONFIG;
      }
      const loaded = await load(io, configPath(values.config));
      if (loaded === null) {
        return EXIT_CONFIG;
      }
      const profile = loaded.config.profiles.find((p) => p.name === name);
      if (profile === undefined) {
        const known = loaded.config.profiles.map((p) => p.name).join(", ");
        io.err(`error: unknown profile "${name}" (known profiles: ${known})`);
        return EXIT_CONFIG;
      }
      io.out(`GATEWAY_RELAY_URL=${relayUrl(loaded.config)}`);
      io.out(`GATEWAY_RELAY_ID=${profile.gatewayId}`);
      io.out(`GATEWAY_RELAY_SECRET=${profile.secret}`);
      io.out("GATEWAY_RELAY_PLATFORMS=whatsapp");
      return EXIT_OK;
    }

    case "check-config": {
      const path = configPath(positionals[1] ?? values.config);
      const loaded = await load(io, path);
      if (loaded === null) {
        return EXIT_CONFIG;
      }
      summarize(io, path, loaded.config);
      return EXIT_OK;
    }

    default:
      io.err(`error: unknown command "${command}"`);
      io.err(USAGE);
      return EXIT_CONFIG;
  }
}
