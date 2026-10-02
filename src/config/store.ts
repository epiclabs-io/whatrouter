import { readFileSync } from "node:fs";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  Scalar,
  type Document,
  type YAMLMap,
  type YAMLSeq,
} from "yaml";
import { formatUserIdentity } from "../whatsapp/jid.js";
import { loadConfigFile, validateConfig } from "./load.js";
import { ConfigError, type Config, type Issue } from "./schema.js";

export type ConfigDocument = Document.Parsed;
export type ConfigMutator = (document: ConfigDocument) => void | Promise<void>;
export type ConfigPostCommit = (config: Config) => void | Promise<void>;

const locks = new Map<string, Promise<void>>();

async function locked<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(path, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(path) === current) {
      locks.delete(path);
    }
  }
}

function formattedIdentity(raw: string): string | null {
  const formatted = formatUserIdentity(raw);
  return formatted;
}

function formatIdentityAt(map: YAMLMap, key: string): void {
  const value = map.get(key, true);
  if (!isScalar(value) || typeof value.value !== "string") {
    return;
  }
  const formatted = formattedIdentity(value.value);
  if (formatted !== null) {
    value.value = formatted;
    value.type = Scalar.QUOTE_DOUBLE;
  }
}

function formatIdentityList(sequence: YAMLSeq): void {
  sequence.items.forEach((value) => {
    if (!isScalar(value) || typeof value.value !== "string" || value.value.trim() === "*") {
      return;
    }
    const formatted = formattedIdentity(value.value);
    if (formatted !== null) {
      value.value = formatted;
      value.type = Scalar.QUOTE_DOUBLE;
    }
  });
}

/** Keep persisted phone identities readable and strings (not YAML numbers). */
function formatUserIdentities(document: ConfigDocument): void {
  const profiles = document.get("profiles", true);
  if (isMap(profiles)) {
    for (const profilePair of profiles.items) {
      if (!isMap(profilePair.value)) {
        continue;
      }
      const routes = profilePair.value.get("routes", true);
      if (!isSeq(routes)) {
        continue;
      }
      for (const route of routes.items) {
        if (!isMap(route)) {
          continue;
        }
        formatIdentityAt(route, "dm");
        const allowed = route.get("allowed_senders", true);
        if (isSeq(allowed)) {
          formatIdentityList(allowed);
        }
      }
    }
  }

  const groups = document.get("groups", true);
  if (isMap(groups)) {
    for (const groupPair of groups.items) {
      if (!isMap(groupPair.value)) {
        continue;
      }
      const listen = groupPair.value.get("listen", true);
      if (isSeq(listen)) {
        formatIdentityList(listen);
      }
    }
  }
}

function parseConfigDocument(path: string, text: string): ConfigDocument {
  const document = parseDocument(text, { keepSourceTokens: true });
  if (document.errors.length > 0) {
    throw new ConfigError([
      {
        path,
        message: `invalid YAML: ${document.errors.map((error) => error.message).join("; ")}`,
      },
    ]);
  }
  return document;
}

async function fsyncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

export class ConfigStore {
  readonly path: string;
  #current: Config | null = null;
  #warnings: Issue[] = [];

  constructor(path: string) {
    this.path = path;
  }

  static async load(path: string): Promise<ConfigStore> {
    const store = new ConfigStore(path);
    await store.reload();
    return store;
  }

  get current(): Config {
    if (this.#current === null) {
      throw new Error("ConfigStore has not been loaded");
    }
    return this.#current;
  }

  get warnings(): readonly Issue[] {
    return this.#warnings;
  }

  get(): Config {
    return this.current;
  }

  async reload(): Promise<Config> {
    const loaded = await loadConfigFile(this.path);
    this.#current = loaded.config;
    this.#warnings = loaded.warnings;
    return loaded.config;
  }

  async mutate(mutator: ConfigMutator, postCommit?: ConfigPostCommit): Promise<Config> {
    return await locked(this.path, async () => {
      const text = await readFile(this.path, "utf8");
      const document = parseConfigDocument(this.path, text);
      await mutator(document);
      formatUserIdentities(document);

      const candidate = document.toString();
      const reparsed = parseConfigDocument(this.path, candidate);
      const result = validateConfig(reparsed.toJS() ?? {}, {
        env: process.env,
        readFile: (path) => requireReadFile(path),
      });
      if (!result.ok) {
        throw new ConfigError(result.errors);
      }

      const directory = dirname(this.path);
      const tempPath = join(
        directory,
        `.${basename(this.path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
      );
      let tempCreated = false;
      try {
        const handle = await open(tempPath, "wx", 0o600);
        tempCreated = true;
        try {
          await handle.writeFile(candidate, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(tempPath, this.path);
        tempCreated = false;
        await fsyncDirectory(directory);
      } finally {
        if (tempCreated) {
          await unlink(tempPath).catch(() => undefined);
        }
      }

      const config = await this.reload();
      await postCommit?.(config);
      return config;
    });
  }
}

function requireReadFile(path: string): string {
  // Validation's secret-file hook is synchronous by design.
  return readFileSync(path, "utf8");
}
