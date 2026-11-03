import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { CliConfigRemovedKeyError } from "@supabase/config";
import { Effect, Option, Schema } from "effect";

import { withConfigEnv } from "../../tests/helpers/command-mocks.ts";
import { definedEnv } from "../../tests/helpers/config-env-pins.ts";
import { configValuesLayer } from "../../tests/helpers/config-values-layer.ts";
import { createStackConfigProject } from "../../tests/helpers/stack-config.ts";
import { cliConfigFailureKey } from "./cli-config-failure-key.ts";
import { CliConfigValueError } from "./cli-config.errors.ts";
import { CliConfigValues } from "./cli-config-values.service.ts";

const SECRET = "sk_live_4eC39Hq";

const REMOTE_REF = "abcdefghijklmnopqrst";

const loadFailure = (config: string) =>
  Effect.gen(function* () {
    const workdir = yield* createStackConfigProject(config, {
      prefix: "supabase-config-failure-key-",
    });
    return yield* CliConfigValues.use((values) =>
      values.load({ workdir, projectRef: Option.none() }),
    ).pipe(Effect.provide(configValuesLayer()), Effect.flip);
  }).pipe(
    Effect.provide(BunServices.layer),
    (effect) => withConfigEnv(definedEnv({}), effect),
    Effect.scoped,
  );

const remoteDbPort = (remote: string) =>
  `[remotes."${remote}"]\nproject_id = "${REMOTE_REF}"\n[remotes."${remote}".db]\nport = "x"\n`;

describe("cliConfigFailureKey for a removed key", () => {
  it.live.each([
    {
      name: "the [inbucket] table",
      config: "[inbucket]\nenabled = true\n",
      key: "inbucket",
    },
    {
      name: "experimental.orioledb_version",
      config: '[experimental]\norioledb_version = "15.1.0.150"\n',
      key: "experimental.orioledb_version",
    },
    {
      name: "the linkedin provider",
      config: "[auth.external.linkedin]\nenabled = true\n",
      key: "auth.external.linkedin",
    },
    {
      name: "the slack provider",
      config: "[auth.external.slack]\nenabled = true\n",
      key: "auth.external.slack",
    },
    {
      name: "a remote block whose name contains dots and a secret",
      config: `[remotes."prod.${SECRET}.example.com".inbucket]\nenabled = true\n`,
      key: "inbucket",
    },
    {
      name: "a removed provider in a remote block",
      config: "[remotes.staging.auth.external.slack]\nenabled = true\n",
      key: "auth.external.slack",
    },
    {
      name: "several keys, joined sorted without repeats",
      config: [
        "[inbucket]",
        "enabled = true",
        "[experimental]",
        'orioledb_version = "15.1.0.150"',
        "[auth.external.slack]",
        "enabled = true",
        "[remotes.staging.inbucket]",
        "enabled = true",
      ].join("\n"),
      key: "auth.external.slack,experimental.orioledb_version,inbucket",
    },
  ])("names $name", ({ config, key }) =>
    Effect.gen(function* () {
      const error = yield* loadFailure(config);

      expect(error._tag).toBe("CliConfigRemovedKeyError");
      expect(cliConfigFailureKey(error)).toBe(key);
    }),
  );

  it("drops removed keys outside the source-owned vocabulary", () => {
    const removedKeys = (...keys: ReadonlyArray<string>) =>
      new CliConfigRemovedKeyError({
        path: "supabase/config.toml",
        format: "toml",
        removedKeys: keys.map((key) => ({ key, replacement: "[replacement]" })),
      });

    expect(cliConfigFailureKey(removedKeys(`[${SECRET}]`, "[inbucket]"))).toBe("inbucket");
    expect(cliConfigFailureKey(removedKeys(`[${SECRET}]`))).toBeUndefined();
  });
});

describe("cliConfigFailureKey for an invalid value", () => {
  it.live.each([
    {
      name: "a registry key",
      config: "[db]\nport = 70000\n",
      key: "db.port",
    },
    {
      name: "a provider the source names",
      config: "[auth.external.github]\nclient_id = 5\n",
      key: "auth.external.github.client_id",
    },
    {
      name: "a user-chosen provider name, collapsed to its family",
      config: "[auth.external.my_provider]\nclient_id = 5\n",
      key: "auth.external",
    },
    {
      name: "a user-chosen provider name containing dots and a secret",
      config: `[auth.external."corp.${SECRET}.sso"]\nclient_id = 5\n`,
      key: "auth.external",
    },
  ])("names $name", ({ config, key }) =>
    Effect.gen(function* () {
      const error = yield* loadFailure(config);

      expect(error._tag).toBe("CliConfigValueError");
      expect(cliConfigFailureKey(error)).toBe(key);
    }),
  );

  it("names nothing for a path outside the source-owned vocabulary", () => {
    const error = new CliConfigValueError({
      path: `vendor_tables.${SECRET}.password`,
      tier: "config",
      message: "invalid",
    });

    expect(cliConfigFailureKey(error)).toBeUndefined();
  });
});

describe("cliConfigFailureKey for a config document that does not decode", () => {
  it.live.each([
    {
      name: "a section table written as an array",
      config: "[[auth.hook.custom_access_token]]\n",
      key: "auth.hook.custom_access_token",
    },
    {
      name: "a user-named bucket, collapsed to its section",
      config: `[storage.buckets."${SECRET}.assets"]\npublic = "yes"\n`,
      key: "storage",
    },
    {
      name: "a user-named function, collapsed to functions",
      config: '[functions.my-fn]\nverify_jwt = "x"\n',
      key: "functions",
    },
    {
      name: "a key inside a remote block",
      config: remoteDbPort("staging"),
      key: "db.port",
    },
    {
      name: "a key inside a remote named after a config section",
      config: remoteDbPort("auth"),
      key: "db.port",
    },
  ])("names $name", ({ config, key }) =>
    Effect.gen(function* () {
      const error = yield* loadFailure(config);

      expect(error._tag).toBe("CliConfigParseError");
      expect(Schema.isSchemaError("cause" in error ? error.cause : undefined)).toBe(true);
      expect(cliConfigFailureKey(error)).toBe(key);
    }),
  );

  it.live("names the key without the dotted, secret-looking remote name", () =>
    Effect.gen(function* () {
      const error = yield* loadFailure(remoteDbPort(`prod.${SECRET}.example.com`));

      expect(error._tag).toBe("CliConfigParseError");
      expect(Schema.isSchemaError("cause" in error ? error.cause : undefined)).toBe(true);
      const key = cliConfigFailureKey(error);
      expect(key).toBe("db.port");
      expect(key).not.toContain(SECRET);
    }),
  );

  it.live("names nothing for a TOML syntax error", () =>
    Effect.gen(function* () {
      const error = yield* loadFailure("[db\nport = ");

      expect(error._tag).toBe("CliConfigParseError");
      expect(Schema.isSchemaError("cause" in error ? error.cause : undefined)).toBe(false);
      expect(cliConfigFailureKey(error)).toBeUndefined();
    }),
  );
});

describe("cliConfigFailureKey for a failure unrelated to config", () => {
  it.each([
    { name: "a plain Error", failure: new Error("db.port is invalid") },
    { name: "a string", failure: "db.port" },
    { name: "undefined", failure: undefined },
    { name: "a lookalike with another tag", failure: { _tag: "SomeOtherError", path: "db.port" } },
  ])("names nothing for $name", ({ failure }) => {
    expect(cliConfigFailureKey(failure)).toBeUndefined();
  });
});
