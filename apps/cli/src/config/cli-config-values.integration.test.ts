import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import type { CliConfig } from "@supabase/config";
import { loadCliConfig } from "@supabase/config/internal";
import { Effect, Exit, FileSystem, Layer, Option, Path } from "effect";

import { withConfigEnv } from "../../tests/helpers/command-mocks.ts";
import { definedEnv } from "../../tests/helpers/config-env-pins.ts";
import {
  cliConfigValuesTestLayer,
  configValuesLayer,
  flagInput,
} from "../../tests/helpers/config-snapshot-layer.ts";
import { mockOutput } from "../../tests/helpers/mocks.ts";
import { createStackConfigProject } from "../../tests/helpers/stack-config.ts";
import { loadStackConfig } from "../command-internal/stack-config.ts";
import { DebugLogger } from "../shared/output/debug-logger.service.ts";
import { runtimeInfoLayer } from "../shared/runtime/runtime-info.layer.ts";
import type { CliConfigFlagAssignment } from "./cli-config-flags.ts";
import { CLI_CONFIG_FAMILIES, type CliConfigFamilyId } from "./cli-config-key-annotations.ts";
import {
  CliConfigKeys,
  cliConfigDocumentOnlyPaths,
  cliConfigFamilyKey,
  cliConfigRegistry,
} from "./cli-config-keys.ts";
import { CliConfigValues } from "./cli-config-values.service.ts";

const LINKED = "abcdefghijklmnopqrst";
const OTHER = "tsrqponmlkjihgfedcba";

const familyKey = (id: CliConfigFamilyId, name: string, field: string) => {
  const family = CLI_CONFIG_FAMILIES.find((candidate) => candidate.id === id);
  const key = family === undefined ? undefined : cliConfigFamilyKey(family, name, field);
  if (key === undefined) throw new Error(`no ${id} family key for ${field}`);
  return key;
};

const withShell = <A, E, R>(
  shell: Readonly<Record<string, string | undefined>>,
  body: Effect.Effect<A, E, R>,
) => withConfigEnv(definedEnv(shell), body);

const link = (root: string, ref: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.join(root, "supabase", ".temp"), { recursive: true });
    yield* fs.writeFileString(path.join(root, "supabase", ".temp", "project-ref"), ref);
  });

const project = (config: string, options: { readonly supabaseEnv?: string } = {}) =>
  createStackConfigProject(config, { prefix: "supabase-cli-config-values-", ...options });

describe("CliConfigValues credential scoping", () => {
  const scenarios: ReadonlyArray<{
    readonly name: string;
    readonly linkedTo: string | undefined;
    readonly target: Option.Option<string>;
    readonly withheld: boolean;
  }> = [
    {
      name: "a target that matches the linked project",
      linkedTo: LINKED,
      target: Option.some(LINKED),
      withheld: false,
    },
    {
      name: "a target other than the linked project",
      linkedTo: LINKED,
      target: Option.some(OTHER),
      withheld: true,
    },
    {
      name: "a target in an unlinked workdir",
      linkedTo: undefined,
      target: Option.some(OTHER),
      withheld: false,
    },
    { name: "no target", linkedTo: LINKED, target: Option.none(), withheld: false },
  ];

  for (const scenario of scenarios) {
    it.live(
      `${scenario.withheld ? "withholds" : "offers"} SUPABASE_DB_PASSWORD for ${scenario.name}`,
      () =>
        Effect.gen(function* () {
          const root = yield* project('project_id = "scoped"\n', {
            supabaseEnv: "SUPABASE_DB_PASSWORD=from-file\n",
          });
          if (scenario.linkedTo !== undefined) yield* link(root, scenario.linkedTo);
          const layer = configValuesLayer();

          const snapshot = yield* CliConfigValues.use((values) =>
            values.load({ workdir: root, projectRef: scenario.target }),
          ).pipe(Effect.provide(layer));
          const password = yield* snapshot.get(CliConfigKeys.linkedDb.password);

          if (scenario.withheld) {
            expect(password.value).toEqual(Option.none());
            expect(snapshot.withheldEnv).toEqual([
              {
                path: "linkedDb.password",
                envName: "SUPABASE_DB_PASSWORD",
                tier: "shell",
                targetRef: Option.getOrElse(scenario.target, () => ""),
                linkedRef: LINKED,
              },
            ]);
          } else {
            expect(password.value).toEqual(Option.some("from-shell"));
            expect(password.origin).toMatchObject({ tier: "shell" });
            expect(snapshot.withheldEnv).toEqual([]);
          }
        }).pipe(
          Effect.provide(BunServices.layer),
          (effect) => withShell({ SUPABASE_DB_PASSWORD: "from-shell" }, effect),
          Effect.scoped,
        ),
    );
  }

  it.live("reports a withheld project .env password when the shell does not set one", () =>
    Effect.gen(function* () {
      const root = yield* project('project_id = "scoped"\n', {
        supabaseEnv: "SUPABASE_DB_PASSWORD=from-file\n",
      });
      yield* link(root, LINKED);
      const layer = configValuesLayer();

      const snapshot = yield* CliConfigValues.use((values) =>
        values.load({ workdir: root, projectRef: Option.some(OTHER) }),
      ).pipe(Effect.provide(layer));

      expect(snapshot.withheldEnv).toMatchObject([
        { envName: "SUPABASE_DB_PASSWORD", tier: "projectEnv" },
      ]);
    }).pipe(
      Effect.provide(BunServices.layer),
      (effect) => withShell({ SUPABASE_DB_PASSWORD: undefined }, effect),
      Effect.scoped,
    ),
  );

  it.live("keeps an explicit --password on a foreign project", () =>
    Effect.gen(function* () {
      const root = yield* project('project_id = "scoped"\n');
      yield* link(root, LINKED);
      const layer = configValuesLayer({
        flags: [flagInput("linkedDb.password", "password", "explicit")],
      });

      const snapshot = yield* CliConfigValues.use((values) =>
        values.load({ workdir: root, projectRef: Option.some(OTHER) }),
      ).pipe(Effect.provide(layer));
      const password = yield* snapshot.get(CliConfigKeys.linkedDb.password);

      expect(password).toMatchObject({ value: Option.some("explicit"), origin: { tier: "flag" } });
    }).pipe(
      Effect.provide(BunServices.layer),
      (effect) => withShell({ SUPABASE_DB_PASSWORD: "from-shell" }, effect),
      Effect.scoped,
    ),
  );

  it.live("keeps config secrets env-sourced on a foreign project", () =>
    Effect.gen(function* () {
      const root = yield* project(
        'project_id = "scoped"\n[auth.captcha]\nenabled = true\nprovider = "hcaptcha"\nsecret = "from-config"\n',
      );
      yield* link(root, LINKED);
      const layer = configValuesLayer();

      const snapshot = yield* CliConfigValues.use((values) =>
        values.load({ workdir: root, projectRef: Option.some(OTHER) }),
      ).pipe(Effect.provide(layer));
      const secret = yield* snapshot.get(CliConfigKeys.auth.captcha.secret);

      expect(secret).toMatchObject({
        value: Option.some("from-shell"),
        origin: { tier: "shell", envName: "SUPABASE_AUTH_CAPTCHA_SECRET" },
      });
    }).pipe(
      Effect.provide(BunServices.layer),
      (effect) => withShell({ SUPABASE_AUTH_CAPTCHA_SECRET: "from-shell" }, effect),
      Effect.scoped,
    ),
  );
});

describe("CliConfigValues remotes", () => {
  const remoteConfig = `project_id = "base"
[db]
port = 54399

[remotes.staging]
project_id = "${LINKED}"

[remotes.staging.db]
major_version = 15
`;

  it.live("merges the matching remote and keeps its implicit seed default in the config tier", () =>
    Effect.gen(function* () {
      const root = yield* project(remoteConfig);
      const layer = configValuesLayer();

      const snapshot = yield* CliConfigValues.use((values) =>
        values.load({ workdir: root, projectRef: Option.some(LINKED) }),
      ).pipe(Effect.provide(layer));

      expect(snapshot.appliedRemote).toEqual(Option.some("staging"));
      expect((yield* snapshot.get(CliConfigKeys.db.majorVersion)).origin).toMatchObject({
        tier: "config",
        remote: "staging",
        origin: { source: "remote" },
      });
      expect(yield* snapshot.get(CliConfigKeys.db.seed.enabled)).toMatchObject({
        value: false,
        origin: { tier: "config", remote: "staging" },
      });
      expect((yield* snapshot.get(CliConfigKeys.db.port)).origin).toMatchObject({
        tier: "config",
        origin: { source: "local" },
      });
    }).pipe(Effect.provide(BunServices.layer), (effect) => withShell({}, effect), Effect.scoped),
  );

  it.live("lets env and flags beat the matched remote, including its seed default", () =>
    Effect.gen(function* () {
      const root = yield* project(remoteConfig);
      const layer = configValuesLayer({
        flags: [flagInput("db.seed.enabled", "include-seed", true)],
      });

      const snapshot = yield* CliConfigValues.use((values) =>
        values.load({ workdir: root, projectRef: Option.some(LINKED) }),
      ).pipe(Effect.provide(layer));

      expect(yield* snapshot.get(CliConfigKeys.db.majorVersion)).toMatchObject({
        value: 17,
        origin: { tier: "shell" },
      });
      expect(yield* snapshot.get(CliConfigKeys.db.seed.enabled)).toMatchObject({
        value: true,
        origin: { tier: "flag", flag: "include-seed" },
      });
    }).pipe(
      Effect.provide(BunServices.layer),
      (effect) => withShell({ SUPABASE_DB_MAJOR_VERSION: "17" }, effect),
      Effect.scoped,
    ),
  );

  it.live("warns once for each env value that beats a value the matched remote declares", () =>
    Effect.gen(function* () {
      const root = yield* project(remoteConfig);
      const output = mockOutput();
      const layer = configValuesLayer({ output: output.layer });

      yield* CliConfigValues.use((values) =>
        values.load({ workdir: root, projectRef: Option.some(LINKED) }),
      ).pipe(Effect.provide(layer));

      expect(output.messages).toEqual([
        {
          type: "warn",
          message:
            "SUPABASE_DB_MAJOR_VERSION overrides db.major_version, which [remotes.staging] declares.",
        },
      ]);
    }).pipe(
      Effect.provide(BunServices.layer),
      (effect) => withShell({ SUPABASE_DB_MAJOR_VERSION: "17", SUPABASE_DB_PORT: "54400" }, effect),
      Effect.scoped,
    ),
  );

  it.live("logs where each non-default value came from under --debug", () =>
    Effect.gen(function* () {
      const root = yield* project(remoteConfig);
      const lines: Array<string> = [];
      const debugLogger = Layer.succeed(DebugLogger, {
        debug: (message) => Effect.sync(() => void lines.push(message)),
        http: () => Effect.void,
      });
      const layer = configValuesLayer({ debugLogger });

      yield* CliConfigValues.use((values) =>
        values.load({ workdir: root, projectRef: Option.some(LINKED) }),
      ).pipe(Effect.provide(layer));

      expect(lines).toContainEqual(expect.stringContaining("config: db.major_version from"));
      expect(lines).toContainEqual(expect.stringContaining("SUPABASE_DB_PORT"));
      expect(lines.some((line) => line.startsWith("config: api.port"))).toBe(false);
    }).pipe(
      Effect.provide(BunServices.layer),
      (effect) => withShell({ SUPABASE_DB_PORT: "54400" }, effect),
      Effect.scoped,
    ),
  );

  it.live("selects the remote named by SUPABASE_REMOTES_<NAME>_PROJECT_ID", () =>
    Effect.gen(function* () {
      const root = yield* project(remoteConfig);
      const layer = configValuesLayer();

      const snapshot = yield* CliConfigValues.use((values) =>
        values.load({ workdir: root, projectRef: Option.some(OTHER) }),
      ).pipe(Effect.provide(layer));

      expect(snapshot.appliedRemote).toEqual(Option.some("staging"));
    }).pipe(
      Effect.provide(BunServices.layer),
      (effect) => withShell({ SUPABASE_REMOTES_STAGING_PROJECT_ID: OTHER }, effect),
      Effect.scoped,
    ),
  );

  it.live("applies no remote when the ref matches none", () =>
    Effect.gen(function* () {
      const root = yield* project(remoteConfig);
      const layer = configValuesLayer();

      const snapshot = yield* CliConfigValues.use((values) =>
        values.load({ workdir: root, projectRef: Option.some(OTHER) }),
      ).pipe(Effect.provide(layer));

      expect(snapshot.appliedRemote).toEqual(Option.none());
      expect((yield* snapshot.get(CliConfigKeys.db.seed.enabled)).origin).toEqual({
        tier: "default",
      });
    }).pipe(Effect.provide(BunServices.layer), (effect) => withShell({}, effect), Effect.scoped),
  );

  it.live("fails the load on duplicate or malformed remote project ids", () =>
    Effect.gen(function* () {
      const duplicate = yield* project(
        `[remotes.a]\nproject_id = "${LINKED}"\n[remotes.b]\nproject_id = "${LINKED}"\n`,
      );
      const malformed = yield* project('[remotes.a]\nproject_id = "short"\n');
      const layer = configValuesLayer();
      const load = (root: string) =>
        CliConfigValues.use((values) =>
          values.load({ workdir: root, projectRef: Option.none() }),
        ).pipe(Effect.flip, Effect.provide(layer));

      expect((yield* load(duplicate)).message).toBe(
        "duplicate project_id for [remotes.b] and [remotes.a]",
      );
      expect((yield* load(malformed)).message).toBe(
        "Invalid config for remotes.a.project_id. Must be like: abcdefghijklmnopqrst",
      );
    }).pipe(Effect.provide(BunServices.layer), (effect) => withShell({}, effect), Effect.scoped),
  );
});

describe("CliConfigValues snapshots", () => {
  it.live("memoises a load per target and drops the memo after a write", () =>
    Effect.gen(function* () {
      const root = yield* project("[db]\nport = 54399\n");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const layer = configValuesLayer();

      yield* Effect.gen(function* () {
        const values = yield* CliConfigValues;
        const target = { workdir: root, projectRef: Option.none<string>() };
        const first = yield* values.load(target);
        const again = yield* values.load(target);
        const other = yield* values.load({ ...target, projectRef: Option.some(LINKED) });

        expect(again).toBe(first);
        expect(other).not.toBe(first);

        yield* values.writeThrough(
          fs.writeFileString(path.join(root, "supabase", "config.toml"), "[db]\nport = 54400\n"),
        );
        const reloaded = yield* values.load(target);

        expect(reloaded).not.toBe(first);
        expect((yield* reloaded.get(CliConfigKeys.db.port)).value).toBe(54400);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(BunServices.layer), (effect) => withShell({}, effect), Effect.scoped),
  );

  it.live("warns once per load when a deprecated alias supplies the value", () =>
    Effect.gen(function* () {
      const root = yield* project('project_id = "alias"\n');
      const output = mockOutput();
      const layer = configValuesLayer({ output: output.layer });

      yield* Effect.gen(function* () {
        const values = yield* CliConfigValues;
        const snapshot = yield* values.load({ workdir: root, projectRef: Option.none() });
        const first = yield* snapshot.get(CliConfigKeys.experimental.pgdelta.enabled);
        yield* snapshot.get(CliConfigKeys.experimental.pgdelta.enabled);

        expect(first.value).toBe(true);
      }).pipe(Effect.provide(layer));

      expect(output.messages).toEqual([
        {
          type: "warn",
          message:
            "SUPABASE_EXPERIMENTAL_PG_DELTA is deprecated. Please use SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED instead. It now overrides config.toml, so false turns pg-delta off.",
        },
      ]);
    }).pipe(
      Effect.provide(BunServices.layer),
      (effect) => withShell({ SUPABASE_EXPERIMENTAL_PG_DELTA: "true" }, effect),
      Effect.scoped,
    ),
  );

  it.live("fails the load with the env name, tier and key when an override does not decode", () =>
    Effect.gen(function* () {
      const root = yield* project('project_id = "bad"\n');
      const layer = configValuesLayer();

      const error = yield* CliConfigValues.use((values) =>
        values.load({ workdir: root, projectRef: Option.none() }),
      ).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toMatchObject({
        _tag: "CliConfigValueError",
        path: "api.port",
        tier: "shell",
        envName: "SUPABASE_API_PORT",
      });
      expect(error.message).toBe(
        'Invalid SUPABASE_API_PORT="not-a-port" (sets api.port): expected a port (0-65535).',
      );
    }).pipe(
      Effect.provide(BunServices.layer),
      (effect) => withShell({ SUPABASE_API_PORT: "not-a-port" }, effect),
      Effect.scoped,
    ),
  );

  it.live("names the flag when a flag value does not decode", () =>
    Effect.gen(function* () {
      const root = yield* project('project_id = "bad"\n');
      const layer = configValuesLayer({ flags: [flagInput("api.port", "port", 70000)] });

      const error = yield* CliConfigValues.use((values) =>
        values.load({ workdir: root, projectRef: Option.none() }),
      ).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toMatchObject({ path: "api.port", tier: "flag", flag: "port" });
    }).pipe(Effect.provide(BunServices.layer), (effect) => withShell({}, effect), Effect.scoped),
  );

  it.live("fails the first load when two flags set one key to different values", () =>
    Effect.gen(function* () {
      const root = yield* project('project_id = "bad"\n');
      const layer = configValuesLayer({
        flags: [
          flagInput("db.seed.enabled", "no-seed", false),
          flagInput("db.seed.enabled", "sql-paths", true),
        ],
      });

      const error = yield* CliConfigValues.use((values) =>
        values.load({ workdir: root, projectRef: Option.none() }),
      ).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toMatchObject({
        _tag: "CliConfigFlagConflictError",
        path: "db.seed.enabled",
        flags: ["no-seed", "sql-paths"],
        message: "--no-seed and --sql-paths both set db.seed.enabled; pass only one",
      });
    }).pipe(Effect.provide(BunServices.layer), (effect) => withShell({}, effect), Effect.scoped),
  );

  it.live("loads when two flags set one key to the same value", () =>
    Effect.gen(function* () {
      const root = yield* project('project_id = "ok"\n');
      const layer = configValuesLayer({
        flags: [
          flagInput("db.seed.enabled", "include-seed", true),
          flagInput("db.seed.enabled", "sql-paths", true),
        ],
      });

      const snapshot = yield* CliConfigValues.use((values) =>
        values.load({ workdir: root, projectRef: Option.none() }),
      ).pipe(Effect.provide(layer));

      expect((yield* snapshot.get(CliConfigKeys.db.seed.enabled)).value).toBe(true);
    }).pipe(Effect.provide(BunServices.layer), (effect) => withShell({}, effect), Effect.scoped),
  );

  it.live("keeps package errors visible by their own tag", () =>
    Effect.gen(function* () {
      const root = yield* project("[db\nport = ");
      const layer = configValuesLayer();

      const error = yield* CliConfigValues.use((values) =>
        values.load({ workdir: root, projectRef: Option.none() }),
      ).pipe(Effect.provide(layer), Effect.flip);

      expect(error._tag).toBe("CliConfigParseError");
    }).pipe(Effect.provide(BunServices.layer), (effect) => withShell({}, effect), Effect.scoped),
  );

  it.live("fails the load when a config value does not decode", () =>
    Effect.gen(function* () {
      const root = yield* project("[db]\nport = 70000\n");
      const layer = configValuesLayer();

      const error = yield* CliConfigValues.use((values) =>
        values.load({ workdir: root, projectRef: Option.none() }),
      ).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toMatchObject({ path: "db.port", tier: "config" });
    }).pipe(Effect.provide(BunServices.layer), (effect) => withShell({}, effect), Effect.scoped),
  );
});

describe("CliConfigValues secrets", () => {
  const CIPHERTEXT =
    "encrypted:BKiXH15AyRzeohGyUrmB6cGjSklCrrBjdesQlX1VcXo/Xp20Bi2gGZ3AlIqxPQDmjVAALnhZamKnuY73l8Dz1P+BYiZUgxTSLzdCvdYUyVbNekj2UudbdUizBViERtZkuQwZHIv/";
  const PRIVATE_KEY = "7fd7210cef8f331ee8c55897996aaaafd853a2b20a4dc73d6d75759f65d2a7eb";
  const captcha = (secret: string) =>
    `project_id = "secrets"\n[auth.captcha]\nenabled = true\nprovider = "hcaptcha"\nsecret = "${secret}"\n`;

  const readCaptcha = (root: string) =>
    Effect.gen(function* () {
      const layer = configValuesLayer();
      const snapshot = yield* CliConfigValues.use((values) =>
        values.load({ workdir: root, projectRef: Option.none() }),
      ).pipe(Effect.provide(layer));
      return {
        got: yield* snapshot.get(CliConfigKeys.auth.captcha.secret),
        decoded: snapshot.materialized.config.auth.captcha?.secret,
      };
    });

  it.live("writes a decrypted config secret into the materialized config and the read", () =>
    Effect.gen(function* () {
      const root = yield* project(captcha(CIPHERTEXT));

      const { got, decoded } = yield* readCaptcha(root);

      expect(got).toMatchObject({ value: Option.some("value"), origin: { tier: "config" } });
      expect(decoded).toBe("value");
    }).pipe(
      Effect.provide(BunServices.layer),
      (effect) => withShell({ DOTENV_PRIVATE_KEY: PRIVATE_KEY }, effect),
      Effect.scoped,
    ),
  );

  it.live("decrypts ciphertext reached through an env() reference", () =>
    Effect.gen(function* () {
      const root = yield* project(captcha("env(CAPTCHA_CIPHERTEXT)"), {
        supabaseEnv: `CAPTCHA_CIPHERTEXT=${CIPHERTEXT}\n`,
      });

      const { got, decoded } = yield* readCaptcha(root);

      expect(got.value).toEqual(Option.some("value"));
      expect(decoded).toBe("value");
    }).pipe(
      Effect.provide(BunServices.layer),
      (effect) => withShell({ DOTENV_PRIVATE_KEY: PRIVATE_KEY }, effect),
      Effect.scoped,
    ),
  );

  it.live("fails the load instead of passing ciphertext through when decryption fails", () =>
    Effect.gen(function* () {
      const root = yield* project(captcha(CIPHERTEXT));
      const layer = configValuesLayer();

      const error = yield* CliConfigValues.use((values) =>
        values.load({ workdir: root, projectRef: Option.none() }),
      ).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toMatchObject({ path: "auth.captcha.secret", tier: "config" });
      expect(error.message).toBe("failed to parse config: missing private key");
    }).pipe(Effect.provide(BunServices.layer), (effect) => withShell({}, effect), Effect.scoped),
  );

  it.live("keeps a withheld env value out of env() interpolation", () =>
    Effect.gen(function* () {
      const root = yield* project(
        'project_id = "scoped"\n[auth]\nsite_url = "env(SUPABASE_DB_PASSWORD)"\n',
      );
      yield* link(root, LINKED);
      const layer = configValuesLayer();
      const siteUrl = (ref: string) =>
        CliConfigValues.use((values) =>
          values.load({ workdir: root, projectRef: Option.some(ref) }),
        ).pipe(
          Effect.provide(layer),
          Effect.map((snapshot) => snapshot.materialized.config.auth.site_url),
        );

      expect(yield* siteUrl(LINKED)).toBe("from-shell");
      expect(yield* siteUrl(OTHER)).toBe("env(SUPABASE_DB_PASSWORD)");
    }).pipe(
      Effect.provide(BunServices.layer),
      (effect) => withShell({ SUPABASE_DB_PASSWORD: "from-shell" }, effect),
      Effect.scoped,
    ),
  );
});

describe("CliConfigValues reads", () => {
  it.live("normalizes default-tier values with and without a config file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const empty = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-cli-config-empty-" });
      const configured = yield* project('project_id = "seeded"\n');
      const layer = configValuesLayer();
      const read = (workdir: string) =>
        CliConfigValues.use((values) =>
          Effect.flatMap(values.load({ workdir, projectRef: Option.none() }), (snapshot) =>
            snapshot.get(CliConfigKeys.db.seed.sqlPaths),
          ),
        ).pipe(Effect.provide(layer));

      expect((yield* read(empty)).value).toEqual(["supabase/seed.sql"]);
      expect((yield* read(configured)).value).toEqual(["supabase/seed.sql"]);
      expect((yield* read(configured)).origin).toEqual({ tier: "default" });
    }).pipe(Effect.provide(BunServices.layer), (effect) => withShell({}, effect), Effect.scoped),
  );

  it.live("keeps the unnormalized value beside a normalized config value", () =>
    Effect.gen(function* () {
      const root = yield* project('project_id = "seeded"\n[db.seed]\nsql_paths = ["./a.sql"]\n');
      const layer = configValuesLayer();

      const read = yield* CliConfigValues.use((values) =>
        Effect.flatMap(values.load({ workdir: root, projectRef: Option.none() }), (snapshot) =>
          snapshot.get(CliConfigKeys.db.seed.sqlPaths),
        ),
      ).pipe(Effect.provide(layer));

      expect(read).toMatchObject({
        value: ["supabase/a.sql"],
        unnormalized: ["./a.sql"],
        origin: { tier: "config" },
      });
    }).pipe(Effect.provide(BunServices.layer), (effect) => withShell({}, effect), Effect.scoped),
  );

  it.live("defaults project_id from the workdir name, never the target ref", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-cli-config-" });
      const root = path.join(parent, "My Project");
      yield* fs.makeDirectory(path.join(root, "supabase"), { recursive: true });
      yield* fs.writeFileString(path.join(root, "supabase", "config.toml"), "[db]\nport = 54399\n");
      const layer = configValuesLayer();

      const read = yield* CliConfigValues.use((values) =>
        Effect.flatMap(
          values.load({ workdir: root, projectRef: Option.some(LINKED) }),
          (snapshot) => snapshot.get(CliConfigKeys.projectId),
        ),
      ).pipe(Effect.provide(layer));

      expect(read.value).toBe("My_Project");
    }).pipe(Effect.provide(BunServices.layer), (effect) => withShell({}, effect), Effect.scoped),
  );

  it.live("coerces weakly typed config values into the decoded config and an env() bool", () =>
    Effect.gen(function* () {
      const root = yield* project(
        'project_id = "weak"\n[db.seed]\nenabled = "TRUE"\nsql_paths = "a.sql,b.sql"\n[db.pooler]\nenabled = "env(POOLER_ON)"\n',
      );
      const layer = configValuesLayer();

      const snapshot = yield* CliConfigValues.use((values) =>
        values.load({ workdir: root, projectRef: Option.none() }),
      ).pipe(Effect.provide(layer));

      expect(snapshot.materialized.config.db.seed.enabled).toBe(true);
      expect(snapshot.materialized.config.db.seed.sql_paths).toEqual([
        "supabase/a.sql",
        "supabase/b.sql",
      ]);
      expect((yield* snapshot.get(CliConfigKeys.db.seed.enabled)).value).toBe(true);
      expect((yield* snapshot.get(CliConfigKeys.db.pooler.enabled)).value).toBe(true);
    }).pipe(
      Effect.provide(BunServices.layer),
      (effect) => withShell({ POOLER_ON: "true" }, effect),
      Effect.scoped,
    ),
  );

  it.live("sanitizes project_id once, whichever tier supplies it", () =>
    Effect.gen(function* () {
      const root = yield* project('project_id = "my app"\n');
      const layer = configValuesLayer();
      const read = CliConfigValues.use((values) =>
        Effect.flatMap(values.load({ workdir: root, projectRef: Option.none() }), (snapshot) =>
          snapshot.get(CliConfigKeys.projectId),
        ),
      ).pipe(Effect.provide(layer));

      expect(yield* read).toMatchObject({ value: "my_app", origin: { tier: "config" } });
      const fromEnv = yield* withShell({ SUPABASE_PROJECT_ID: "other app" }, read);
      expect(fromEnv).toMatchObject({ value: "other_app", origin: { tier: "shell" } });
    }).pipe(Effect.provide(BunServices.layer), (effect) => withShell({}, effect), Effect.scoped),
  );

  it.live("reads the same value through get and the materialized config", () =>
    Effect.gen(function* () {
      const root = yield* project(
        'project_id = "agree"\n[api]\nport = 54399\n[auth.email.smtp]\nhost = "smtp.test"\nport = 587\nuser = "u"\npass = "p"\nadmin_email = "a@b.test"\n',
      );
      const layer = configValuesLayer();

      const snapshot = yield* CliConfigValues.use((values) =>
        values.load({ workdir: root, projectRef: Option.none() }),
      ).pipe(Effect.provide(layer));
      const { config } = snapshot.materialized;

      expect((yield* snapshot.get(CliConfigKeys.api.port)).value).toBe(config.api.port);
      expect((yield* snapshot.get(CliConfigKeys.db.port)).value).toBe(config.db.port);
      expect((yield* snapshot.get(CliConfigKeys.auth.email.smtp.host)).value).toEqual(
        Option.some(config.auth.email.smtp?.host),
      );
      expect((yield* snapshot.get(CliConfigKeys.auth.email.smtp.enabled)).value).toBe(
        config.auth.email.smtp?.enabled,
      );
      expect((yield* snapshot.get(CliConfigKeys.projectId)).value).toBe(config.project_id);
    }).pipe(Effect.provide(BunServices.layer), (effect) => withShell({}, effect), Effect.scoped),
  );

  it.live("resolves every registry key to the value the materialized config holds", () =>
    Effect.gen(function* () {
      const root = yield* project(
        'project_id = "parity"\n[api]\nport = 54399\n[db.seed]\nsql_paths = ["./a.sql"]\n[auth.email.smtp]\nhost = "smtp.test"\nport = 587\nuser = "u"\npass = "p"\nadmin_email = "a@b.test"\n[auth.hook.send_email]\nenabled = true\nuri = "pg-functions://postgres/public/send"\n',
      );
      const layer = configValuesLayer();

      const snapshot = yield* CliConfigValues.use((values) =>
        values.load({ workdir: root, projectRef: Option.none() }),
      ).pipe(Effect.provide(layer));

      const mismatches: Array<string> = [];
      let compared = 0;
      for (const key of cliConfigRegistry.keys) {
        if (key.document === false || cliConfigDocumentOnlyPaths.has(key.path)) continue;
        compared += 1;
        const resolved = key.toDocument((yield* snapshot.get(key)).value);
        const materialized = key.path
          .split(".")
          .reduce<unknown>(
            (node, segment) =>
              typeof node === "object" && node !== null ? Reflect.get(node, segment) : undefined,
            snapshot.materialized.config,
          );
        if (JSON.stringify(resolved) !== JSON.stringify(materialized)) mismatches.push(key.path);
      }

      expect(compared).toBeGreaterThan(100);
      expect(mismatches).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer), (effect) => withShell({}, effect), Effect.scoped),
  );

  it.live("lists family entries from the registry and the merged document", () =>
    Effect.gen(function* () {
      const root = yield* project(
        'project_id = "families"\n[auth.email.template.invite]\nsubject = "Join"\n',
      );
      const layer = configValuesLayer();

      const snapshot = yield* CliConfigValues.use((values) =>
        values.load({ workdir: root, projectRef: Option.none() }),
      ).pipe(Effect.provide(layer));

      expect(snapshot.familyNames("authEmailTemplate")).toEqual(["invite"]);
      expect(snapshot.familyNames("authExternal")).toContain("github");
      expect(snapshot.familyNames("authHook")).toContain("send_sms");
      expect(
        (yield* snapshot.get(familyKey("authEmailTemplate", "invite", "subject"))).value,
      ).toEqual(Option.some("Join"));
    }).pipe(Effect.provide(BunServices.layer), (effect) => withShell({}, effect), Effect.scoped),
  );

  it.live(
    "resolves env names with the shell before the project env file, omitting unset ones",
    () =>
      Effect.gen(function* () {
        const root = yield* project('project_id = "lookup"\n', {
          supabaseEnv: "SUPABASE_UNOWNED_FROM_FILE=file\nSUPABASE_API_PORT=1111\n",
        });
        const layer = configValuesLayer();

        const snapshot = yield* CliConfigValues.use((values) =>
          values.load({ workdir: root, projectRef: Option.none() }),
        ).pipe(Effect.provide(layer));

        expect(
          yield* snapshot.envValues([
            "SUPABASE_UNOWNED_FROM_SHELL",
            "SUPABASE_UNOWNED_FROM_FILE",
            "SUPABASE_UNOWNED_UNSET",
            "SUPABASE_API_PORT",
          ]),
        ).toEqual({
          SUPABASE_UNOWNED_FROM_SHELL: "shell",
          SUPABASE_UNOWNED_FROM_FILE: "file",
          SUPABASE_API_PORT: "2222",
        });
      }).pipe(
        Effect.provide(BunServices.layer),
        (effect) =>
          withShell({ SUPABASE_UNOWNED_FROM_SHELL: "shell", SUPABASE_API_PORT: "2222" }, effect),
        Effect.scoped,
      ),
  );
});

describe("CliConfigValues.materialized", () => {
  const richConfig = `project_id = "rich"

[api]
port = 54321
schemas = ["public"]
max_rows = 500

[db]
port = 54322
major_version = 15
health_timeout = "3m"

[db.pooler]
enabled = true
port = 54329

[db.settings]
max_connections = 50

[auth]
enable_signup = true
site_url = "http://localhost:3000"
jwt_expiry = 3600
minimum_password_length = 8

[auth.email.smtp]
host = "smtp.example.com"
port = 587
user = "mailer"
pass = "env(SMTP_PASS)"
admin_email = "admin@example.com"

[auth.captcha]
enabled = true
provider = "hcaptcha"
secret = "captcha-secret"

[auth.mfa.totp]
enroll_enabled = false

[auth.hook.custom_access_token]
enabled = true
uri = "pg-functions://postgres/public/custom_access_token_hook"

[auth.hook.send_sms]
enabled = true
uri = "https://sms.example.com/hook"
secrets = "env(SEND_SMS_SECRET)"

[auth.external.github]
enabled = true
client_id = "gh-client"
secret = "env(GITHUB_SECRET)"

[auth.email.notification.email_changed]
enabled = true
subject = "Email changed"

[storage]
file_size_limit = "50MiB"

[studio]
port = 54323

[realtime]
ip_version = "IPv4"

[edge_runtime]
policy = "per_worker"
`;

  const dotenv = [
    "SMTP_PASS=from-dotenv",
    "SEND_SMS_SECRET=v1,whsec_c2VuZC1zbXMtc2VjcmV0LWJhc2U2NA==",
    "GITHUB_SECRET=gh-secret",
    "SUPABASE_API_PORT=54421",
    "SUPABASE_API_SCHEMAS=public,extra",
    "SUPABASE_API_MAX_ROWS=0x20",
    "SUPABASE_DB_PORT=54422",
    "SUPABASE_DB_MAJOR_VERSION=17",
    "SUPABASE_DB_HEALTH_TIMEOUT=5m",
    "SUPABASE_DB_POOLER_ENABLED=false",
    "SUPABASE_DB_SETTINGS_MAX_CONNECTIONS=100",
    "SUPABASE_AUTH_ENABLE_SIGNUP=false",
    "SUPABASE_AUTH_SITE_URL=http://example.test",
    "SUPABASE_AUTH_JWT_EXPIRY=7200",
    "SUPABASE_AUTH_EMAIL_SMTP_HOST=smtp.override.test",
    "SUPABASE_AUTH_CAPTCHA_PROVIDER=turnstile",
    "SUPABASE_AUTH_CAPTCHA_SECRET=env-captcha-secret",
    "SUPABASE_AUTH_MFA_TOTP_ENROLL_ENABLED=true",
    "SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_URI=pg-functions://postgres/public/other_hook",
    "SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID=env-gh-client",
    "SUPABASE_AUTH_EMAIL_NOTIFICATION_EMAIL_CHANGED_SUBJECT=Changed by env",
    "SUPABASE_STORAGE_FILE_SIZE_LIMIT=100MiB",
    "SUPABASE_STUDIO_PORT=54523",
    "SUPABASE_REALTIME_IP_VERSION=IPv6",
    "SUPABASE_EDGE_RUNTIME_POLICY=oneshot",
  ].join("\n");

  const stackOverlay = (root: string, ref?: string) =>
    Effect.gen(function* () {
      return (yield* loadStackConfig(root, ref === undefined ? undefined : { projectRef: ref }))
        .source;
    }).pipe(
      Effect.provide(Layer.mergeAll(BunServices.layer, runtimeInfoLayer, cliConfigValuesTestLayer)),
    );

  const materialize = (
    root: string,
    options: {
      readonly ref?: string;
      readonly flags?: ReadonlyArray<CliConfigFlagAssignment>;
    } = {},
  ) => {
    const layer = configValuesLayer({ flags: options.flags });
    return CliConfigValues.use((values) =>
      values.load({
        workdir: root,
        projectRef: options.ref === undefined ? Option.none() : Option.some(options.ref),
      }),
    ).pipe(
      Effect.provide(layer),
      Effect.map((snapshot) => snapshot.materialized),
    );
  };

  const compareWithOverlay = (
    config: CliConfig,
    overlay: Effect.Success<ReturnType<typeof stackOverlay>>,
  ) => {
    expect(config.api).toEqual(overlay.api);
    expect(config.db).toEqual({
      ...overlay.db,
      seed: { ...overlay.db.seed, sql_paths: ["supabase/seed.sql"] },
    });
    expect(config.studio).toEqual(overlay.studio);
    expect(config.realtime).toEqual(overlay.realtime);
    expect(config.edge_runtime).toEqual(overlay.edge_runtime);
    expect(config.storage).toEqual(overlay.storage);
    expect(config.auth).toEqual(overlay.auth);
  };

  it.live("agrees with the stack config overlay, including secrets, families and hooks", () =>
    Effect.gen(function* () {
      const root = yield* project(richConfig, { supabaseEnv: `${dotenv}\n` });

      const overlay = yield* stackOverlay(root);
      const { config, originAt } = yield* materialize(root);

      compareWithOverlay(config, overlay);
      expect(config.auth.hook.custom_access_token).toMatchObject({
        enabled: true,
        uri: "pg-functions://postgres/public/other_hook",
      });
      expect(config.auth.hook.mfa_verification_attempt).toMatchObject({
        enabled: false,
        uri: "",
        secrets: "",
      });
      expect(config.auth.external["github"]).toMatchObject({
        client_id: "env-gh-client",
        secret: "gh-secret",
      });
      expect(config.auth.email.smtp?.pass).toBe("from-dotenv");
      expect(config.auth.captcha?.secret).toBe("env-captcha-secret");
      expect(originAt("api.port")).toMatchObject({
        tier: "projectEnv",
        envName: "SUPABASE_API_PORT",
      });
      expect(originAt("auth.email.smtp.port")).toMatchObject({ tier: "config" });
      expect(originAt("db.password")).toEqual({ tier: "default" });
    }).pipe(Effect.provide(BunServices.layer), (effect) => withShell({}, effect), Effect.scoped),
  );

  it.live("agrees with the stack config overlay for a matched remote and shell overrides", () =>
    Effect.gen(function* () {
      const root = yield* project(
        `${richConfig}
[remotes.staging]
project_id = "${LINKED}"

[remotes.staging.api]
schemas = ["public", "remote_api"]

[remotes.staging.auth]
site_url = "http://remote.example.com"
enable_signup = false

[remotes.staging.db]
major_version = 15
`,
        {
          supabaseEnv:
            "SMTP_PASS=from-dotenv\nSEND_SMS_SECRET=v1,whsec_c2VuZC1zbXMtc2VjcmV0LWJhc2U2NA==\nGITHUB_SECRET=gh\n",
        },
      );
      yield* link(root, LINKED);

      const overlay = yield* stackOverlay(root, LINKED);
      const { config, originAt } = yield* materialize(root, { ref: LINKED });

      compareWithOverlay(config, overlay);
      expect(config.api.schemas).toEqual(["public", "shell_api"]);
      expect(config.auth.site_url).toBe("http://remote.example.com");
      expect(originAt("auth.site_url")).toMatchObject({ tier: "config", remote: "staging" });
      expect(originAt("api.schemas")).toMatchObject({ tier: "shell" });
    }).pipe(
      Effect.provide(BunServices.layer),
      (effect) => withShell({ SUPABASE_API_SCHEMAS: "public,shell_api" }, effect),
      Effect.scoped,
    ),
  );

  it.live("lets flags beat every other tier and applies the key's normalizer once", () =>
    Effect.gen(function* () {
      const root = yield* project(richConfig, {
        supabaseEnv:
          "SMTP_PASS=p\nSEND_SMS_SECRET=v1,whsec_c2VuZC1zbXMtc2VjcmV0LWJhc2U2NA==\nGITHUB_SECRET=g\nSUPABASE_DB_SEED_ENABLED=false\n",
      });

      const { config, originAt } = yield* materialize(root, {
        flags: [
          flagInput("db.seed.enabled", "include-seed", true),
          flagInput("db.seed.sql_paths", "sql-paths", ["./flag.sql"]),
          flagInput("experimental.pgdelta.enabled", "use-pg-delta", true),
        ],
      });

      expect(config.db.seed.enabled).toBe(true);
      expect(config.db.seed.sql_paths).toEqual(["supabase/flag.sql"]);
      expect(config.experimental.pgdelta?.enabled).toBe(true);
      expect(originAt("db.seed.enabled")).toEqual({ tier: "flag", flag: "include-seed" });
    }).pipe(Effect.provide(BunServices.layer), (effect) => withShell({}, effect), Effect.scoped),
  );

  it.live("decodes defaults when the workdir has no config file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-cli-config-empty-" });

      const { config, originAt } = yield* materialize(root);

      expect(config.db.port).toBe(54322);
      expect(config.db.seed.sql_paths).toEqual(["supabase/seed.sql"]);
      expect(originAt("db.port")).toEqual({ tier: "default" });
    }).pipe(Effect.provide(BunServices.layer), (effect) => withShell({}, effect), Effect.scoped),
  );
});

describe("CliConfigValues loaded document", () => {
  const load = (
    root: string,
    target: Parameters<CliConfigValues["Service"]["load"]>[0]["projectRef"],
  ) => CliConfigValues.use((values) => values.load({ workdir: root, projectRef: target }));

  it.live("exposes the declared document without the defaults materialized for consumers", () =>
    Effect.gen(function* () {
      const root = yield* project('project_id = "declared"\n[api]\nmax_rows = 10\n');
      const layer = configValuesLayer();

      const snapshot = yield* load(root, Option.none()).pipe(Effect.provide(layer));
      const { loaded } = snapshot;

      expect(loaded.document).toEqual({ project_id: "declared", api: { max_rows: 10 } });
      expect(loaded.config.api.max_rows).toBe(10);
      expect(snapshot.materialized.config.auth.hook?.send_email?.uri).toBe("");
      expect(loaded.config.auth.hook?.send_email?.uri).toBeUndefined();
    }).pipe(Effect.provide(BunServices.layer), (effect) => withShell({}, effect), Effect.scoped),
  );

  it.live("matches the package loader when no flag or env overrides anything", () =>
    Effect.gen(function* () {
      const root = yield* project(
        '[db.seed]\nsql_paths = ["./a.sql", "./seeds/*.sql"]\n[auth.hook.send_email]\nenabled = true\nuri = "pg-functions://postgres/public/send"\n[api]\nmax_rows = 10\n',
      );
      const layer = configValuesLayer();

      const snapshot = yield* load(root, Option.none()).pipe(Effect.provide(layer));
      const packaged = yield* loadCliConfig(root, { goViperCompat: true });

      expect(packaged).not.toBeNull();
      expect(snapshot.loaded).toEqual(packaged);
      expect(snapshot.loaded.document).not.toHaveProperty("project_id");
    }).pipe(Effect.provide(BunServices.layer), (effect) => withShell({}, effect), Effect.scoped),
  );

  it.live("applies an env override to the loaded config", () =>
    Effect.gen(function* () {
      const root = yield* project('project_id = "declared"\n[api]\nmax_rows = 10\n');
      const layer = configValuesLayer();

      const snapshot = yield* load(root, Option.none()).pipe(Effect.provide(layer));

      expect(snapshot.loaded.config.api.max_rows).toBe(25);
    }).pipe(
      Effect.provide(BunServices.layer),
      (effect) => withShell({ SUPABASE_API_MAX_ROWS: "25" }, effect),
      Effect.scoped,
    ),
  );

  it.live("reports no config file when the workdir has none", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-cli-config-none-" });
      const layer = configValuesLayer();

      const snapshot = yield* load(root, Option.none()).pipe(Effect.provide(layer));

      expect(snapshot.hasConfigFile).toBe(false);
    }).pipe(Effect.provide(BunServices.layer), (effect) => withShell({}, effect), Effect.scoped),
  );

  it.live("fails on an unreadable .temp/project-ref unless the load tolerates it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* project('project_id = "declared"\n');
      yield* fs.makeDirectory(path.join(root, "supabase", ".temp", "project-ref"), {
        recursive: true,
      });
      const layer = configValuesLayer();

      const strict = yield* load(root, Option.some(LINKED)).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      const tolerant = yield* CliConfigValues.use((values) =>
        values.load({
          workdir: root,
          projectRef: Option.some(LINKED),
          tolerateUnreadableLinkedRef: true,
        }),
      ).pipe(Effect.provide(layer));

      expect(Exit.isFailure(strict)).toBe(true);
      expect(tolerant.withheldEnv).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer), (effect) => withShell({}, effect), Effect.scoped),
  );

  it.live("names the source of an invalid value and leaves it out when tolerated", () =>
    Effect.gen(function* () {
      const root = yield* project(
        `project_id = "declared"
[db]
port = "not-a-port"
[remotes.staging]
project_id = "${LINKED}"
`,
      );
      const layer = configValuesLayer();

      const failure = yield* load(root, Option.some(LINKED)).pipe(
        Effect.flip,
        Effect.provide(layer),
      );
      const tolerated = yield* CliConfigValues.use((values) =>
        values.load({ workdir: root, projectRef: Option.some(LINKED), tolerateInvalid: true }),
      ).pipe(Effect.provide(layer));

      expect(failure).toMatchObject({
        _tag: "CliConfigValueError",
        path: "db.port",
        source: "supabase/config.toml",
        message: 'Invalid db.port in supabase/config.toml: "not-a-port" is not a port (0-65535).',
      });
      expect(tolerated.invalid.map((entry) => entry.path)).toEqual(["db.port"]);
      expect(tolerated.materialized.config.db.port).toBe(54322);
    }).pipe(Effect.provide(BunServices.layer), (effect) => withShell({}, effect), Effect.scoped),
  );
});
