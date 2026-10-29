import { BunPath, BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Config,
  ConfigProvider,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
} from "effect";
import type { PlatformError } from "effect/PlatformError";

import { withConfigEnv } from "../../tests/helpers/command-mocks.ts";
import { cliConfigValuesTestLayer } from "../../tests/helpers/config-values-layer.ts";
import {
  checkDbToml,
  loadProjectEnvValues,
  readDbToml,
  resolveDeclarativeDir,
  type DbTomlValues,
} from "./db-config.toml-read.ts";
import { resolveSeedSqlPath } from "../shared/config/seed-path.ts";
import { sanitizeProjectId } from "../shared/config/project-id.ts";
import type { CliConfigValues } from "../config/cli-config-values.service.ts";
import {
  CommandTelemetryAttributes,
  type CommandTelemetryAttributeValues,
} from "../telemetry/command-telemetry-attributes.ts";

const servicesLive = Layer.mergeAll(BunServices.layer, cliConfigValuesTestLayer);

function withConfig(content: string | undefined) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "db-toml-" });
    if (content !== undefined) {
      yield* fs.makeDirectory(path.join(dir, "supabase"), { recursive: true });
      yield* fs.writeFileString(path.join(dir, "supabase", "config.toml"), content);
    }
    return dir;
  }).pipe(Effect.provide(BunServices.layer));
}

const writeFile = (dir: string, segments: ReadonlyArray<string>, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.writeFileString(path.join(dir, ...segments), content);
  }).pipe(Effect.provide(BunServices.layer));

const makeDir = (dir: string, segments: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.join(dir, ...segments), { recursive: true });
  }).pipe(Effect.provide(BunServices.layer));

const withEnv =
  (values: Readonly<Record<string, string>>) =>
  <A, E, R>(body: Effect.Effect<A, E, R>) =>
    withConfigEnv(values, body);

const read = (workdir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* readDbToml(fs, path, workdir);
  }).pipe(Effect.provide(servicesLive));

const readRef = (workdir: string, ref: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* readDbToml(fs, path, workdir, ref);
  }).pipe(Effect.provide(servicesLive));

const loadEnv = (workdir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* loadProjectEnvValues(fs, path, workdir);
  }).pipe(Effect.provide(BunServices.layer));

describe("read (lenient) vs check (throws) split", () => {
  const withServices = <A, E>(
    dir: string,
    run: (fs: FileSystem.FileSystem, path: Path.Path) => Effect.Effect<A, E, CliConfigValues>,
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      return yield* run(fs, path);
    }).pipe(Effect.provide(servicesLive));

  it.effect("checkDbToml throws on an undecryptable secret", () => {
    return withConfig('[db]\nroot_key = "encrypted:anything"\n').pipe(
      Effect.flatMap((dir) => withServices(dir, (fs, path) => checkDbToml(fs, path, dir))),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.pretty(exit.cause)).toContain(
              "failed to parse config: missing private key",
            );
          }
        }),
      ),
    );
  });

  it.effect("checkDbToml surfaces an invalid env value as CliConfigValueError", () => {
    return withConfig("[db]\nport = 5432\n").pipe(
      Effect.tap((dir) => writeFile(dir, ["supabase", ".env"], "SUPABASE_DB_PORT=notaport\n")),
      Effect.flatMap((dir) => withServices(dir, (fs, path) => checkDbToml(fs, path, dir))),
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error._tag).toBe("CliConfigValueError");
          expect(error.message).toContain('Invalid SUPABASE_DB_PORT="notaport"');
        }),
      ),
    );
  });

  it.effect("can skip vault resolution without skipping the rest of config validation", () => {
    return withConfig(
      [
        "[db.vault]",
        'local_secret = "encrypted:not-valid"',
        "[remotes.preview]",
        'project_id = "abcdefghijklmnopqrst"',
        "[remotes.preview.db.vault]",
        'remote_secret = "encrypted:not-valid"',
        "",
      ].join("\n"),
    ).pipe(
      Effect.flatMap((dir) =>
        withServices(dir, (fs, path) =>
          checkDbToml(fs, path, dir, undefined, { resolveVaultSecrets: false }),
        ),
      ),
      Effect.tap((values) =>
        Effect.sync(() => {
          expect(values.vault).toEqual([]);
          expect(values.baseline.vaultNames).toEqual(["local_secret"]);
        }),
      ),
    );
  });

  it.effect("readDbToml({ validate: false }) tolerates the same secret, returning defaults", () => {
    return withConfig('[db]\nroot_key = "encrypted:anything"\n').pipe(
      Effect.flatMap((dir) =>
        withServices(dir, (fs, path) => readDbToml(fs, path, dir, undefined, { validate: false })),
      ),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.vault).toEqual([]);
          expect(v.port).toBeGreaterThan(0);
        }),
      ),
    );
  });

  it.effect("readDbToml({ validate: false }) still returns a valid config's values", () => {
    return withConfig('project_id = "lenientproj"\n').pipe(
      Effect.flatMap((dir) =>
        withServices(dir, (fs, path) => readDbToml(fs, path, dir, undefined, { validate: false })),
      ),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.projectId).toBe("lenientproj");
        }),
      ),
    );
  });
});

describe("readDbToml", () => {
  it.effect("returns defaults when config.toml is absent", () => {
    return Effect.gen(function* () {
      const path = yield* Path.Path;
      const dir = yield* withConfig(undefined);
      const v = yield* read(dir);
      expect(v.port).toBe(54322);
      expect(v.shadowPort).toBe(54320);
      expect(v.password).toBe("postgres");
      expect(v.projectId).toBe(sanitizeProjectId(path.basename(dir)));
      expect(v.denoVersion).toBe(2);
    }).pipe(Effect.provide(BunServices.layer));
  });

  // A known-good test vector: decrypts to "value" under the keypair below.
  const VAULT_PRIVATE_KEY = "7fd7210cef8f331ee8c55897996aaaafd853a2b20a4dc73d6d75759f65d2a7eb";
  const VAULT_ENCRYPTED =
    "encrypted:BKiXH15AyRzeohGyUrmB6cGjSklCrrBjdesQlX1VcXo/Xp20Bi2gGZ3AlIqxPQDmjVAALnhZamKnuY73l8Dz1P+BYiZUgxTSLzdCvdYUyVbNekj2UudbdUizBViERtZkuQwZHIv/";

  it.effect("decrypts an encrypted: [db.vault] secret when DOTENV_PRIVATE_KEY is set", () => {
    return withConfig(["[db.vault]", `my_secret = "${VAULT_ENCRYPTED}"`, ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.vault).toEqual([{ name: "my_secret", value: "value", resolved: true }]);
        }),
      ),
      withEnv({ DOTENV_PRIVATE_KEY: VAULT_PRIVATE_KEY }),
    );
  });

  it.effect("fails the load for an encrypted: [db.vault] secret with no private key", () => {
    return withConfig(["[db.vault]", `my_secret = "${VAULT_ENCRYPTED}"`, ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.pretty(exit.cause)).toContain(
              "failed to parse config: missing private key",
            );
          }
        }),
      ),
    );
  });

  it.effect("collapses. and .. in relative seed sql_paths", () => {
    return withConfig(
      ["[db.seed]", 'sql_paths = ["../seed.sql", "sub/../other.sql", "./plain.sql"]', ""].join(
        "\n",
      ),
    ).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.seed.sqlPaths).toEqual(["seed.sql", "supabase/other.sql", "supabase/plain.sql"]);
        }),
      ),
    );
  });

  it.effect("honors SUPABASE_DB_SEED_SQL_PATHS over the TOML array (comma split, no trim)", () => {
    return withConfig(["[db.seed]", 'sql_paths = ["ignored.sql"]', ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.seed.sqlPaths).toEqual(["supabase/a.sql", "supabase/ b.sql"]);
        }),
      ),
      withEnv({ SUPABASE_DB_SEED_SQL_PATHS: "a.sql, b.sql" }),
    );
  });

  it.effect("decodes a STRING db.seed.sql_paths via StringToSliceHookFunc (comma, no trim)", () => {
    return withConfig(["[db.seed]", 'sql_paths = "a.sql,b.sql"', ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.seed.sqlPaths).toEqual(["supabase/a.sql", "supabase/b.sql"]);
        }),
      ),
    );
  });

  it.effect("treats an empty-string db.seed.sql_paths as no patterns", () => {
    return withConfig(["[db.seed]", 'sql_paths = ""', ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.seed.sqlPaths).toEqual([]);
        }),
      ),
    );
  });

  it.effect(
    "expands env() before splitting a string sql_paths (LoadEnv before StringToSlice)",
    () => {
      return withConfig(["[db.seed]", 'sql_paths = "env(SEEDS)"', ""].join("\n")).pipe(
        Effect.flatMap(read),
        Effect.tap((v) =>
          Effect.sync(() => {
            expect(v.seed.sqlPaths).toEqual(["supabase/a.sql", "supabase/b.sql"]);
          }),
        ),
        withEnv({ SEEDS: "a.sql,b.sql" }),
      );
    },
  );

  it.effect("expands an env() array element but does NOT split it", () => {
    return withConfig(["[db.seed]", 'sql_paths = ["env(SEEDS)"]', ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.seed.sqlPaths).toEqual(["supabase/a.sql,b.sql"]);
        }),
      ),
      withEnv({ SEEDS: "a.sql,b.sql" }),
    );
  });

  it.effect(
    "honors SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS over the TOML array (comma split, no trim)",
    () => {
      return withConfig(["[db.migrations]", 'schema_paths = ["ignored.sql"]', ""].join("\n")).pipe(
        Effect.flatMap(read),
        Effect.tap((v) =>
          Effect.sync(() => {
            expect(v.schemaPaths).toEqual(["supabase/a.sql", "supabase/ b.sql"]);
          }),
        ),
        withEnv({ SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS: "a.sql, b.sql" }),
      );
    },
  );

  it.effect(
    "decodes a STRING db.migrations.schema_paths via StringToSliceHookFunc (comma, no trim)",
    () => {
      return withConfig(["[db.migrations]", 'schema_paths = "a.sql,b.sql"', ""].join("\n")).pipe(
        Effect.flatMap(read),
        Effect.tap((v) =>
          Effect.sync(() => {
            expect(v.schemaPaths).toEqual(["supabase/a.sql", "supabase/b.sql"]);
          }),
        ),
      );
    },
  );

  it.effect(
    "on Windows, resolves a leading-slash schema/seed path pattern under supabase/ instead of treating it as absolute",
    () => {
      // A bare leading `/` has no Windows volume name, so it resolves as relative and joins to
      // `supabase/`, unlike Node's `path.win32.isAbsolute`, which treats a leading separator as
      // rooted at the current drive. Tests `resolveSeedSqlPath` directly with
      // `BunPath.layerWin32` instead of the full `readDbToml` pipeline, since that pipeline
      // needs the real (POSIX-pathed) `Path.Path` service to open the temp config file on disk.
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32" });
      return Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = resolveSeedSqlPath(path, "/schemas/*.sql");
        expect(resolved).toBe("supabase/schemas/*.sql");
      }).pipe(
        Effect.provide(BunPath.layerWin32),
        Effect.ensuring(
          Effect.sync(() => {
            Object.defineProperty(process, "platform", { value: originalPlatform });
          }),
        ),
      );
    },
  );

  it.effect.each([
    {
      name: "seed array with number and bool",
      table: "db.seed",
      field: "sql_paths",
      value: '[42, true, "seed.sql"]',
      expected: ["supabase/42", "supabase/1", "supabase/seed.sql"],
    },
    {
      name: "schema array with number and bool",
      table: "db.migrations",
      field: "schema_paths",
      value: '[42, true, "schemas/*.sql"]',
      expected: ["supabase/42", "supabase/1", "supabase/schemas/*.sql"],
    },
    {
      name: "large number as fixed decimal",
      table: "db.migrations",
      field: "schema_paths",
      value: "[1e21]",
      expected: ["supabase/1000000000000000000000"],
    },
    {
      name: "special floats",
      table: "db.migrations",
      field: "schema_paths",
      value: "[inf, -inf, nan]",
      expected: ["supabase/+Inf", "supabase/-Inf", "supabase/NaN"],
    },
    {
      name: "scalar number schema_paths",
      table: "db.migrations",
      field: "schema_paths",
      value: "42",
      expected: ["supabase/42"],
    },
    {
      name: "scalar bool schema_paths",
      table: "db.migrations",
      field: "schema_paths",
      value: "true",
      expected: ["supabase/1"],
    },
    {
      name: "empty table schema_paths",
      table: "db.migrations",
      field: "schema_paths",
      value: "{}",
      expected: [],
    },
    {
      name: "scalar number sql_paths",
      table: "db.seed",
      field: "sql_paths",
      value: "42",
      expected: ["supabase/42"],
    },
  ])("weakly coerces a glob list: $name", ({ table, field, value, expected }) => {
    return withConfig([`[${table}]`, `${field} = ${value}`, ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(table === "db.seed" ? v.seed.sqlPaths : v.schemaPaths).toEqual(expected);
        }),
      ),
    );
  });

  it.effect.each([
    { name: "offset date-time", literal: "1979-05-27T07:32:00Z", typeName: "offset date-time" },
    { name: "local date-time", literal: "1979-05-27T07:32:00", typeName: "local date-time" },
    { name: "local date", literal: "1979-05-27", typeName: "local date" },
    { name: "local time", literal: "07:32:00", typeName: "local time" },
  ])(
    "rejects a bare $name db.migrations.schema_paths instead of treating it as empty",
    ({ literal, typeName }) => {
      // `smol-toml` parses every TOML datetime variant to a `TomlDate` (a `Date` subclass)
      // that stores its value internally, not as an enumerable own property, so
      // `Object.keys(tomlDate).length === 0` — same as a genuine empty inline table
      // (`schema_paths = {}`, tested above). `TomlDate` must be excluded from that
      // zero-length-map special case, or this would silently resolve to `[]` instead of
      // aborting.
      return withConfig(["[db.migrations]", `schema_paths = ${literal}`, ""].join("\n")).pipe(
        Effect.flatMap(read),
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              expect(Cause.pretty(exit.cause)).toContain(
                `db.migrations.schema_paths[0]: expected a string, got ${typeName}`,
              );
            }
          }),
        ),
      );
    },
  );

  it.effect.each([
    {
      name: "a datetime schema_paths array element",
      toml: ["[db.migrations]", 'schema_paths = ["schemas/*.sql", 1979-05-27T07:32:00Z]', ""],
      issue: "db.migrations.schema_paths[1]: expected a string, got offset date-time",
    },
    {
      name: "a bare datetime sql_paths",
      toml: ["[db.seed]", "sql_paths = 1979-05-27T07:32:00Z", ""],
      issue: "db.seed.sql_paths[0]: expected a string, got offset date-time",
    },
    {
      name: "a table schema_paths",
      toml: ["[db.migrations.schema_paths]", 'foo = "bar"', ""],
      issue: "db.migrations.schema_paths[0]: expected a string, got table",
    },
    {
      name: "a nested-list schema_paths element",
      toml: ["[db.migrations]", "schema_paths = [[]]", ""],
      issue: "failed to parse config:\ndb.migrations.schema_paths[0]: expected a string, got array",
    },
    {
      name: "a table schema_paths element",
      toml: ["[db.migrations]", 'schema_paths = ["schemas/*.sql", { path = "x.sql" }]', ""],
      issue: "db.migrations.schema_paths[1]: expected a string, got table",
    },
    {
      name: "a nested-list sql_paths element",
      toml: ["[db.seed]", "sql_paths = [[]]", ""],
      issue: "db.seed.sql_paths[0]: expected a string, got array",
    },
  ])("rejects $name", ({ toml, issue }) => {
    return withConfig(toml.join("\n")).pipe(
      Effect.flatMap(read),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain(issue);
        }),
      ),
    );
  });

  it.effect("reports invalid entries of both glob lists in one error, schema_paths first", () => {
    return withConfig(
      ["[db.seed]", "sql_paths = [[]]", "", "[db.migrations]", "schema_paths = [[]]", ""].join(
        "\n",
      ),
    ).pipe(
      Effect.flatMap(read),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const message = Cause.pretty(exit.cause);
            const schemaIssue = "db.migrations.schema_paths[0]: expected a string, got array";
            const seedIssue = "db.seed.sql_paths[0]: expected a string, got array";
            expect(message).toContain(schemaIssue);
            expect(message).toContain(seedIssue);
            expect(message.indexOf(schemaIssue)).toBeLessThan(message.indexOf(seedIssue));
          }
        }),
      ),
    );
  });

  it.effect.each([
    {
      name: "numeric db.seed.enabled = 0",
      table: "db.seed",
      field: "enabled",
      value: "0",
      read: (v: DbTomlValues) => v.seed.enabled,
      expected: false,
    },
    {
      name: "numeric db.migrations.enabled = 0",
      table: "db.migrations",
      field: "enabled",
      value: "0",
      read: (v: DbTomlValues) => v.migrationsEnabled,
      expected: false,
    },
    {
      name: "numeric experimental.pgdelta.enabled = 1",
      table: "experimental.pgdelta",
      field: "enabled",
      value: "1",
      read: (v: DbTomlValues) => v.pgDelta.enabled,
      expected: true,
    },
    {
      name: 'string auth.enabled = "0"',
      table: "auth",
      field: "enabled",
      value: '"0"',
      read: (v: DbTomlValues) => v.baseline.authEnabled,
      expected: false,
    },
    {
      name: 'upper-case api.auto_expose_new_tables = "TRUE"',
      table: "api",
      field: "auto_expose_new_tables",
      value: '"TRUE"',
      read: (v: DbTomlValues) => Option.getOrNull(v.baseline.apiAutoExposeNewTables),
      expected: true,
    },
  ])("decodes $name as a bool", ({ table, field, value, read: pick, expected }) => {
    return withConfig([`[${table}]`, `${field} = ${value}`, ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(pick(v)).toBe(expected);
        }),
      ),
    );
  });

  it.effect.each([
    {
      name: "db.seed.enabled",
      table: "db.seed",
      field: "enabled",
      read: (v: DbTomlValues) => v.seed.enabled,
    },
    {
      name: "db.migrations.enabled",
      table: "db.migrations",
      field: "enabled",
      read: (v: DbTomlValues) => v.migrationsEnabled,
    },
    {
      name: "experimental.pgdelta.enabled",
      table: "experimental.pgdelta",
      field: "enabled",
      read: (v: DbTomlValues) => v.pgDelta.enabled,
    },
    {
      name: "api.auto_expose_new_tables",
      table: "api",
      field: "auto_expose_new_tables",
      read: (v: DbTomlValues) => Option.getOrNull(v.baseline.apiAutoExposeNewTables),
    },
  ])(
    "expands an env() reference in $name through the shell and project .env",
    ({ table, field, read: pick }) => {
      return withConfig([`[${table}]`, `${field} = "env(WEAK_FLAG)"`, ""].join("\n")).pipe(
        Effect.flatMap(read),
        Effect.tap((v) =>
          Effect.sync(() => {
            expect(pick(v)).toBe(true);
          }),
        ),
        withEnv({ WEAK_FLAG: "TRUE" }),
      );
    },
  );

  it.effect("fails on an unresolved env() reference in a bool field", () => {
    return withConfig(["[db.seed]", 'enabled = "env(WEAK_FLAG_UNSET)"', ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.pretty(exit.cause)).toContain(
              "Invalid db.seed.enabled in supabase/config.toml",
            );
          }
        }),
      ),
    );
  });

  it.effect("decodes a numeric string db.port", () => {
    return withConfig(["[db]", 'port = "6002"', ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.port).toBe(6002);
        }),
      ),
    );
  });

  it.effect(
    "SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS beats a matched remote's db.migrations.schema_paths",
    () => {
      const ref = "schmschmschmschmschm";
      return withConfig(
        [
          "[remotes.prod]",
          `project_id = "${ref}"`,
          'db.migrations.schema_paths = ["remote-only.sql"]',
          "",
        ].join("\n"),
      ).pipe(
        Effect.flatMap((dir) => readRef(dir, ref)),
        Effect.tap((v) =>
          Effect.sync(() => {
            expect(v.schemaPaths).toEqual(["supabase/env-only.sql"]);
          }),
        ),
        withEnv({ SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS: "env-only.sql" }),
      );
    },
  );

  it.effect("rejects an explicit db.port = 0 as a missing required field", () => {
    return withConfig(["[db]", "port = 0", ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.pretty(exit.cause)).toContain("Missing required field in config: db.port");
          }
        }),
      ),
    );
  });

  it.effect("SUPABASE_DB_MIGRATIONS_ENABLED beats a matched remote's db.migrations.enabled", () => {
    const ref = "abcdefghijklmnopqrst";
    return withConfig(
      ["[remotes.prod]", `project_id = "${ref}"`, "db.migrations.enabled = true", ""].join("\n"),
    ).pipe(
      Effect.flatMap((dir) => readRef(dir, ref)),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.migrationsEnabled).toBe(false);
        }),
      ),
      withEnv({ SUPABASE_DB_MIGRATIONS_ENABLED: "false" }),
    );
  });

  it.effect("SUPABASE_DB_MIGRATIONS_ENABLED still wins when the remote block omits it", () => {
    const ref = "abcdefghijklmnopqrst";
    return withConfig(["[remotes.prod]", `project_id = "${ref}"`, ""].join("\n")).pipe(
      Effect.flatMap((dir) => readRef(dir, ref)),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.migrationsEnabled).toBe(false);
        }),
      ),
      withEnv({ SUPABASE_DB_MIGRATIONS_ENABLED: "false" }),
    );
  });

  it.effect("collapses. and .. in relative db.migrations.schema_paths", () => {
    return withConfig(
      [
        "[db.migrations]",
        'schema_paths = ["../schema.sql", "sub/../other.sql", "./schemas/a.sql"]',
        "",
      ].join("\n"),
    ).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.schemaPaths).toEqual([
            "schema.sql",
            "supabase/other.sql",
            "supabase/schemas/a.sql",
          ]);
        }),
      ),
    );
  });

  it.effect(
    "honors SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS over the TOML array (comma split, no trim)",
    () => {
      return withConfig(["[db.migrations]", 'schema_paths = ["ignored.sql"]', ""].join("\n")).pipe(
        Effect.flatMap(read),
        Effect.tap((v) =>
          Effect.sync(() => {
            expect(v.schemaPaths).toEqual(["supabase/a.sql", "supabase/ b.sql"]);
          }),
        ),
        withEnv({ SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS: "a.sql, b.sql" }),
      );
    },
  );

  it.effect("defaults db.migrations.schema_paths to [] when absent", () => {
    return withConfig(["[db]", "port = 54322", ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.schemaPaths).toEqual([]);
        }),
      ),
    );
  });

  it.effect(
    "SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS beats a matched remote's db.migrations.schema_paths in a [remotes.*.db.migrations] table",
    () => {
      const ref = "abcdefghijklmnopqrst";
      return withConfig(
        [
          "[remotes.prod]",
          `project_id = "${ref}"`,
          "[remotes.prod.db.migrations]",
          'schema_paths = ["remote-wins.sql"]',
          "",
        ].join("\n"),
      ).pipe(
        Effect.flatMap((dir) => readRef(dir, ref)),
        Effect.tap((v) =>
          Effect.sync(() => {
            expect(v.schemaPaths).toEqual(["supabase/env-wins.sql"]);
          }),
        ),
        withEnv({ SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS: "env-wins.sql" }),
      );
    },
  );

  it.effect(
    "SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED beats a matched remote's pgdelta.enabled",
    () => {
      const ref = "abcdefghijklmnopqrst";
      return withConfig(
        [
          "[remotes.prod]",
          `project_id = "${ref}"`,
          "[remotes.prod.experimental.pgdelta]",
          "enabled = true",
          "",
        ].join("\n"),
      ).pipe(
        Effect.flatMap((dir) => readRef(dir, ref)),
        Effect.tap((v) =>
          Effect.sync(() => {
            expect(v.pgDelta.enabled).toBe(false);
          }),
        ),
        withEnv({ SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED: "false" }),
      );
    },
  );

  it.effect("SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED still wins when the block omits pgdelta", () => {
    const ref = "abcdefghijklmnopqrst";
    return withConfig(["[remotes.prod]", `project_id = "${ref}"`, ""].join("\n")).pipe(
      Effect.flatMap((dir) => readRef(dir, ref)),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.pgDelta.enabled).toBe(false);
        }),
      ),
      withEnv({ SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED: "false" }),
    );
  });

  it.effect("SUPABASE_AUTH_ENABLED beats a matched remote's auth.enabled", () => {
    const ref = "abcdefghijklmnopqrst";
    return withConfig(
      [
        "[remotes.prod]",
        `project_id = "${ref}"`,
        "[remotes.prod.auth]",
        "enabled = false",
        "",
      ].join("\n"),
    ).pipe(
      Effect.flatMap((dir) => readRef(dir, ref)),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.baseline.authEnabled).toBe(true);
        }),
      ),
      withEnv({ SUPABASE_AUTH_ENABLED: "true" }),
    );
  });

  it.effect("SUPABASE_AUTH_ENABLED still wins when the remote block omits auth.enabled", () => {
    const ref = "abcdefghijklmnopqrst";
    return withConfig(["[remotes.prod]", `project_id = "${ref}"`, ""].join("\n")).pipe(
      Effect.flatMap((dir) => readRef(dir, ref)),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.baseline.authEnabled).toBe(false);
        }),
      ),
      withEnv({ SUPABASE_AUTH_ENABLED: "false" }),
    );
  });

  it.effect(
    "SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED=false beats a matched remote's enabled = true and fails validation",
    () => {
      const ref = "abcdefghijklmnopqrst";
      return withConfig(
        [
          "[remotes.prod]",
          `project_id = "${ref}"`,
          "[remotes.prod.experimental.webhooks]",
          "enabled = true",
          "",
        ].join("\n"),
      ).pipe(
        Effect.flatMap((dir) => readRef(dir, ref)),
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              expect(Cause.pretty(exit.cause)).toContain("Webhooks cannot be deactivated");
            }
          }),
        ),
        withEnv({ SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED: "false" }),
      );
    },
  );

  it.effect(
    "SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED still wins when the remote block omits webhooks",
    () => {
      // A base [experimental.webhooks] section (present, default true) flipped off by the env
      // var still fails the "cannot be deactivated" validation.
      const ref = "abcdefghijklmnopqrst";
      return withConfig(
        [
          "[experimental.webhooks]",
          "enabled = true",
          "[remotes.prod]",
          `project_id = "${ref}"`,
          "",
        ].join("\n"),
      ).pipe(
        Effect.flatMap((dir) => readRef(dir, ref)),
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              expect(Cause.pretty(exit.cause)).toContain("Webhooks cannot be deactivated");
            }
          }),
        ),
        withEnv({ SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED: "false" }),
      );
    },
  );

  it.effect(
    "ignores a malformed SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED when [experimental.webhooks] is absent",
    () => {
      // The env override only applies when [experimental.webhooks] is declared (unlike
      // experimental.pgdelta.enabled, always known via defaults); a malformed value must not
      // fail the whole config load when the section is absent.
      return withConfig("").pipe(
        Effect.flatMap(read),
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            expect(Exit.isSuccess(exit)).toBe(true);
            if (Exit.isSuccess(exit)) expect(exit.value.webhooksEnabled).toBe(false);
          }),
        ),
        withEnv({ SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED: "bogus" }),
      );
    },
  );

  it.effect("matches a remote block by a SUPABASE_REMOTES_<NAME>_PROJECT_ID env override", () => {
    // The env override alone is enough to match the block, with no TOML project_id at all.
    const ref = "abcdefghijklmnopqrst";
    return withConfig(["[remotes.prod]", "db.major_version = 15", ""].join("\n")).pipe(
      Effect.flatMap((dir) => readRef(dir, ref)),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.majorVersion).toBe(15);
        }),
      ),
      withEnv({ SUPABASE_REMOTES_PROD_PROJECT_ID: ref }),
    );
  });

  it.effect("validates a remote project_id supplied only via env (no TOML literal)", () => {
    // Without the env value, the block (no TOML project_id) would fail validation.
    const ref = "abcdefghijklmnopqrst";
    return withConfig(["[remotes.prod]", "db.major_version = 15", ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          // read() without a ref leaves the base major_version default (17) since the block
          // isn't merged.
          expect(v.majorVersion).toBe(17);
        }),
      ),
      withEnv({ SUPABASE_REMOTES_PROD_PROJECT_ID: ref }),
    );
  });

  it.effect("SUPABASE_DB_SEED_ENABLED beats the seed default a matched remote implies", () => {
    const ref = "abcdefghijklmnopqrst";
    return withConfig(["[remotes.prod]", `project_id = "${ref}"`, ""].join("\n")).pipe(
      Effect.flatMap((dir) => readRef(dir, ref)),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.seed.enabled).toBe(true);
        }),
      ),
      withEnv({ SUPABASE_DB_SEED_ENABLED: "true" }),
    );
  });

  it.effect("SUPABASE_DB_SEED_ENABLED still wins on the local path (no remote force)", () => {
    return withConfig(["[db.seed]", "enabled = true", ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.seed.enabled).toBe(false);
        }),
      ),
      withEnv({ SUPABASE_DB_SEED_ENABLED: "false" }),
    );
  });

  it.effect("reads [edge_runtime] deno_version = 1 (selects the deno1 image)", () => {
    return withConfig(["[edge_runtime]", "deno_version = 1", ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.denoVersion).toBe(1);
        }),
      ),
    );
  });

  it.effect("defaults deno_version to 2 when [edge_runtime] omits it", () => {
    return withConfig(["[edge_runtime]", 'policy = "per_worker"', ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.denoVersion).toBe(2);
        }),
      ),
    );
  });

  it.effect("fails with DbConfigLoadError when config.toml is malformed", () => {
    return withConfig("[db]\nport = [unterminated").pipe(
      Effect.flatMap(read),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.pretty(exit.cause)).toContain("DbConfigLoadError");
          }
        }),
      ),
    );
  });

  describe("[remotes.<ref>] override", () => {
    const REMOTE_CONFIG = [
      'project_id = "base"',
      "[db]",
      "major_version = 15",
      'password = "base-pw"',
      "[remotes.production]",
      'project_id = "prodprodprodprodprod"',
      "[remotes.production.db]",
      "major_version = 17",
      "",
    ].join("\n");

    it.effect("merges the matching remote block when the ref matches its project_id", () => {
      return withConfig(REMOTE_CONFIG).pipe(
        Effect.flatMap((dir) => readRef(dir, "prodprodprodprodprod")),
        Effect.tap((v) =>
          Effect.sync(() => {
            // db.major_version overridden by [remotes.production.db]; password kept from base.
            expect(v.majorVersion).toBe(17);
            expect(v.password).toBe("base-pw");
          }),
        ),
      );
    });

    it.effect("ignores the remote block when no ref is passed (local/db-url parity)", () => {
      return withConfig(REMOTE_CONFIG).pipe(
        Effect.flatMap(read),
        Effect.tap((v) =>
          Effect.sync(() => {
            expect(v.majorVersion).toBe(15);
          }),
        ),
      );
    });

    it.effect("ignores the remote block when the ref does not match any project_id", () => {
      return withConfig(REMOTE_CONFIG).pipe(
        Effect.flatMap((dir) => readRef(dir, "otherotherotherother")),
        Effect.tap((v) =>
          Effect.sync(() => {
            expect(v.majorVersion).toBe(15);
          }),
        ),
      );
    });

    it.effect("forces db.seed.enabled false when the matched remote block omits it", () => {
      return withConfig(
        [
          'project_id = "base"',
          "[db.seed]",
          "enabled = true",
          "[remotes.production]",
          'project_id = "prodprodprodprodprod"',
          "[remotes.production.db]",
          "major_version = 17",
          "",
        ].join("\n"),
      ).pipe(
        Effect.flatMap((dir) => readRef(dir, "prodprodprodprodprod")),
        Effect.tap((v) =>
          Effect.sync(() => {
            expect(v.seed.enabled).toBe(false);
          }),
        ),
      );
    });

    it.effect("keeps db.seed.enabled true when the matched remote block sets it explicitly", () => {
      return withConfig(
        [
          'project_id = "base"',
          "[db.seed]",
          "enabled = false",
          "[remotes.production]",
          'project_id = "prodprodprodprodprod"',
          "[remotes.production.db.seed]",
          "enabled = true",
          "",
        ].join("\n"),
      ).pipe(
        Effect.flatMap((dir) => readRef(dir, "prodprodprodprodprod")),
        Effect.tap((v) =>
          Effect.sync(() => {
            expect(v.seed.enabled).toBe(true);
          }),
        ),
      );
    });

    it.effect("rejects two remote blocks with the same project_id (any command)", () => {
      return withConfig(
        [
          "[remotes.a]",
          'project_id = "dupdupdupdupdupdupdup0"',
          "[remotes.b]",
          'project_id = "dupdupdupdupdupdupdup0"',
          "",
        ].join("\n"),
      ).pipe(
        Effect.flatMap(read),
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              expect(Cause.pretty(exit.cause)).toContain("duplicate project_id for [remotes.b]");
            }
          }),
        ),
      );
    });
  });

  it.effect("rejects an invalid [edge_runtime] deno_version", () => {
    // Valid values are 1 and 2.
    return withConfig(["[edge_runtime]", "deno_version = 3", ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.pretty(exit.cause)).toContain(
              "Failed reading config: Invalid edge_runtime.deno_version: 3.",
            );
          }
        }),
      ),
    );
  });

  it.effect("rejects deno_version = 0 with the missing-required message", () => {
    return withConfig(["[edge_runtime]", "deno_version = 0", ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.pretty(exit.cause)).toContain(
              "Missing required field in config: edge_runtime.deno_version",
            );
          }
        }),
      ),
    );
  });

  it.effect("accepts deno_version = 1", () => {
    return withConfig(["[edge_runtime]", "deno_version = 1", ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.denoVersion).toBe(1);
        }),
      ),
    );
  });

  it.effect("rejects invalid [experimental.pgdelta] format_options JSON during load", () => {
    return withConfig('[experimental.pgdelta]\nformat_options = "not-json"\n').pipe(
      Effect.flatMap(read),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const causeText = Cause.pretty(exit.cause);
            expect(causeText).toContain("DbConfigLoadError");
            expect(causeText).toContain(
              "Invalid config for experimental.pgdelta.format_options: must be valid JSON",
            );
          }
        }),
      ),
    );
  });

  it.effect("accepts valid [experimental.pgdelta] format_options JSON", () => {
    return withConfig(
      '[experimental.pgdelta]\nformat_options = "{\\"keywordCase\\":\\"upper\\"}"\n',
    ).pipe(Effect.flatMap(read));
  });

  it.effect("rejects an invalid [storage.buckets.<name>] during load", () => {
    // `#` is outside the allowed bucket-name characters, so this name is rejected.
    return withConfig('[storage.buckets."bad#name"]\n').pipe(
      Effect.flatMap(read),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const causeText = Cause.pretty(exit.cause);
            expect(causeText).toContain("DbConfigLoadError");
            // Prose part is backslash-free, so safe to assert through Cause.pretty.
            expect(causeText).toContain(
              "Invalid Bucket name: bad#name. Only lowercase letters, numbers, dots, hyphens, and spaces are allowed.",
            );
          }
        }),
      ),
    );
  });

  it.effect("rejects an invalid [functions.<slug>] during load", () => {
    // `123` starts with a digit, rejected by `^[A-Za-z][A-Za-z0-9_-]*$`.
    return withConfig("[functions.123]\n").pipe(
      Effect.flatMap(read),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const causeText = Cause.pretty(exit.cause);
            expect(causeText).toContain("DbConfigLoadError");
            expect(causeText).toContain(
              "Invalid Function name: 123. Must start with at least one letter, and only include alphanumeric characters, underscores, and hyphens.",
            );
          }
        }),
      ),
    );
  });

  it.effect("accepts a valid [functions.<slug>] (letters, digits, _ and -)", () => {
    return withConfig("[functions.my-function]\n[functions.function_1]\n").pipe(
      Effect.flatMap(read),
    );
  });

  it.effect("accepts an underscore bucket name", () => {
    // The bucket-name pattern uses `\w` (includes `_`) and is not case-restricted despite the
    // prose, so `Bad_Name` actually passes: match the regex, not the message text.
    return withConfig("[storage.buckets.Bad_Name]\n").pipe(Effect.flatMap(read));
  });

  it.effect("rejects an unparseable [storage.buckets.<name>].file_size_limit during load", () => {
    // A malformed value must fail config load itself, not only later inside `seedBucketsRun`,
    // where it would go unvalidated on a reused-volume restart or the already-running
    // short-circuit.
    return withConfig('[storage.buckets.avatars]\nfile_size_limit = "bogus"\n').pipe(
      Effect.flatMap(read),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const causeText = Cause.pretty(exit.cause);
            expect(causeText).toContain("DbConfigLoadError");
            expect(causeText).toContain("invalid storage.buckets.avatars.file_size_limit");
          }
        }),
      ),
    );
  });

  it.effect("accepts a bare-number [storage.buckets.<name>].file_size_limit", () => {
    // `@supabase/config`'s schema allows file_size_limit as either a quoted
    // human-readable string or a bare byte count; the numeric form must normalize to
    // a string before `ramInBytes` parses it rather than being rejected outright.
    return withConfig("[storage.buckets.avatars]\nfile_size_limit = 5242880\n").pipe(
      Effect.flatMap(read),
    );
  });

  it.effect("decodes empty api schemas while keeping auto_expose_new_tables absent", () => {
    return withConfig('[api]\nschemas = ""\n').pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.apiSchemas).toEqual([]);
          expect(Option.isNone(v.baseline.apiAutoExposeNewTables)).toBe(true);
        }),
      ),
    );
  });

  it.effect("rejects a malformed [api] auto_expose_new_tables during load", () => {
    return withConfig('[api]\nauto_expose_new_tables = "maybe"\n').pipe(
      Effect.flatMap(read),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const causeText = Cause.pretty(exit.cause);
            expect(causeText).toContain("CliConfigValueError");
            expect(causeText).toContain(
              "Invalid api.auto_expose_new_tables in supabase/config.toml",
            );
          }
        }),
      ),
    );
  });

  it.effect("honors SUPABASE_API_AUTO_EXPOSE_NEW_TABLES env override (AutomaticEnv)", () => {
    return withConfig("[api]\nauto_expose_new_tables = false\n").pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(Option.getOrNull(v.baseline.apiAutoExposeNewTables)).toBe(true);
        }),
      ),
      withEnv({ SUPABASE_API_AUTO_EXPOSE_NEW_TABLES: "1" }),
    );
  });

  it.effect("honors SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED / _DECLARATIVE_SCHEMA_PATH env", () => {
    return withConfig(undefined).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.pgDelta.enabled).toBe(true);
          expect(Option.getOrNull(v.pgDelta.declarativeSchemaPath)).toBe("supabase/from_env");
        }),
      ),
      withEnv({
        SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED: "true",
        SUPABASE_EXPERIMENTAL_PGDELTA_DECLARATIVE_SCHEMA_PATH: "from_env",
      }),
    );
  });

  it.effect("expands an env() indirection in the PGDELTA_DECLARATIVE_SCHEMA_PATH override", () => {
    return withConfig(undefined).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(Option.getOrNull(v.pgDelta.declarativeSchemaPath)).toBe("supabase/schemas");
        }),
      ),
      withEnv({
        SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED: "true",
        SUPABASE_EXPERIMENTAL_PGDELTA_DECLARATIVE_SCHEMA_PATH: "env(SCHEMA_DIR)",
        SCHEMA_DIR: "schemas",
      }),
    );
  });

  it.effect("treats SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED=1 as true", () => {
    return withConfig(undefined).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.pgDelta.enabled).toBe(true);
        }),
      ),
      withEnv({ SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED: "1" }),
    );
  });

  it.effect("fails on a malformed SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED", () => {
    return withConfig(undefined).pipe(
      Effect.flatMap(read),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.pretty(exit.cause)).toContain(
              "Invalid SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED",
            );
          }
        }),
      ),
      withEnv({ SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED: "maybe" }),
    );
  });

  it.effect("fails on a malformed [storage] enabled string", () => {
    return withConfig(["[storage]", 'enabled = "nope"', ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.pretty(exit.cause)).toContain(
              "Invalid storage.enabled in supabase/config.toml",
            );
          }
        }),
      ),
    );
  });

  it.effect("fails with DbConfigLoadError when config.toml is present but unreadable", () => {
    // A directory at the config.toml path yields a non-NotFound read error.
    return withConfig(undefined).pipe(
      Effect.tap((dir) => makeDir(dir, ["supabase", "config.toml"])),
      Effect.flatMap(read),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.pretty(exit.cause)).toContain("DbConfigLoadError");
            expect(Cause.pretty(exit.cause)).toContain("failed to read file config");
          }
        }),
      ),
    );
  });

  it.effect("falls back to the default password when [db] omits it", () => {
    return withConfig(["[db]", "port = 5000", ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.port).toBe(5000);
          expect(v.password).toBe("postgres");
        }),
      ),
    );
  });

  it.effect("reads db + project_id from config.toml", () => {
    return withConfig(
      [
        'project_id = "my-project"',
        "[db]",
        "port = 55555",
        "shadow_port = 55556",
        'password = "hunter2"',
        "",
      ].join("\n"),
    ).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.port).toBe(55555);
          expect(v.shadowPort).toBe(55556);
          expect(v.password).toBe("hunter2");
          expect(v.projectId).toBe("my-project");
        }),
      ),
    );
  });

  it.effect("reads the db subtree and project_id from supabase/config.json", () => {
    return withConfig(undefined).pipe(
      Effect.tap((dir) => makeDir(dir, ["supabase"])),
      Effect.tap((dir) =>
        writeFile(
          dir,
          ["supabase", "config.json"],
          JSON.stringify({ project_id: "json-project", db: { port: 55777, shadow_port: 55778 } }),
        ),
      ),
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.port).toBe(55777);
          expect(v.shadowPort).toBe(55778);
          expect(v.projectId).toBe("json-project");
        }),
      ),
    );
  });

  it.effect("expands env(VAR) for password and port", () => {
    return withConfig(
      ["[db]", 'port = "env(DB_PORT)"', 'password = "env(DB_PW)"', ""].join("\n"),
    ).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.port).toBe(6000);
          expect(v.password).toBe("from-env");
        }),
      ),
      withEnv({ DB_PW: "from-env", DB_PORT: "6000" }),
    );
  });

  it.effect("expands env(VAR) in db.seed.sql_paths entries before supabase-prefixing", () => {
    return withConfig(["[db.seed]", 'sql_paths = ["env(SEED_SQL)"]', ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.seed.sqlPaths).toEqual(["supabase/custom/data.sql"]);
        }),
      ),
      withEnv({ SEED_SQL: "custom/data.sql" }),
    );
  });

  it.effect("honors SUPABASE_DB_SEED_ENABLED over the TOML value", () => {
    return withConfig(["[db.seed]", "enabled = true", ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.seed.enabled).toBe(false);
        }),
      ),
      withEnv({ SUPABASE_DB_SEED_ENABLED: "false" }),
    );
  });

  it.effect("expands an env() indirection in SUPABASE_DB_SEED_ENABLED", () => {
    return withConfig(["[db.seed]", "enabled = true", ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.seed.enabled).toBe(false);
        }),
      ),
      withEnv({ SUPABASE_DB_SEED_ENABLED: "env(SEED_ON)", SEED_ON: "false" }),
    );
  });

  it.effect("honors SUPABASE_DB_MIGRATIONS_ENABLED over the default", () => {
    return withConfig(undefined).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.migrationsEnabled).toBe(false);
        }),
      ),
      withEnv({ SUPABASE_DB_MIGRATIONS_ENABLED: "false" }),
    );
  });

  it.effect("fails the load on a malformed SUPABASE_DB_SEED_ENABLED override", () => {
    return withConfig(undefined).pipe(
      Effect.flatMap(read),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
        }),
      ),
      withEnv({ SUPABASE_DB_SEED_ENABLED: "notabool" }),
    );
  });

  it.effect("expands env(VAR) for the top-level project_id", () => {
    return withConfig(['project_id = "env(PROJECT_REF)"', ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.projectId).toBe("abcdefghijklmnopqrst");
        }),
      ),
      withEnv({ PROJECT_REF: "abcdefghijklmnopqrst" }),
    );
  });

  it.effect("does not merge a remote block whose project_id is a TOML env() literal", () => {
    // Remote matching happens on the raw `env(...)` literal, before expansion, so this block is
    // never selected by its expanded ref (major_version stays the base 15) even though
    // validation over the expanded field still passes.
    return withConfig(
      [
        'project_id = "base"',
        "[db]",
        "major_version = 15",
        "[remotes.staging]",
        'project_id = "env(STAGING_REF)"',
        "[remotes.staging.db]",
        "major_version = 17",
        "",
      ].join("\n"),
    ).pipe(
      Effect.flatMap((dir) => readRef(dir, "stagingrefstagingref")),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.majorVersion).toBe(15);
        }),
      ),
      withEnv({ STAGING_REF: "stagingrefstagingref" }),
    );
  });

  it.effect("rejects an env-backed remote project_id that expands to nothing", () => {
    return withConfig(["[remotes.staging]", 'project_id = "env(MISSING_REF)"', ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.pretty(exit.cause)).toContain(
              "Invalid config for remotes.staging.project_id",
            );
          }
        }),
      ),
      withEnv({}),
    );
  });

  it.effect("parses db.orioledb_version (env-expanded) on a 15/17 project", () => {
    return withConfig(
      [
        "[db]",
        "major_version = 17",
        'orioledb_version = "env(ORIOLE_VER)"',
        "[experimental]",
        's3_host = "s3.example.com"',
        's3_region = "us-east-1"',
        's3_access_key = "key"',
        's3_secret_key = "secret"',
        "",
      ].join("\n"),
    ).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(Option.getOrNull(v.orioledbVersion)).toBe("16.0.0.1");
        }),
      ),
      withEnv({ ORIOLE_VER: "16.0.0.1" }),
    );
  });

  it.effect("rejects a non-empty experimental.orioledb_version, naming db.orioledb_version", () => {
    return withConfig(
      ["[db]", "major_version = 17", "[experimental]", 'orioledb_version = "15.1.0.150"', ""].join(
        "\n",
      ),
    ).pipe(
      Effect.flatMap(read),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.pretty(exit.cause)).toContain(
              "experimental.orioledb_version in supabase/config.toml is no longer supported. Use db.orioledb_version instead.",
            );
          }
        }),
      ),
    );
  });

  it.effect("ignores an empty experimental.orioledb_version", () => {
    return withConfig(
      [
        "[db]",
        "major_version = 17",
        'orioledb_version = "17.0.0.1"',
        "[experimental]",
        'orioledb_version = ""',
        "",
      ].join("\n"),
    ).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(Option.getOrNull(v.orioledbVersion)).toBe("17.0.0.1");
        }),
      ),
    );
  });

  it.effect("a matched remote's db.orioledb_version overrides the base db.orioledb_version", () => {
    const ref = "abcdefghijklmnopqrst";
    return withConfig(
      [
        "[db]",
        "major_version = 17",
        'orioledb_version = "A"',
        "[remotes.prod]",
        `project_id = "${ref}"`,
        "[remotes.prod.db]",
        'orioledb_version = "B"',
        "",
      ].join("\n"),
    ).pipe(
      Effect.flatMap((dir) => readRef(dir, ref)),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(Option.getOrNull(v.orioledbVersion)).toBe("B");
        }),
      ),
    );
  });

  it.effect("SUPABASE_DB_ORIOLEDB_VERSION beats a matched remote's db.orioledb_version", () => {
    const ref = "abcdefghijklmnopqrst";
    return withConfig(
      [
        "[db]",
        "major_version = 17",
        'orioledb_version = "A"',
        "[remotes.prod]",
        `project_id = "${ref}"`,
        "[remotes.prod.db]",
        'orioledb_version = "B"',
        "",
      ].join("\n"),
    ).pipe(
      Effect.flatMap((dir) => readRef(dir, ref)),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(Option.getOrNull(v.orioledbVersion)).toBe("env-value");
        }),
      ),
      withEnv({ SUPABASE_DB_ORIOLEDB_VERSION: "env-value" }),
    );
  });

  it.effect("warns (does not fail) for an unset S3 env on an OrioleDB project", () => {
    const writes: Array<string> = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stderr.write;
    return withConfig(
      [
        "[db]",
        "major_version = 15",
        'orioledb_version = "15.1.0.55"',
        "[experimental]",
        's3_access_key = "env(S3_KEY)"',
        "",
      ].join("\n"),
    ).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(Option.getOrNull(v.orioledbVersion)).toBe("15.1.0.55");
          expect(writes.join("")).toContain("WARN: environment variable is unset: S3_KEY");
          process.stderr.write = original;
        }),
      ),
      withEnv({}),
    );
  });

  it.effect(
    "warnOnUnresolvedEnv: false suppresses the S3 env WARN (review: Codex, PR #6022)",
    () => {
      // `start`/`db start`'s fresh-volume bootstrap reads this same config.toml more than once
      // per invocation; internal re-reads pass `warnOnUnresolvedEnv: false` so the warning isn't
      // printed a second/third time.
      const writes: Array<string> = [];
      const original = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string | Uint8Array): boolean => {
        writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
        return true;
      }) as typeof process.stderr.write;
      return withConfig(
        [
          "[db]",
          "major_version = 15",
          'orioledb_version = "15.1.0.55"',
          "[experimental]",
          's3_access_key = "env(S3_KEY_QUIET)"',
          "",
        ].join("\n"),
      ).pipe(
        Effect.flatMap((dir) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            return yield* readDbToml(fs, path, dir, undefined, { warnOnUnresolvedEnv: false });
          }),
        ),
        Effect.provide(servicesLive),
        Effect.tap((v) =>
          Effect.sync(() => {
            // Config load still succeeds and still resolves the value; only the
            // stderr WARN side effect is suppressed.
            expect(Option.getOrNull(v.orioledbVersion)).toBe("15.1.0.55");
            expect(writes.join("")).not.toContain("WARN: environment variable is unset");
            process.stderr.write = original;
          }),
        ),
        withEnv({}),
      );
    },
  );

  it.effect("keeps the literal password when its env var is unset/empty", () => {
    return withConfig(["[db]", 'password = "env(DB_UNSET)"', ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.password).toBe("env(DB_UNSET)");
        }),
      ),
      withEnv({}),
    );
  });

  it.effect(
    "fails when a present port is non-numeric, out of range, or an unresolved env()",
    () => {
      const cases = ['port = "abc"', "port = 70000", "port = -1", 'port = "env(DB_UNSET)"'];
      return Effect.forEach(cases, (line) => {
        return withConfig(["[db]", line, ""].join("\n")).pipe(
          Effect.flatMap(read),
          Effect.exit,
          Effect.tap((exit) =>
            Effect.sync(() => {
              expect(Exit.isFailure(exit)).toBe(true);
              if (Exit.isFailure(exit)) {
                expect(Cause.pretty(exit.cause)).toContain("CliConfigValueError");
                expect(Cause.pretty(exit.cause)).toContain("Invalid db.port");
              }
            }),
          ),
        );
      }).pipe(withEnv({}));
    },
  );

  it.effect("fails when a present shadow_port cannot unmarshal into a uint16", () => {
    return withConfig(["[db]", "port = 5000", 'shadow_port = "nope"', ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.pretty(exit.cause)).toContain("Invalid db.shadow_port");
          }
        }),
      ),
    );
  });

  it.effect("resolves env(VAR) from the project supabase/.env file", () => {
    return withConfig(
      ["[db]", 'port = "env(DB_FILEVAR)"', 'password = "env(DB_FILEVAR)"', ""].join("\n"),
    ).pipe(
      Effect.tap((dir) => writeFile(dir, ["supabase", ".env"], "DB_FILEVAR=7000\n")),
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.port).toBe(7000);
          expect(v.password).toBe("7000");
        }),
      ),
      withEnv({}),
    );
  });

  it.effect("lets the shell env win over a project .env value (godotenv no-override)", () => {
    return withConfig(["[db]", 'password = "env(DB_FILEVAR)"', ""].join("\n")).pipe(
      Effect.tap((dir) => writeFile(dir, ["supabase", ".env"], "DB_FILEVAR=from-file\n")),
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.password).toBe("shell-wins");
        }),
      ),
      withEnv({ DB_FILEVAR: "shell-wins" }),
    );
  });

  it.effect("lets supabase/.env win over a repo-root .env", () => {
    return withConfig(["[db]", 'password = "env(DB_FILEVAR)"', ""].join("\n")).pipe(
      Effect.tap((dir) => writeFile(dir, [".env"], "DB_FILEVAR=root\n")),
      Effect.tap((dir) => writeFile(dir, ["supabase", ".env"], "DB_FILEVAR=supabase\n")),
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.password).toBe("supabase");
        }),
      ),
      withEnv({}),
    );
  });

  it.effect("fails when a project .env file is malformed", () => {
    return withConfig(["[db]", "port = 5000", ""].join("\n")).pipe(
      Effect.tap((dir) => writeFile(dir, ["supabase", ".env"], "=novalue\n")),
      Effect.flatMap(read),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.pretty(exit.cause)).toContain("failed to parse environment file");
          }
        }),
      ),
    );
  });

  it.effect("fails when a project .env file exists but cannot be read", () => {
    // A directory at the .env path yields a non-NotFound read error.
    return withConfig(["[db]", "port = 5000", ""].join("\n")).pipe(
      Effect.tap((dir) => makeDir(dir, ["supabase", ".env"])),
      Effect.flatMap(read),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.pretty(exit.cause)).toContain("failed to read environment file");
          }
        }),
      ),
    );
  });

  it.effect("lets SUPABASE_DB_* env vars override the [db] config", () => {
    return withConfig(
      ["[db]", "port = 55555", "shadow_port = 55556", 'password = "hunter2"', ""].join("\n"),
    ).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.port).toBe(6000);
          expect(v.shadowPort).toBe(6001);
          // The password is excluded from SUPABASE_DB_* overrides; it stays the config value.
          expect(v.password).toBe("hunter2");
        }),
      ),
      withEnv({
        SUPABASE_DB_PORT: "6000",
        SUPABASE_DB_SHADOW_PORT: "6001",
        SUPABASE_DB_PASSWORD: "env-override",
      }),
    );
  });

  it.effect("does not source the local password from SUPABASE_DB_PASSWORD", () => {
    return withConfig(["[db]", "port = 5000", ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.password).toBe("postgres");
        }),
      ),
      withEnv({ SUPABASE_DB_PASSWORD: "remote-secret" }),
    );
  });

  it.effect("rejects db.major_version = 0 with the missing-required message", () => {
    return withConfig(["[db]", "major_version = 0", ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.pretty(exit.cause)).toContain(
              "Missing required field in config: db.major_version",
            );
          }
        }),
      ),
    );
  });

  it.effect("rejects db.major_version = 12 with the 12.x message", () => {
    return withConfig(["[db]", "major_version = 12", ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.pretty(exit.cause)).toContain("Postgres version 12.x is unsupported");
          }
        }),
      ),
    );
  });

  it.effect("rejects an unsupported db.major_version with the generic message", () => {
    return withConfig(["[db]", "major_version = 16", ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.pretty(exit.cause)).toContain(
              "Failed reading config: Invalid db.major_version: 16.",
            );
          }
        }),
      ),
    );
  });

  it.effect("accepts a supported db.major_version", () => {
    return withConfig(["[db]", "major_version = 15", ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.majorVersion).toBe(15);
        }),
      ),
    );
  });

  it.effect("rejects a non-integer db.major_version string instead of truncating it", () => {
    return withConfig(["[db]", 'major_version = "17foo"', ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.pretty(exit.cause)).toContain(
              'Invalid db.major_version in supabase/config.toml: "17foo" is not a non-negative integer.',
            );
          }
        }),
      ),
    );
  });

  it.effect("expands env(VAR) for db.major_version", () => {
    return withConfig(["[db]", 'major_version = "env(PG_MAJOR)"', ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.majorVersion).toBe(15);
        }),
      ),
      withEnv({ PG_MAJOR: "15" }),
    );
  });

  it.effect("honors SUPABASE_DB_MAJOR_VERSION over the TOML value", () => {
    return withConfig(["[db]", "major_version = 17", ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.majorVersion).toBe(15);
        }),
      ),
      withEnv({ SUPABASE_DB_MAJOR_VERSION: "15" }),
    );
  });

  it.effect("honors SUPABASE_EDGE_RUNTIME_DENO_VERSION over the TOML value", () => {
    return withConfig(["[edge_runtime]", "deno_version = 2", ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.denoVersion).toBe(1);
        }),
      ),
      withEnv({ SUPABASE_EDGE_RUNTIME_DENO_VERSION: "1" }),
    );
  });

  it.effect("rejects a non-integer edge_runtime.deno_version string instead of defaulting", () => {
    return withConfig(["[edge_runtime]", 'deno_version = "2foo"', ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.pretty(exit.cause)).toContain(
              'Invalid edge_runtime.deno_version in supabase/config.toml: "2foo" is not a non-negative integer.',
            );
          }
        }),
      ),
    );
  });

  it.effect("rejects a malformed [remotes.*] project_id on every load", () => {
    return withConfig(["[remotes.staging]", 'project_id = "staging"', ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.pretty(exit.cause)).toContain(
              "Invalid config for remotes.staging.project_id. Must be like: abcdefghijklmnopqrst",
            );
          }
        }),
      ),
    );
  });

  it.effect("accepts a valid 20-char [remotes.*] project_id", () => {
    return withConfig(
      ["[remotes.staging]", 'project_id = "abcdefghijklmnopqrst"', ""].join("\n"),
    ).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.majorVersion).toBe(17);
        }),
      ),
    );
  });

  it.effect("ignores an empty SUPABASE_DB_PORT override", () => {
    return withConfig(["[db]", "port = 55555", ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.port).toBe(55555);
        }),
      ),
      withEnv({ SUPABASE_DB_PORT: "" }),
    );
  });

  it.effect(
    "loadProjectEnvValues surfaces SUPABASE_DB_PASSWORD from .env (linked-path source)",
    () => {
      // The --linked resolver reads SUPABASE_DB_PASSWORD via this map, so a value
      // defined only in supabase/.env must be visible.
      return withConfig(undefined).pipe(
        Effect.tap((dir) => makeDir(dir, ["supabase"])),
        Effect.tap((dir) =>
          writeFile(dir, ["supabase", ".env"], "SUPABASE_DB_PASSWORD=from-dotenv\n"),
        ),
        Effect.flatMap(loadEnv),
        Effect.tap((env) =>
          Effect.sync(() => {
            expect(env["SUPABASE_DB_PASSWORD"]).toBe("from-dotenv");
          }),
        ),
        withEnv({}),
      );
    },
  );

  it.effect("loadProjectEnvValues is pure: returns every key and never touches process.env", () => {
    // A mere load for SUPABASE_YES has no global side effect.
    const processEnvValues = Effect.forEach(
      ["SUPABASE_INTERNAL_IMAGE_REGISTRY", "SUPABASE_PROJECT_ID", "SUPABASE_ENV"],
      (k) => Config.option(Config.String(k)).parse(ConfigProvider.fromEnv()),
    );
    return Effect.gen(function* () {
      const before = yield* processEnvValues;
      const dir = yield* withConfig(undefined);
      yield* makeDir(dir, ["supabase"]);
      yield* writeFile(
        dir,
        ["supabase", ".env"],
        "SUPABASE_INTERNAL_IMAGE_REGISTRY=my-mirror.example.com\nSUPABASE_PROJECT_ID=envonlyref\nSUPABASE_ENV=staging\n",
      );
      const env = yield* loadEnv(dir).pipe(withEnv({}));
      expect(env["SUPABASE_INTERNAL_IMAGE_REGISTRY"]).toBe("my-mirror.example.com");
      expect(env["SUPABASE_PROJECT_ID"]).toBe("envonlyref");
      expect(env["SUPABASE_ENV"]).toBe("staging");
      // process.env stays untouched, including the allowlisted registry key.
      expect(yield* processEnvValues).toEqual(before);
    });
  });

  it.effect(
    "uses injected config for env selection and excludes ambient keys including empty values",
    () => {
      return withConfig(undefined).pipe(
        Effect.tap((dir) => makeDir(dir, ["supabase"])),
        Effect.tap((dir) =>
          writeFile(
            dir,
            ["supabase", ".env.development"],
            "FROM_AMBIENT=from-file\nDEVELOPMENT_ONLY=from-development\n",
          ),
        ),
        Effect.tap((dir) => writeFile(dir, ["supabase", ".env.staging"], "WRONG_ENV=from-file\n")),
        Effect.flatMap((dir) => loadEnv(dir).pipe(withEnv({ SUPABASE_ENV: "", FROM_AMBIENT: "" }))),
        Effect.tap((env) =>
          Effect.sync(() => {
            expect(env).toEqual({ DEVELOPMENT_ONLY: "from-development" });
          }),
        ),
      );
    },
  );
});

describe("readDbToml [experimental.pgdelta]", () => {
  it.effect("defaults pg-delta to enabled with no config", () => {
    return withConfig(undefined).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.pgDelta.enabled).toBe(true);
          expect(Option.isNone(v.pgDelta.declarativeSchemaPath)).toBe(true);
          expect(Option.isNone(v.pgDelta.formatOptions)).toBe(true);
        }),
      ),
    );
  });

  it.effect("reads enabled / format_options and prefixes a relative schema path", () => {
    return withConfig(
      [
        "[experimental.pgdelta]",
        "enabled = false",
        'declarative_schema_path = "./db/decl"',
        'format_options = "{\\"keywordCase\\":\\"upper\\",\\"indent\\":2}"',
        "",
      ].join("\n"),
    ).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          expect(v.pgDelta.enabled).toBe(false);
          expect(Option.getOrNull(v.pgDelta.declarativeSchemaPath)).toBe(
            path.join("supabase", "db", "decl"),
          );
          expect(Option.getOrNull(v.pgDelta.formatOptions)).toBe(
            '{"keywordCase":"upper","indent":2}',
          );
        }),
      ),
      Effect.provide(BunServices.layer),
    );
  });

  it.effect(
    "keeps an absolute declarative_schema_path and enables pg-delta when enabled is omitted",
    () => {
      return withConfig(
        ["[experimental.pgdelta]", 'declarative_schema_path = "/abs/decl"', ""].join("\n"),
      ).pipe(
        Effect.flatMap(read),
        Effect.tap((v) =>
          Effect.sync(() => {
            expect(v.pgDelta.enabled).toBe(true);
            expect(Option.getOrNull(v.pgDelta.declarativeSchemaPath)).toBe("/abs/decl");
          }),
        ),
      );
    },
  );
});

describe("resolveDeclarativeDir", () => {
  it.effect("uses the default supabase/schemas when no path is configured", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(
        resolveDeclarativeDir(path, {
          enabled: false,
          declarativeSchemaPath: Option.none(),
          formatOptions: Option.none(),
        }),
      ).toBe(path.join("supabase", "schemas"));
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("uses the configured declarative_schema_path when set", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(
        resolveDeclarativeDir(path, {
          enabled: true,
          declarativeSchemaPath: Option.some(path.join("supabase", "db", "decl")),
          formatOptions: Option.none(),
        }),
      ).toBe(path.join("supabase", "db", "decl"));
    }).pipe(Effect.provide(BunServices.layer)),
  );
});

describe("readDbToml auth.Enabled validation", () => {
  // Fails the config load with `message` contained in the surfaced error.
  const failsWith = (
    lines: ReadonlyArray<string>,
    message: string,
    extra?: (dir: string) => Effect.Effect<void, PlatformError>,
  ) =>
    Effect.gen(function* () {
      const dir = yield* withConfig(lines.join("\n"));
      if (extra) yield* extra(dir);
      const exit = yield* read(dir).pipe(Effect.exit);
      expect(Exit.isFailure(exit), `expected failure containing: ${message}`).toBe(true);
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain(message);
    });
  // Loads cleanly — no validation error (the read resolves to a value).
  const succeeds = (lines: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const dir = yield* withConfig(lines.join("\n"));
      const v = yield* read(dir);
      expect(v.baseline).toBeDefined();
    });

  it.effect("rejects an explicit empty auth.site_url", () =>
    failsWith(["[auth]", 'site_url = ""'], "Missing required field in config: auth.site_url"),
  );
  it.effect("defaults an absent auth.site_url — no error", () =>
    succeeds(["[auth]", "enabled = true"]),
  );
  it.effect("skips all auth validation when auth.enabled = false", () =>
    succeeds(["[auth]", "enabled = false", 'site_url = ""', "[auth.passkey]", "enabled = true"]),
  );

  it.effect("rejects an enabled captcha without a provider", () =>
    failsWith(
      ["[auth.captcha]", "enabled = true", 'secret = "x"'],
      "Missing required field in config: auth.captcha.provider",
    ),
  );

  it.effect("rejects passkey enabled without [auth.webauthn]", () =>
    failsWith(
      ["[auth.passkey]", "enabled = true"],
      "Missing required config section: auth.webauthn (required when auth.passkey.enabled is true)",
    ),
  );
  it.effect("rejects passkey enabled with webauthn missing rp_id", () =>
    failsWith(
      ["[auth.passkey]", "enabled = true", "[auth.webauthn]", 'rp_origins = ["http://x"]'],
      "Missing required field in config: auth.webauthn.rp_id",
    ),
  );
  it.effect("rejects passkey enabled with webauthn missing rp_origins", () =>
    failsWith(
      ["[auth.passkey]", "enabled = true", "[auth.webauthn]", 'rp_id = "localhost"'],
      "Missing required field in config: auth.webauthn.rp_origins",
    ),
  );
  it.effect("accepts passkey enabled with a complete [auth.webauthn]", () =>
    succeeds([
      "[auth.passkey]",
      "enabled = true",
      "[auth.webauthn]",
      'rp_id = "localhost"',
      'rp_origins = ["http://localhost:3000"]',
    ]),
  );
  it.effect("accepts a comma-separated rp_origins string instead of rejecting it as missing", () =>
    // Matches `local-config-values.ts`'s own handling of this identical field.
    succeeds([
      "[auth.passkey]",
      "enabled = true",
      "[auth.webauthn]",
      'rp_id = "localhost"',
      'rp_origins = "http://a.example,http://b.example"',
    ]),
  );

  it.effect("rejects an http hook missing secrets", () =>
    failsWith(
      ["[auth.hook.send_email]", "enabled = true", 'uri = "https://example.com/hook"'],
      "Missing required field in config: auth.hook.send_email.secrets",
    ),
  );
  it.effect("rejects an http hook with a badly-formatted secret", () =>
    failsWith(
      [
        "[auth.hook.send_email]",
        "enabled = true",
        'uri = "https://example.com/hook"',
        'secrets = "not-a-valid-secret"',
      ],
      "auth.hook.send_email.secrets must be formatted as",
    ),
  );
  it.effect("rejects a pg-functions hook that sets secrets", () =>
    failsWith(
      [
        "[auth.hook.custom_access_token]",
        "enabled = true",
        'uri = "pg-functions://postgres/public/f"',
        'secrets = "x"',
      ],
      "auth.hook.custom_access_token.secrets is unsupported for pg-functions URI",
    ),
  );
  it.effect("rejects a hook with an unsupported URI scheme", () =>
    failsWith(
      ["[auth.hook.send_sms]", "enabled = true", 'uri = "ftp://example.com"'],
      "auth.hook.send_sms.uri should be a HTTP, HTTPS, or pg-functions URI",
    ),
  );
  it.effect("accepts an http hook with a valid v1,whsec_ secret", () =>
    succeeds([
      "[auth.hook.send_email]",
      "enabled = true",
      'uri = "https://example.com/hook"',
      `secrets = "v1,whsec_${"a".repeat(40)}"`,
    ]),
  );

  it.effect("rejects mfa totp enroll_enabled without verify_enabled", () =>
    failsWith(
      ["[auth.mfa.totp]", "enroll_enabled = true", "verify_enabled = false"],
      "Invalid MFA config: auth.mfa.totp.enroll_enabled requires verify_enabled",
    ),
  );

  it.effect("rejects an enabled smtp without a host", () =>
    failsWith(
      ["[auth.email.smtp]", "enabled = true", "port = 587", 'user = "u"'],
      "Missing required field in config: auth.email.smtp.host",
    ),
  );
  it.effect("rejects an email template with content but no content_path", () =>
    failsWith(
      ["[auth.email.template.invite]", 'content = "<h1>hi</h1>"'],
      "Invalid config for auth.email.template.invite.content: please use content_path instead",
    ),
  );
  it.effect("rejects an email template whose content comes from the shell environment", () =>
    failsWith(
      ["[auth.email.template.invite]", 'subject = "Welcome"'],
      "Invalid config for auth.email.template.invite.content: please use content_path instead",
    ).pipe(withEnv({ SUPABASE_AUTH_EMAIL_TEMPLATE_INVITE_CONTENT: "<h1>hi</h1>" })),
  );
  it.effect("rejects an email template whose content_path file is missing", () =>
    failsWith(
      ["[auth.email.template.invite]", 'content_path = "./missing.html"'],
      "Invalid config for auth.email.template.invite.content_path",
    ),
  );

  it.effect("rejects an enabled twilio sms provider without account_sid", () =>
    failsWith(
      ["[auth.sms.twilio]", "enabled = true"],
      "Missing required field in config: auth.sms.twilio.account_sid",
    ),
  );

  it.effect("rejects an enabled external provider without a client_id", () =>
    failsWith(
      ["[auth.external.github]", "enabled = true"],
      "Missing required field in config: auth.external.github.client_id",
    ),
  );
  it.effect("rejects an enabled custom external provider without a client_id", () =>
    failsWith(
      ["[auth.external.my_oidc]", "enabled = true"],
      "Missing required field in config: auth.external.my_oidc.client_id",
    ),
  );
  it.effect("rejects an enabled custom external provider without a secret", () =>
    failsWith(
      ["[auth.external.my_oidc]", "enabled = true", 'client_id = "cid"'],
      "Missing required field in config: auth.external.my_oidc.secret",
    ),
  );
  it.effect("accepts a custom external provider whose secret comes from the shell", () =>
    succeeds(["[auth.external.my_oidc]", "enabled = true", 'client_id = "cid"']).pipe(
      withEnv({ SUPABASE_AUTH_EXTERNAL_MY_OIDC_SECRET: "shh" }),
    ),
  );
  it.effect("exempts apple/google from the external secret requirement", () =>
    succeeds(["[auth.external.apple]", "enabled = true", 'client_id = "a"']),
  );
  it.effect("rejects the removed linkedin provider, naming linkedin_oidc", () =>
    failsWith(
      ["[auth.external.linkedin]", "enabled = true"],
      "[auth.external.linkedin] in supabase/config.toml is no longer supported. Use [auth.external.linkedin_oidc] instead.",
    ),
  );

  it.effect("rejects an enabled firebase third_party without project_id", () =>
    failsWith(
      ["[auth.third_party.firebase]", "enabled = true"],
      "auth.third_party.firebase is enabled but without a project_id.",
    ),
  );
  it.effect("rejects a clerk third_party with an invalid domain", () =>
    failsWith(
      ["[auth.third_party.clerk]", "enabled = true", 'domain = "not-a-clerk-domain"'],
      "auth.third_party.clerk has invalid domain",
    ),
  );
  it.effect("rejects two enabled third_party providers (mutual exclusivity)", () =>
    failsWith(
      [
        "[auth.third_party.firebase]",
        "enabled = true",
        'project_id = "p"',
        "[auth.third_party.auth0]",
        "enabled = true",
        'tenant = "t"',
      ],
      "Only one third_party provider allowed to be enabled at a time.",
    ),
  );

  it.effect("rejects a signing_keys_path that cannot be read", () =>
    failsWith(["[auth]", 'signing_keys_path = "./missing.json"'], "failed to read signing keys"),
  );
  it.effect("rejects a signing keys file that is not valid JSON", () =>
    failsWith(
      ["[auth]", 'signing_keys_path = "./keys.json"'],
      "failed to decode signing keys: JSON Parse error: Expected '}'",
      // A relative signing_keys_path resolves under supabase/.
      (dir) => writeFile(dir, ["supabase", "keys.json"], "{ not json"),
    ),
  );
  it.effect("rejects a signing keys file that is not a JSON array", () =>
    failsWith(
      ["[auth]", 'signing_keys_path = "./keys.json"'],
      "failed to decode signing keys: signing keys must be a JSON array of JWKs",
      (dir) => writeFile(dir, ["supabase", "keys.json"], "{}"),
    ),
  );

  it.effect("defaults [auth.email.smtp] enabled=true when the table omits enabled", () =>
    failsWith(
      ["[auth.email.smtp]", 'user = "u"'],
      "Missing required field in config: auth.email.smtp.host",
    ),
  );
  it.effect("respects an explicit [auth.email.smtp] enabled=false (no validation)", () =>
    succeeds(["[auth.email.smtp]", "enabled = false", 'user = "u"']),
  );

  it.effect("skips auth validation when SUPABASE_AUTH_ENABLED=false (env override)", () => {
    return withConfig(
      ["[auth]", 'site_url = ""', "[auth.passkey]", "enabled = true"].join("\n"),
    ).pipe(
      Effect.flatMap(read),
      Effect.tap((v) => Effect.sync(() => expect(v.baseline).toBeDefined())),
      withEnv({ SUPABASE_AUTH_ENABLED: "false" }),
    );
  });

  it.effect("fails on a malformed auth boolean string instead of coercing to false", () =>
    failsWith(
      ["[auth.passkey]", 'enabled = "maybe"'],
      "Invalid auth.passkey.enabled in supabase/config.toml",
    ),
  );

  it.effect("rejects an unknown captcha provider, regardless of enabled", () =>
    failsWith(
      ["[auth.captcha]", "enabled = false", 'provider = "cloudflare"'],
      "Invalid auth.captcha.provider in supabase/config.toml",
    ),
  );
});

describe("readDbToml encrypted secret decryption", () => {
  // An undecryptable `encrypted:` value anywhere in config.toml aborts the load with
  // `failed to parse config: <error>`.
  const expectFails = (lines: ReadonlyArray<string>, message: string) =>
    Effect.gen(function* () {
      const dir = yield* withConfig(lines.join("\n"));
      const exit = yield* read(dir).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain(message);
    });
  const expectLoads = (lines: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const dir = yield* withConfig(lines.join("\n"));
      const v = yield* read(dir);
      expect(v.baseline).toBeDefined();
    });

  it.effect("fails on an undecryptable encrypted db.root_key (no private key)", () =>
    expectFails(
      ["[db]", 'root_key = "encrypted:anything"'],
      "failed to parse config: missing private key",
    ),
  );
  it.effect("fails on an undecryptable encrypted secret outside db.vault (auth.external)", () =>
    expectFails(
      [
        "[auth.external.github]",
        "enabled = true",
        'client_id = "x"',
        'secret = "encrypted:anything"',
      ],
      "failed to parse config: missing private key",
    ),
  );
  it.effect("accepts a plain (non-encrypted) secret value", () =>
    expectLoads(["[db]", 'root_key = "plaintext-not-encrypted"']),
  );
  it.effect("treats an unset env() secret as a no-op (verbatim)", () =>
    expectLoads(["[db]", 'root_key = "env(SOME_UNSET_ROOT_KEY)"']),
  );
  it.effect("does NOT decrypt a non-secret string that starts with encrypted:", () =>
    // A non-secret field like an email-template subject stays plain text; the load must not
    // abort on it.
    expectLoads([
      "[auth.email.template.invite]",
      'subject = "encrypted: your invite"',
      "[db]",
      'root_key = "env(SOME_UNSET_ROOT_KEY)"',
    ]),
  );
  it.effect("fails on an undecryptable auth.captcha.secret (Secret-typed field)", () =>
    expectFails(
      [
        "[auth.captcha]",
        "enabled = false",
        'provider = "hcaptcha"',
        'secret = "encrypted:anything"',
      ],
      "failed to parse config: missing private key",
    ),
  );
  it.effect("fails on an undecryptable [edge_runtime.secrets] value (map[string]Secret)", () =>
    expectFails(
      ["[edge_runtime.secrets]", 'MY_SECRET = "encrypted:anything"'],
      "failed to parse config: missing private key",
    ),
  );
  it.effect("fails on an undecryptable Secret inside a [remotes.*] block", () =>
    // Every remote block decodes into the same struct, so an undecryptable secret aborts the
    // load even when unmatched.
    expectFails(
      [
        "[remotes.preview]",
        'project_id = "abcdefghijklmnopqrst"',
        "[remotes.preview.db]",
        'root_key = "encrypted:anything"',
      ],
      "failed to parse config: missing private key",
    ),
  );
});

describe("readDbToml non-scalar config booleans", () => {
  // A present non-scalar boolean must fail the config load rather than falling through to the
  // schema default, which would let `db reset` prompt and drop schemas.
  const failsInvalid = (lines: ReadonlyArray<string>, field: string) =>
    Effect.gen(function* () {
      const dir = yield* withConfig(lines.join("\n"));
      const exit = yield* read(dir).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain(`Invalid ${field} in supabase/config.toml`);
      }
    });
  it.effect("rejects an array value for [db.migrations] enabled", () =>
    failsInvalid(["[db.migrations]", "enabled = []"], "db.migrations.enabled"),
  );
  it.effect("rejects an inline-table value for [db.seed] enabled", () =>
    failsInvalid(["[db.seed]", "enabled = {}"], "db.seed.enabled"),
  );
});

describe("readDbToml project env scoping", () => {
  const LINKED = "linkedlinkedlinkedlin";
  const OTHER = "otherotherotherother";

  const withEnvFile = (config: string, dotEnv: string, linkedRef?: string) =>
    withConfig(config).pipe(
      Effect.tap((dir) => writeFile(dir, ["supabase", ".env"], dotEnv)),
      Effect.tap((dir) =>
        linkedRef === undefined
          ? Effect.void
          : makeDir(dir, ["supabase", ".temp"]).pipe(
              Effect.andThen(writeFile(dir, ["supabase", ".temp", "project-ref"], linkedRef)),
            ),
      ),
    );

  it.effect("omits a linked project's .env credential when targeting another project", () => {
    return withEnvFile(
      'project_id = "demo"\n',
      "SUPABASE_DB_PASSWORD=linked-secret\nUNRELATED=kept\n",
      LINKED,
    ).pipe(
      Effect.flatMap((dir) => readRef(dir, OTHER)),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.projectEnv).toEqual({ UNRELATED: "kept" });
        }),
      ),
    );
  });

  it.effect("keeps the .env credential when targeting the linked project", () => {
    return withEnvFile(
      'project_id = "demo"\n',
      "SUPABASE_DB_PASSWORD=linked-secret\n",
      LINKED,
    ).pipe(
      Effect.flatMap((dir) => readRef(dir, LINKED)),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.projectEnv).toEqual({ SUPABASE_DB_PASSWORD: "linked-secret" });
        }),
      ),
    );
  });

  it.effect("lets an empty shell value shadow the .env value an env() secret refers to", () => {
    return withEnvFile(
      '[db]\nroot_key = "env(SHADOWED_ROOT_KEY)"\n',
      "SHADOWED_ROOT_KEY=encrypted:undecryptable\n",
    ).pipe(Effect.flatMap(read), withEnv({ SHADOWED_ROOT_KEY: "" }));
  });
});

describe("readDbToml empty project_id", () => {
  it.effect("rejects a present-but-empty top-level project_id", () => {
    return withConfig('project_id = ""\n').pipe(
      Effect.flatMap(read),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.pretty(exit.cause)).toContain(
              "Missing required field in config: project_id",
            );
          }
        }),
      ),
    );
  });

  it.effect("still tolerates an absent project_id (deferred broader requirement)", () => {
    return withConfig("[db]\nmajor_version = 15\n").pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.baseline).toBeDefined();
        }),
      ),
    );
  });
});

describe("readDbToml [analytics] validation", () => {
  const failsWith = (lines: ReadonlyArray<string>, message: string) =>
    Effect.gen(function* () {
      const dir = yield* withConfig(lines.join("\n"));
      const exit = yield* read(dir).pipe(Effect.exit);
      expect(Exit.isFailure(exit), `expected failure containing: ${message}`).toBe(true);
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain(message);
    });
  const succeeds = (lines: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const dir = yield* withConfig(lines.join("\n"));
      const v = yield* read(dir);
      expect(v.baseline).toBeDefined();
    });

  it.effect("rejects an unknown analytics.backend regardless of enabled", () =>
    failsWith(
      ["[analytics]", "enabled = false", 'backend = "clickhouse"'],
      "Invalid analytics.backend in supabase/config.toml",
    ),
  );
  it.effect("rejects bigquery analytics missing gcp_project_id", () =>
    failsWith(
      ["[analytics]", "enabled = true", 'backend = "bigquery"'],
      "Missing required field in config: analytics.gcp_project_id",
    ),
  );
  it.effect("rejects bigquery analytics missing gcp_project_number", () =>
    failsWith(
      ["[analytics]", "enabled = true", 'backend = "bigquery"', 'gcp_project_id = "p"'],
      "Missing required field in config: analytics.gcp_project_number",
    ),
  );
  it.effect("rejects bigquery analytics missing gcp_jwt_path", () =>
    failsWith(
      [
        "[analytics]",
        "enabled = true",
        'backend = "bigquery"',
        'gcp_project_id = "p"',
        'gcp_project_number = "123"',
      ],
      "Path to GCP Service Account Key must be provided in config, relative to config.toml: analytics.gcp_jwt_path",
    ),
  );
  it.effect("accepts bigquery analytics with all three gcp fields", () =>
    succeeds([
      "[analytics]",
      "enabled = true",
      'backend = "bigquery"',
      'gcp_project_id = "p"',
      'gcp_project_number = "123"',
      'gcp_jwt_path = "creds.json"',
    ]),
  );
  it.effect("accepts the postgres backend without gcp fields", () =>
    succeeds(["[analytics]", "enabled = true", 'backend = "postgres"']),
  );
  it.effect("accepts an absent [analytics] section (template default enabled+postgres)", () =>
    succeeds(["[db]", "major_version = 17"]),
  );
  it.effect("skips the bigquery gcp checks when analytics is disabled", () =>
    succeeds(["[analytics]", "enabled = false", 'backend = "bigquery"']),
  );
  it.effect("honors SUPABASE_ANALYTICS_BACKEND when validating the bigquery gcp fields", () => {
    return failsWith(
      ["[analytics]", "enabled = true"],
      "Missing required field in config: analytics.gcp_project_id",
    ).pipe(withEnv({ SUPABASE_ANALYTICS_BACKEND: "bigquery" }));
  });
});

describe("readDbToml SUPABASE_PROJECT_ID override", () => {
  it.effect("overrides the TOML project_id with SUPABASE_PROJECT_ID", () => {
    return withConfig(['project_id = "toml-project"', ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.projectId).toBe("env-project");
        }),
      ),
      withEnv({ SUPABASE_PROJECT_ID: "env-project" }),
    );
  });

  it.effect("applies SUPABASE_PROJECT_ID even when config.toml is absent", () => {
    return withConfig(undefined).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.projectId).toBe("env-project");
        }),
      ),
      withEnv({ SUPABASE_PROJECT_ID: "env-project" }),
    );
  });

  it.effect("ignores an empty SUPABASE_PROJECT_ID", () => {
    return withConfig(['project_id = "toml-project"', ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.projectId).toBe("toml-project");
        }),
      ),
      withEnv({ SUPABASE_PROJECT_ID: "" }),
    );
  });

  it.effect("SUPABASE_PROJECT_ID beats a matched [remotes.<ref>]'s project_id", () => {
    const ref = "abcdefghijklmnopqrst";
    return withConfig(
      ['project_id = "toml-project"', "[remotes.prod]", `project_id = "${ref}"`, ""].join("\n"),
    ).pipe(
      Effect.flatMap((dir) => readRef(dir, ref)),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.appliedRemote).toBe("prod");
          expect(v.projectId).toBe("local");
        }),
      ),
      withEnv({ SUPABASE_PROJECT_ID: "local" }),
    );
  });

  it.effect("still applies SUPABASE_PROJECT_ID when no [remotes.*] block matches the ref", () => {
    const ref = "abcdefghijklmnopqrst";
    return withConfig(['project_id = "toml-project"', ""].join("\n")).pipe(
      Effect.flatMap((dir) => readRef(dir, ref)),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.appliedRemote).toBeUndefined();
          expect(v.projectId).toBe("env-project");
        }),
      ),
      withEnv({ SUPABASE_PROJECT_ID: "env-project" }),
    );
  });
});

describe("readDbToml OrioleDB telemetry", () => {
  const recordedAfterRead = (workdir: string) =>
    Effect.gen(function* () {
      const recorded = yield* Ref.make<CommandTelemetryAttributeValues>({});
      yield* read(workdir).pipe(
        Effect.provideService(CommandTelemetryAttributes, {
          record: (values) => Ref.update(recorded, (current) => ({ ...current, ...values })),
        }),
      );
      return yield* Ref.get(recorded);
    });

  it.effect.each([
    {
      name: "a configured version on 17",
      toml: 'major_version = 17\norioledb_version = "17.0.0.1"',
      env: undefined,
      expected: true,
    },
    { name: "the env override", toml: "major_version = 15", env: "15.1.1.14", expected: true },
    { name: "no version", toml: "major_version = 17", env: undefined, expected: false },
  ])("records orioledb=$expected for $name", ({ toml, env, expected }) => {
    return withConfig(`[db]\n${toml}\n`).pipe(
      Effect.flatMap(recordedAfterRead),
      Effect.tap((recorded) => Effect.sync(() => expect(recorded.orioledb).toBe(expected))),
      withEnv(env === undefined ? {} : { SUPABASE_DB_ORIOLEDB_VERSION: env }),
    );
  });
});

describe("readDbToml Data API exposure", () => {
  it.effect.each([
    {
      name: "disabled in config",
      config: '[api]\nenabled = false\nschemas = ["app"]',
      env: { SUPABASE_API_ENABLED: "" },
      expected: [],
    },
    {
      name: "disabled by environment",
      config: "[api]\nenabled = true",
      env: { SUPABASE_API_ENABLED: "false" },
      expected: [],
    },
    {
      name: "trimmed and deduplicated",
      config: '[api]\nschemas = ["app", " public", "app"]',
      env: { SUPABASE_API_ENABLED: "" },
      expected: ["app", "public"],
    },
  ])("resolves exposed schemas: $name", ({ config, env, expected }) =>
    withConfig(config).pipe(
      Effect.flatMap(read),
      Effect.tap((values) => Effect.sync(() => expect(values.exposedSchemas).toEqual(expected))),
      withEnv(env),
    ),
  );
});
