import { Effect, Option, Path } from "effect";
import { describe, expect, it } from "vitest";

import type { CliConfigSources } from "./cli-config-key.ts";
import { CliConfigValueError } from "./cli-config.errors.ts";
import { runCliConfigRegistryPass } from "./cli-config-registry-pass.ts";

const pathService = Effect.runSync(Effect.provide(Path.Path, Path.layer));

const sourcesFor = (config: Readonly<Record<string, unknown>>): CliConfigSources => ({
  flags: () => ({ flag: "--db-port", value: 1 }),
  shell: () => "9999",
  projectEnv: () => ({ value: "9998" }),
  config: (segments) => {
    const key = segments.join(".");
    return key in config
      ? { value: config[key], origin: { path: segments, source: "local" } }
      : undefined;
  },
  dotenvPrivateKeys: [],
  context: {
    workdir: "/work/app",
    projectRef: Option.none(),
    path: pathService,
    configAt: (key) => config[key],
  },
});

describe("runCliConfigRegistryPass with configOnly", () => {
  it("coerces a string port from the file and ignores flag and env values", () => {
    const result = runCliConfigRegistryPass(
      { db: { port: "54322" } },
      sourcesFor({ "db.port": "54322" }),
      {
        configOnly: true,
      },
    );

    expect(result.failures).toEqual([]);
    expect(result.declared).toMatchObject({ db: { port: 54322 } });
    expect(result.origins.get("db.port")?.tier).toBe("config");
  });

  it("reports a non-numeric port as a CliConfigValueError with its segments", () => {
    const result = runCliConfigRegistryPass(
      { db: { port: "abc" } },
      sourcesFor({ "db.port": "abc" }),
      {
        configOnly: true,
      },
    );

    const [failure] = result.failures;
    expect(failure).toBeInstanceOf(CliConfigValueError);
    expect(failure?.segments).toEqual(["db", "port"]);
    expect(failure?.expected).toBeDefined();
    expect(failure?.kind).toBeDefined();
  });
});
