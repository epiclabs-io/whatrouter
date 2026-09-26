import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "../../src/util/log.js";

const previous = process.env["WHATROUTER_LOG_LEVEL"];

afterEach(() => {
  if (previous === undefined) {
    delete process.env["WHATROUTER_LOG_LEVEL"];
  } else {
    process.env["WHATROUTER_LOG_LEVEL"] = previous;
  }
});

describe("createLogger", () => {
  it("defaults to info and honours the configured level", () => {
    delete process.env["WHATROUTER_LOG_LEVEL"];
    expect(createLogger().level).toBe("info");
    expect(createLogger({ level: "debug" }).level).toBe("debug");
  });

  it("lets WHATROUTER_LOG_LEVEL win over the config", () => {
    process.env["WHATROUTER_LOG_LEVEL"] = "warn";
    expect(createLogger({ level: "debug" }).level).toBe("warn");
  });
});
