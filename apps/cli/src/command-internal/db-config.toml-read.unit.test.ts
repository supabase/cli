import { BunPath, BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Config, ConfigProvider, Effect, Exit, FileSystem, Option, Path, Ref } from "effect";
import type { PlatformError } from "effect/PlatformError";

import { withEnvVar } from "../../tests/helpers/command-mocks.ts";
import {
  checkDbToml,
  loadProjectEnv,
  readDbToml,
  resolveDeclarativeDir,
  resolveSeedSqlPath,
} from "./db-config.toml-read.ts";
import {
  CommandTelemetryAttributes,
  type CommandTelemetryAttributeValues,
} from "../telemetry/command-telemetry-attributes.ts";

function withConfig(content: string | undefined, poolerUrl?: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "db-toml-" });
    if (content !== undefined) {
      yield* fs.makeDirectory(path.join(dir, "supabase"), { recursive: true });
      yield* fs.writeFileString(path.join(dir, "supabase", "config.toml"), content);
    }
    if (poolerUrl !== undefined) {
      yield* fs.makeDirectory(path.join(dir, "supabase", ".temp"), { recursive: true });
      yield* fs.writeFileString(path.join(dir, "supabase", ".temp", "pooler-url"), poolerUrl);
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

const withEnv = (values: Readonly<Record<string, string>>) =>
  Effect.provideService(
    ConfigProvider.ConfigProvider,
    ConfigProvider.fromEnvRecord(values, { preserveEmptyStrings: true }),
  );

const read = (workdir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* readDbToml(fs, path, workdir);
  }).pipe(Effect.provide(BunServices.layer));

const readRef = (workdir: string, ref: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* readDbToml(fs, path, workdir, ref);
  }).pipe(Effect.provide(BunServices.layer));

const loadEnv = (workdir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* loadProjectEnv(fs, path, workdir);
  }).pipe(Effect.provide(BunServices.layer));

describe("read (lenient) vs check (throws) split", () => {
  const withServices = <A, E>(
    dir: string,
    run: (fs: FileSystem.FileSystem, path: Path.Path) => Effect.Effect<A, E, never>,
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      return yield* run(fs, path);
    }).pipe(Effect.provide(BunServices.layer));

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
          expect(v.projectId).toEqual(Option.some("lenientproj"));
        }),
      ),
    );
  });
});

describe("readDbToml", () => {
  it.effect("returns defaults when config.toml is absent", () => {
    return withConfig(undefined).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.port).toBe(54322);
          expect(v.shadowPort).toBe(54320);
          expect(v.password).toBe("postgres");
          expect(Option.isNone(v.poolerConnectionString)).toBe(true);
          expect(Option.isNone(v.projectId)).toBe(true);
          expect(v.denoVersion).toBe(2);
        }),
      ),
    );
  });

  // A known-good test vector: decrypts to "value" under the keypair below.
  const VAULT_PRIVATE_KEY = "7fd7210cef8f331ee8c55897996aaaafd853a2b20a4dc73d6d75759f65d2a7eb";
  const VAULT_ENCRYPTED =
    "encrypted:BKiXH15AyRzeohGyUrmB6cGjSklCrrBjdesQlX1VcXo/Xp20Bi2gGZ3AlIqxPQDmjVAALnhZamKnuY73l8Dz1P+BYiZUgxTSLzdCvdYUyVbNekj2UudbdUizBViERtZkuQwZHIv/";

  it.effect("decrypts an encrypted: [db.vault] secret when DOTENV_PRIVATE_KEY is set", () => {
    return withEnvVar(
      "DOTENV_PRIVATE_KEY",
      VAULT_PRIVATE_KEY,
      withConfig(["[db.vault]", `my_secret = "${VAULT_ENCRYPTED}"`, ""].join("\n")).pipe(
        Effect.flatMap(read),
        Effect.tap((v) =>
          Effect.sync(() => {
            expect(v.vault).toEqual([{ name: "my_secret", value: "value", resolved: true }]);
          }),
        ),
        withEnv({}),
      ),
    );
  });

  it.effect("fails the load for an encrypted: [db.vault] secret with no private key", () => {
    return withEnvVar(
      "DOTENV_PRIVATE_KEY",
      undefined,
      withConfig(["[db.vault]", `my_secret = "${VAULT_ENCRYPTED}"`, ""].join("\n")).pipe(
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
        withEnv({}),
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

  it.effect("weakly coerces non-string db.seed.sql_paths array elements", () => {
    return withConfig(["[db.seed]", 'sql_paths = [42, true, "seed.sql"]', ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.seed.sqlPaths).toEqual(["supabase/42", "supabase/1", "supabase/seed.sql"]);
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

  it.effect("weakly coerces non-string db.migrations.schema_paths array elements", () => {
    // A bool coerces to "1"/"0" and a number to its decimal string rather than erroring or
    // dropping the element: `schema_paths = [42, true, "schemas/*.sql"]` resolves to
    // `supabase/{42,1,schemas/*.sql}`, not a filtered two-element list.
    return withConfig(
      ["[db.migrations]", 'schema_paths = [42, true, "schemas/*.sql"]', ""].join("\n"),
    ).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.schemaPaths).toEqual(["supabase/42", "supabase/1", "supabase/schemas/*.sql"]);
        }),
      ),
    );
  });

  it.effect(
    "formats a large numeric db.migrations.schema_paths entry as fixed decimal, not scientific notation",
    () => {
      return withConfig(["[db.migrations]", "schema_paths = [1e21]", ""].join("\n")).pipe(
        Effect.flatMap(read),
        Effect.tap((v) =>
          Effect.sync(() => {
            expect(v.schemaPaths).toEqual(["supabase/1000000000000000000000"]);
          }),
        ),
      );
    },
  );

  it.effect(
    "formats TOML special-float db.migrations.schema_paths entries as +Inf/-Inf/NaN, not JS's toString",
    () => {
      return withConfig(["[db.migrations]", "schema_paths = [inf, -inf, nan]", ""].join("\n")).pipe(
        Effect.flatMap(read),
        Effect.tap((v) =>
          Effect.sync(() => {
            expect(v.schemaPaths).toEqual(["supabase/+Inf", "supabase/-Inf", "supabase/NaN"]);
          }),
        ),
      );
    },
  );

  it.effect("weakly coerces a TOP-LEVEL scalar db.migrations.schema_paths", () => {
    return Effect.all([
      withConfig(["[db.migrations]", "schema_paths = 42", ""].join("\n")),
      withConfig(["[db.migrations]", "schema_paths = true", ""].join("\n")),
    ]).pipe(
      Effect.flatMap(([dirNumber, dirBool]) => Effect.all([read(dirNumber), read(dirBool)])),
      Effect.tap(([numberResult, boolResult]) =>
        Effect.sync(() => {
          expect(numberResult.schemaPaths).toEqual(["supabase/42"]);
          expect(boolResult.schemaPaths).toEqual(["supabase/1"]);
        }),
      ),
    );
  });

  it.effect("treats a TOP-LEVEL empty-table db.migrations.schema_paths as no patterns", () => {
    return withConfig(["[db.migrations]", "schema_paths = {}", ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.schemaPaths).toEqual([]);
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
    "aborts the whole config load on a TOP-LEVEL bare $name db.migrations.schema_paths instead of silently treating it as empty",
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

  it.effect(
    "aborts the whole config load on a bare datetime db.migrations.schema_paths ARRAY element",
    () => {
      // Same `TomlDate`-vs-generic-object collision as the top-level scalar case above, but
      // reached through the real-array branch instead of the scalar fallback: the valid glob
      // entry must never mask the datetime's failure.
      return withConfig(
        ["[db.migrations]", 'schema_paths = ["schemas/*.sql", 1979-05-27T07:32:00Z]', ""].join(
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
                "db.migrations.schema_paths[1]: expected a string, got offset date-time",
              );
            }
          }),
        ),
      );
    },
  );

  it.effect(
    "aborts the whole config load on a TOP-LEVEL bare datetime db.seed.sql_paths (same UnmarshalExact call as schema_paths, review CLI-1958)",
    () => {
      return withConfig(["[db.seed]", "sql_paths = 1979-05-27T07:32:00Z", ""].join("\n")).pipe(
        Effect.flatMap(read),
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              expect(Cause.pretty(exit.cause)).toContain(
                "db.seed.sql_paths[0]: expected a string, got offset date-time",
              );
            }
          }),
        ),
      );
    },
  );

  it.effect(
    "aborts the whole config load on a TOP-LEVEL table db.migrations.schema_paths (synthetic index 0)",
    () => {
      // A non-empty map isn't weakly coercible, so it fails decoding element 0 the same way a
      // nested-array/table array element does.
      return withConfig(["[db.migrations.schema_paths]", 'foo = "bar"', ""].join("\n")).pipe(
        Effect.flatMap(read),
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              expect(Cause.pretty(exit.cause)).toContain(
                "db.migrations.schema_paths[0]: expected a string, got table",
              );
            }
          }),
        ),
      );
    },
  );

  it.effect(
    "weakly coerces a TOP-LEVEL scalar db.seed.sql_paths instead of falling back to the ['seed.sql'] default",
    () => {
      // The absent-key default (`["seed.sql"]`) only applies when the key is missing entirely;
      // a present scalar still goes through the weak-decode wrap, same as schema_paths above.
      return withConfig(["[db.seed]", "enabled = true", "sql_paths = 42", ""].join("\n")).pipe(
        Effect.flatMap(read),
        Effect.tap((v) =>
          Effect.sync(() => {
            expect(v.seed.sqlPaths).toEqual(["supabase/42"]);
          }),
        ),
      );
    },
  );

  it.effect(
    "aborts the whole config load on a non-scalar db.migrations.schema_paths element",
    () => {
      // Unlike a bool/number (weakly coerced above), a nested array/table fails the whole
      // config load rather than dropping just that element.
      return withConfig(["[db.migrations]", "schema_paths = [[]]", ""].join("\n")).pipe(
        Effect.flatMap(read),
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              expect(Cause.pretty(exit.cause)).toContain(
                "failed to parse config:\ndb.migrations.schema_paths[0]: expected a string, got array",
              );
            }
          }),
        ),
      );
    },
  );

  it.effect(
    "aborts the whole config load on a table db.migrations.schema_paths element, reporting every bad index",
    () => {
      return withConfig(
        ["[db.migrations]", 'schema_paths = ["schemas/*.sql", { path = "x.sql" }]', ""].join("\n"),
      ).pipe(
        Effect.flatMap(read),
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              expect(Cause.pretty(exit.cause)).toContain(
                "db.migrations.schema_paths[1]: expected a string, got table",
              );
            }
          }),
        ),
      );
    },
  );

  it.effect(
    "aborts the whole config load on a non-scalar db.seed.sql_paths element (same UnmarshalExact call as schema_paths)",
    () => {
      return withConfig(["[db.seed]", "sql_paths = [[]]", ""].join("\n")).pipe(
        Effect.flatMap(read),
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              expect(Cause.pretty(exit.cause)).toContain(
                "db.seed.sql_paths[0]: expected a string, got array",
              );
            }
          }),
        ),
      );
    },
  );

  it.effect(
    "aggregates non-string-entry issues from BOTH db.seed.sql_paths and db.migrations.schema_paths in one error",
    () => {
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
    },
  );

  it.effect(
    "an explicit remote db.migrations.schema_paths beats SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS",
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
            expect(v.schemaPaths).toEqual(["supabase/remote-only.sql"]);
          }),
        ),
        withEnv({ SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS: "env-only.sql" }),
      );
    },
  );

  it.effect("decodes a numeric db.seed.enabled = 0 as false", () => {
    return withConfig(["[db.seed]", "enabled = 0", ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.seed.enabled).toBe(false);
        }),
      ),
    );
  });

  it.effect("decodes a numeric db.migrations.enabled = 0 as false", () => {
    return withConfig(["[db.migrations]", "enabled = 0", ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.migrationsEnabled).toBe(false);
        }),
      ),
    );
  });

  it.effect("decodes a numeric experimental.pgdelta.enabled = 1 as true", () => {
    return withConfig(["[experimental.pgdelta]", "enabled = 1", ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.pgDelta.enabled).toBe(true);
        }),
      ),
    );
  });

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

  it.effect("an explicit remote db.migrations.enabled beats SUPABASE_DB_MIGRATIONS_ENABLED", () => {
    // A matched remote's keys override the environment, so an explicit remote value wins over the env var.
    const ref = "abcdefghijklmnopqrst";
    return withConfig(
      ["[remotes.prod]", `project_id = "${ref}"`, "db.migrations.enabled = true", ""].join("\n"),
    ).pipe(
      Effect.flatMap((dir) => readRef(dir, ref)),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.migrationsEnabled).toBe(true);
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
    "an explicit remote db.migrations.schema_paths beats SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS",
    () => {
      // Same override-tier precedence as db.migrations.enabled above.
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
            expect(v.schemaPaths).toEqual(["supabase/remote-wins.sql"]);
          }),
        ),
        withEnv({ SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS: "env-wins.sql" }),
      );
    },
  );

  it.effect("an explicit remote experimental.pgdelta.enabled beats its SUPABASE_* env var", () => {
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
          expect(v.pgDelta.enabled).toBe(true);
        }),
      ),
      withEnv({ SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED: "false" }),
    );
  });

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

  it.effect("an explicit remote auth.enabled beats its SUPABASE_AUTH_ENABLED env var", () => {
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
          expect(v.baseline.authEnabled).toBe(false);
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
    "an explicit remote experimental.webhooks.enabled beats its SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED env var",
    () => {
      // Without this precedence, the suppressed env value would win, and the merged
      // [experimental.webhooks] section (present via the remote block) would then fail
      // validation ("Webhooks cannot be deactivated").
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
            expect(Exit.isSuccess(exit)).toBe(true);
            if (Exit.isSuccess(exit)) expect(exit.value.webhooksEnabled).toBe(true);
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

  it.effect("a remote block forcing db.seed.enabled=false beats SUPABASE_DB_SEED_ENABLED", () => {
    // A remote block that omits db.seed.enabled stays unseeded even with the env var set.
    const ref = "abcdefghijklmnopqrst";
    return withConfig(["[remotes.prod]", `project_id = "${ref}"`, ""].join("\n")).pipe(
      Effect.flatMap((dir) => readRef(dir, ref)),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.seed.enabled).toBe(false);
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

  it.effect("parses [api] auto_expose_new_tables string with bool tokens (TRUE → true)", () => {
    // `TRUE`/`1`/`t` are also accepted as true, not just lowercase `true`.
    return withConfig('[api]\nauto_expose_new_tables = "TRUE"\n').pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(Option.getOrNull(v.baseline.apiAutoExposeNewTables)).toBe(true);
        }),
      ),
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
            expect(causeText).toContain("DbConfigLoadError");
            expect(causeText).toContain(
              "failed to parse config: invalid api.auto_expose_new_tables.",
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
              "failed to parse config: invalid experimental.pgdelta.enabled: maybe.",
            );
          }
        }),
      ),
      withEnv({ SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED: "maybe" }),
    );
  });

  it.effect("parses [auth] enabled string forms via bool parsing and fails on malformed", () => {
    return Effect.gen(function* () {
      const ok = yield* withConfig(["[auth]", 'enabled = "0"', ""].join("\n"));
      const bad = yield* withConfig(["[storage]", 'enabled = "nope"', ""].join("\n"));
      const v = yield* read(ok);
      expect(v.baseline.authEnabled).toBe(false); // "0" → false
      const exit = yield* read(bad).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain(
          "failed to parse config: invalid storage.enabled.",
        );
      }
    });
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
          expect(Option.isNone(v.poolerConnectionString)).toBe(true);
        }),
      ),
    );
  });

  it.effect("reads db + project_id from config.toml and pooler url from .temp", () => {
    return withConfig(
      [
        'project_id = "my-project"',
        "[db]",
        "port = 55555",
        "shadow_port = 55556",
        'password = "hunter2"',
        "",
      ].join("\n"),
      "postgres://postgres.ref:[YOUR-PASSWORD]@pool:6543/postgres",
    ).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.port).toBe(55555);
          expect(v.shadowPort).toBe(55556);
          expect(v.password).toBe("hunter2");
          expect(Option.getOrNull(v.projectId)).toBe("my-project");
          expect(Option.getOrNull(v.poolerConnectionString)).toContain("postgres.ref");
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
          expect(Option.getOrNull(v.projectId)).toBe("abcdefghijklmnopqrst");
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

  it.effect(
    "falls back to a non-empty legacy experimental.orioledb_version when db.orioledb_version is absent",
    () => {
      return withConfig(
        [
          "[db]",
          "major_version = 17",
          "[experimental]",
          'orioledb_version = "15.1.0.150"',
          "",
        ].join("\n"),
      ).pipe(
        Effect.flatMap(read),
        Effect.tap((v) =>
          Effect.sync(() => {
            expect(Option.getOrNull(v.orioledbVersion)).toBe("15.1.0.150");
          }),
        ),
      );
    },
  );

  it.effect(
    "falls back to a non-empty legacy experimental.orioledb_version when db.orioledb_version is empty",
    () => {
      return withConfig(
        [
          "[db]",
          "major_version = 17",
          'orioledb_version = ""',
          "[experimental]",
          'orioledb_version = "15.1.0.150"',
          "",
        ].join("\n"),
      ).pipe(
        Effect.flatMap(read),
        Effect.tap((v) =>
          Effect.sync(() => {
            expect(Option.getOrNull(v.orioledbVersion)).toBe("15.1.0.150");
          }),
        ),
      );
    },
  );

  it.effect("prefers an explicit db.orioledb_version over a non-empty legacy value", () => {
    return withConfig(
      [
        "[db]",
        "major_version = 17",
        'orioledb_version = "17.0.0.1"',
        "[experimental]",
        'orioledb_version = "15.1.0.150"',
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

  it.effect(
    "a matched remote's legacy experimental.orioledb_version overrides the base db.orioledb_version",
    () => {
      // Matches `@supabase/config`'s loader precedence: each `[remotes.*]` block's own legacy
      // value is promoted before the remote merge, so it can override the base canonical value.
      const ref = "abcdefghijklmnopqrst";
      return withConfig(
        [
          "[db]",
          "major_version = 17",
          'orioledb_version = "A"',
          "[remotes.prod]",
          `project_id = "${ref}"`,
          "[remotes.prod.experimental]",
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
    },
  );

  it.effect(
    "a matched remote's legacy experimental.orioledb_version still beats a conflicting SUPABASE_DB_ORIOLEDB_VERSION",
    () => {
      // Same precedence as any other `ENV_OVERRIDABLE_KEYS` field (e.g. db.major_version):
      // an explicit remote value beats its matching `SUPABASE_*` env override.
      const ref = "abcdefghijklmnopqrst";
      return withConfig(
        [
          "[db]",
          "major_version = 17",
          'orioledb_version = "A"',
          "[remotes.prod]",
          `project_id = "${ref}"`,
          "[remotes.prod.experimental]",
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
        withEnv({ SUPABASE_DB_ORIOLEDB_VERSION: "env-value" }),
      );
    },
  );

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
        Effect.provide(BunServices.layer),
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
                expect(Cause.pretty(exit.cause)).toContain("DbConfigLoadError");
                expect(Cause.pretty(exit.cause)).toContain("invalid db.port");
              }
            }),
          ),
        );
      }).pipe(withEnv({}));
    },
  );

  it.effect("fails when a present shadow_port is not a valid port number", () => {
    return withConfig(["[db]", "port = 5000", 'shadow_port = "nope"', ""].join("\n")).pipe(
      Effect.flatMap(read),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.pretty(exit.cause)).toContain("invalid db.shadow_port");
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

  it.effect("lets the shell env win over a project .env value (no override)", () => {
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
              "Failed reading config: Invalid db.major_version: 17foo.",
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
              "Failed reading config: Invalid edge_runtime.deno_version: 2foo.",
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

  it.effect("loadProjectEnv surfaces SUPABASE_DB_PASSWORD from .env (linked-path source)", () => {
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
  });

  it.effect("loadProjectEnv is pure: returns every key and never touches process.env", () => {
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

  it.effect("ignores a [db.pooler] connection_string in config.toml (only .temp is read)", () => {
    return withConfig(
      [
        "[db.pooler]",
        'connection_string = "postgres://postgres.ref:[YOUR-PASSWORD]@pool:6543/postgres"',
        "",
      ].join("\n"),
    ).pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(Option.isNone(v.poolerConnectionString)).toBe(true);
        }),
      ),
    );
  });

  it.effect("treats an empty .temp/pooler-url as no pooler configured", () => {
    return withConfig(undefined, "").pipe(
      Effect.flatMap(read),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(Option.isNone(v.poolerConnectionString)).toBe(true);
        }),
      ),
    );
  });
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
  it.effect("exempts apple/google from the external secret requirement", () =>
    succeeds(["[auth.external.apple]", "enabled = true", 'client_id = "a"']),
  );
  it.effect("never validates the deprecated linkedin/slack providers", () =>
    succeeds(["[auth.external.linkedin]", "enabled = true"]),
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
      "failed to parse config: invalid auth.passkey.enabled.",
    ),
  );

  it.effect("rejects an unknown captcha provider, regardless of enabled", () =>
    failsWith(
      ["[auth.captcha]", "enabled = false", 'provider = "cloudflare"'],
      "auth.captcha.provider: must be one of hcaptcha, turnstile",
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
        expect(Cause.pretty(exit.cause)).toContain(`failed to parse config: invalid ${field}.`);
      }
    });
  it.effect("rejects an array value for [db.migrations] enabled", () =>
    failsInvalid(["[db.migrations]", "enabled = []"], "db.migrations.enabled"),
  );
  it.effect("rejects an inline-table value for [db.seed] enabled", () =>
    failsInvalid(["[db.seed]", "enabled = {}"], "db.seed.enabled"),
  );
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
      "analytics.backend: must be one of postgres, bigquery",
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
          expect(Option.getOrNull(v.projectId)).toBe("env-project");
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
          expect(Option.getOrNull(v.projectId)).toBe("env-project");
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
          expect(Option.getOrNull(v.projectId)).toBe("toml-project");
        }),
      ),
      withEnv({ SUPABASE_PROJECT_ID: "" }),
    );
  });

  it.effect(
    "prefers a matched [remotes.<ref>]'s project_id over a conflicting SUPABASE_PROJECT_ID",
    () => {
      const ref = "abcdefghijklmnopqrst";
      return withConfig(
        ['project_id = "toml-project"', "[remotes.prod]", `project_id = "${ref}"`, ""].join("\n"),
      ).pipe(
        Effect.flatMap((dir) => readRef(dir, ref)),
        Effect.tap((v) =>
          Effect.sync(() => {
            expect(v.appliedRemote).toBe("prod");
            expect(v.remoteOverrideKeys.has("project_id")).toBe(true);
            expect(Option.getOrNull(v.projectId)).toBe(ref);
          }),
        ),
        withEnv({ SUPABASE_PROJECT_ID: "local" }),
      );
    },
  );

  it.effect("still applies SUPABASE_PROJECT_ID when no [remotes.*] block matches the ref", () => {
    const ref = "abcdefghijklmnopqrst";
    return withConfig(['project_id = "toml-project"', ""].join("\n")).pipe(
      Effect.flatMap((dir) => readRef(dir, ref)),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.appliedRemote).toBeUndefined();
          expect(Option.getOrNull(v.projectId)).toBe("env-project");
        }),
      ),
      withEnv({ SUPABASE_PROJECT_ID: "env-project" }),
    );
  });
});

describe("readDbToml remoteOverrideKeys — auth.captcha.provider / auth.email.template/notification", () => {
  const ref = "abcdefghijklmnopqrst";

  it.effect("tracks auth.captcha.provider when a matched remote block supplies it", () => {
    // `provider` is a plain string leaf, not part of a dynamically-keyed section, so it must be
    // tracked via `ENV_OVERRIDABLE_KEYS` like any other fixed-name field.
    return withConfig(
      [
        "[auth.captcha]",
        'provider = "hcaptcha"',
        "[remotes.prod]",
        `project_id = "${ref}"`,
        "[remotes.prod.auth.captcha]",
        'provider = "turnstile"',
        "",
      ].join("\n"),
    ).pipe(
      Effect.flatMap((dir) => readRef(dir, ref)),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.appliedRemote).toBe("prod");
          expect(v.remoteOverrideKeys.has("auth.captcha.provider")).toBe(true);
        }),
      ),
    );
  });

  it.effect("tracks a matched remote block's auth.email.template.<name> leaves dynamically", () => {
    // `auth.email.template.<name>.*` is an arbitrarily-keyed map, same shape as
    // `auth.external.<name>.*`, so it must be flattened dynamically instead of relying on a
    // fixed `ENV_OVERRIDABLE_KEYS` entry.
    return withConfig(
      [
        "[remotes.prod]",
        `project_id = "${ref}"`,
        "[remotes.prod.auth.email.template.invite]",
        'content_path = "remote-invite.html"',
        "",
      ].join("\n"),
    ).pipe(
      // Template `content_path` resolves relative to the project root (`workdir`, i.e. `dir`).
      Effect.tap((dir) => writeFile(dir, ["remote-invite.html"], "<html></html>")),
      Effect.flatMap((dir) => readRef(dir, ref)),
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.appliedRemote).toBe("prod");
          expect(v.remoteOverrideKeys.has("auth.email.template.invite.content_path")).toBe(true);
          expect(v.remoteOverrideKeys.has("auth.email.template.invite.subject")).toBe(false);
        }),
      ),
    );
  });

  it.effect(
    "tracks a matched remote block's auth.email.notification.<name> leaves dynamically",
    () => {
      // Sibling case to auth.email.template, including a boolean leaf (`enabled`).
      return withConfig(
        [
          "[remotes.prod]",
          `project_id = "${ref}"`,
          "[remotes.prod.auth.email.notification.password_changed]",
          "enabled = true",
          'content_path = "remote-pw-changed.html"',
          "",
        ].join("\n"),
      ).pipe(
        // Notification `content_path` resolves relative to the project root, like a template.
        Effect.tap((dir) => writeFile(dir, ["remote-pw-changed.html"], "<html></html>")),
        Effect.flatMap((dir) => readRef(dir, ref)),
        Effect.tap((v) =>
          Effect.sync(() => {
            expect(v.appliedRemote).toBe("prod");
            expect(
              v.remoteOverrideKeys.has("auth.email.notification.password_changed.enabled"),
            ).toBe(true);
            expect(
              v.remoteOverrideKeys.has("auth.email.notification.password_changed.content_path"),
            ).toBe(true);
            expect(
              v.remoteOverrideKeys.has("auth.email.notification.password_changed.subject"),
            ).toBe(false);
          }),
        ),
      );
    },
  );
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
