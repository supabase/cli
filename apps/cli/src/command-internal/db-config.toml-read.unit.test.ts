import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunPath, BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Option, Path } from "effect";

import {
  applyProjectEnv,
  checkDbToml,
  loadProjectEnv,
  readDbToml,
  resolveDeclarativeDir,
  resolveSeedSqlPath,
} from "./db-config.toml-read.ts";

function withConfig(content: string | undefined, poolerUrl?: string) {
  const dir = mkdtempSync(join(tmpdir(), "db-toml-"));
  if (content !== undefined) {
    mkdirSync(join(dir, "supabase"), { recursive: true });
    writeFileSync(join(dir, "supabase", "config.toml"), content);
  }
  if (poolerUrl !== undefined) {
    mkdirSync(join(dir, "supabase", ".temp"), { recursive: true });
    writeFileSync(join(dir, "supabase", ".temp", "pooler-url"), poolerUrl);
  }
  return dir;
}

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
    const dir = withConfig('[db]\nroot_key = "encrypted:anything"\n');
    return withServices(dir, (fs, path) => checkDbToml(fs, path, dir)).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain(
              "failed to parse config: missing private key",
            );
          }
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("can skip vault resolution without skipping the rest of config validation", () => {
    const dir = withConfig(
      [
        "[db.vault]",
        'local_secret = "encrypted:not-valid"',
        "[remotes.preview]",
        'project_id = "abcdefghijklmnopqrst"',
        "[remotes.preview.db.vault]",
        'remote_secret = "encrypted:not-valid"',
        "",
      ].join("\n"),
    );
    return withServices(dir, (fs, path) =>
      checkDbToml(fs, path, dir, undefined, { resolveVaultSecrets: false }),
    ).pipe(
      Effect.tap((values) =>
        Effect.sync(() => {
          expect(values.vault).toEqual([]);
          expect(values.baseline.vaultNames).toEqual(["local_secret"]);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("readDbToml({ validate: false }) tolerates the same secret, returning defaults", () => {
    const dir = withConfig('[db]\nroot_key = "encrypted:anything"\n');
    return withServices(dir, (fs, path) =>
      readDbToml(fs, path, dir, undefined, { validate: false }),
    ).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.vault).toEqual([]);
          expect(v.port).toBeGreaterThan(0);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("readDbToml({ validate: false }) still returns a valid config's values", () => {
    const dir = withConfig('project_id = "lenientproj"\n');
    return withServices(dir, (fs, path) =>
      readDbToml(fs, path, dir, undefined, { validate: false }),
    ).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.projectId).toEqual(Option.some("lenientproj"));
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });
});

describe("readDbToml", () => {
  it.effect("returns defaults when config.toml is absent", () => {
    const dir = withConfig(undefined);
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.port).toBe(54322);
          expect(v.shadowPort).toBe(54320);
          expect(v.password).toBe("postgres");
          expect(Option.isNone(v.poolerConnectionString)).toBe(true);
          expect(Option.isNone(v.projectId)).toBe(true);
          expect(v.denoVersion).toBe(2);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  // A known-good test vector: decrypts to "value" under the keypair below.
  const VAULT_PRIVATE_KEY = "7fd7210cef8f331ee8c55897996aaaafd853a2b20a4dc73d6d75759f65d2a7eb";
  const VAULT_ENCRYPTED =
    "encrypted:BKiXH15AyRzeohGyUrmB6cGjSklCrrBjdesQlX1VcXo/Xp20Bi2gGZ3AlIqxPQDmjVAALnhZamKnuY73l8Dz1P+BYiZUgxTSLzdCvdYUyVbNekj2UudbdUizBViERtZkuQwZHIv/";

  it.effect("decrypts an encrypted: [db.vault] secret when DOTENV_PRIVATE_KEY is set", () => {
    const previous = process.env["DOTENV_PRIVATE_KEY"];
    process.env["DOTENV_PRIVATE_KEY"] = VAULT_PRIVATE_KEY;
    const dir = withConfig(["[db.vault]", `my_secret = "${VAULT_ENCRYPTED}"`, ""].join("\n"));
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.vault).toEqual([{ name: "my_secret", value: "value", resolved: true }]);
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (previous === undefined) delete process.env["DOTENV_PRIVATE_KEY"];
          else process.env["DOTENV_PRIVATE_KEY"] = previous;
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("fails the load for an encrypted: [db.vault] secret with no private key", () => {
    const previous = process.env["DOTENV_PRIVATE_KEY"];
    delete process.env["DOTENV_PRIVATE_KEY"];
    const dir = withConfig(["[db.vault]", `my_secret = "${VAULT_ENCRYPTED}"`, ""].join("\n"));
    return read(dir).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain(
              "failed to parse config: missing private key",
            );
          }
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (previous !== undefined) process.env["DOTENV_PRIVATE_KEY"] = previous;
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("collapses. and .. in relative seed sql_paths like Go's path.Join", () => {
    const dir = withConfig(
      ["[db.seed]", 'sql_paths = ["../seed.sql", "sub/../other.sql", "./plain.sql"]', ""].join(
        "\n",
      ),
    );
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.seed.sqlPaths).toEqual(["seed.sql", "supabase/other.sql", "supabase/plain.sql"]);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("honors SUPABASE_DB_SEED_SQL_PATHS over the TOML array (comma split, no trim)", () => {
    const previous = process.env["SUPABASE_DB_SEED_SQL_PATHS"];
    process.env["SUPABASE_DB_SEED_SQL_PATHS"] = "a.sql, b.sql";
    const dir = withConfig(["[db.seed]", 'sql_paths = ["ignored.sql"]', ""].join("\n"));
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.seed.sqlPaths).toEqual(["supabase/a.sql", "supabase/ b.sql"]);
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (previous === undefined) delete process.env["SUPABASE_DB_SEED_SQL_PATHS"];
          else process.env["SUPABASE_DB_SEED_SQL_PATHS"] = previous;
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("decodes a STRING db.seed.sql_paths via StringToSliceHookFunc (comma, no trim)", () => {
    const dir = withConfig(["[db.seed]", 'sql_paths = "a.sql,b.sql"', ""].join("\n"));
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.seed.sqlPaths).toEqual(["supabase/a.sql", "supabase/b.sql"]);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("treats an empty-string db.seed.sql_paths as no patterns (Go []string{})", () => {
    const dir = withConfig(["[db.seed]", 'sql_paths = ""', ""].join("\n"));
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.seed.sqlPaths).toEqual([]);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect(
    "expands env() before splitting a string sql_paths (LoadEnv before StringToSlice)",
    () => {
      const previous = process.env["SEEDS"];
      process.env["SEEDS"] = "a.sql,b.sql";
      const dir = withConfig(["[db.seed]", 'sql_paths = "env(SEEDS)"', ""].join("\n"));
      return read(dir).pipe(
        Effect.tap((v) =>
          Effect.sync(() => {
            expect(v.seed.sqlPaths).toEqual(["supabase/a.sql", "supabase/b.sql"]);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env["SEEDS"];
            else process.env["SEEDS"] = previous;
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect("expands an env() array element but does NOT split it (Go array asymmetry)", () => {
    const previous = process.env["SEEDS"];
    process.env["SEEDS"] = "a.sql,b.sql";
    const dir = withConfig(["[db.seed]", 'sql_paths = ["env(SEEDS)"]', ""].join("\n"));
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.seed.sqlPaths).toEqual(["supabase/a.sql,b.sql"]);
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (previous === undefined) delete process.env["SEEDS"];
          else process.env["SEEDS"] = previous;
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect(
    "weakly coerces non-string db.seed.sql_paths array elements (Go mapstructure parity)",
    () => {
      const dir = withConfig(["[db.seed]", 'sql_paths = [42, true, "seed.sql"]', ""].join("\n"));
      return read(dir).pipe(
        Effect.tap((v) =>
          Effect.sync(() => {
            expect(v.seed.sqlPaths).toEqual(["supabase/42", "supabase/1", "supabase/seed.sql"]);
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect(
    "honors SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS over the TOML array (comma split, no trim)",
    () => {
      const previous = process.env["SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS"];
      process.env["SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS"] = "a.sql, b.sql";
      const dir = withConfig(["[db.migrations]", 'schema_paths = ["ignored.sql"]', ""].join("\n"));
      return read(dir).pipe(
        Effect.tap((v) =>
          Effect.sync(() => {
            expect(v.schemaPaths).toEqual(["supabase/a.sql", "supabase/ b.sql"]);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env["SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS"];
            else process.env["SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS"] = previous;
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect(
    "decodes a STRING db.migrations.schema_paths via StringToSliceHookFunc (comma, no trim)",
    () => {
      const dir = withConfig(["[db.migrations]", 'schema_paths = "a.sql,b.sql"', ""].join("\n"));
      return read(dir).pipe(
        Effect.tap((v) =>
          Effect.sync(() => {
            expect(v.schemaPaths).toEqual(["supabase/a.sql", "supabase/b.sql"]);
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect(
    "on Windows, resolves a leading-slash schema/seed path pattern under supabase/ instead of treating it as absolute (Go filepath.IsAbs parity)",
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

  it.effect(
    "weakly coerces non-string db.migrations.schema_paths array elements (Go mapstructure parity)",
    () => {
      // `v.UnmarshalExact` never sets `WeaklyTypedInput: false`, so viper's
      // `defaultDecoderConfig` default of `true` stands — mapstructure's `decodeString`
      // coerces a bool to "1"/"0" and a number to its decimal string rather than
      // erroring or dropping the element. Verified empirically:
      // `schema_paths = [42, true, "schemas/*.sql"]` resolves to
      // `supabase/{42,1,schemas/*.sql}`, not a filtered two-element list.
      const dir = withConfig(
        ["[db.migrations]", 'schema_paths = [42, true, "schemas/*.sql"]', ""].join("\n"),
      );
      return read(dir).pipe(
        Effect.tap((v) =>
          Effect.sync(() => {
            expect(v.schemaPaths).toEqual(["supabase/42", "supabase/1", "supabase/schemas/*.sql"]);
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect(
    "formats a large numeric db.migrations.schema_paths entry as fixed decimal, not scientific notation (Go strconv.FormatFloat parity)",
    () => {
      const dir = withConfig(["[db.migrations]", "schema_paths = [1e21]", ""].join("\n"));
      return read(dir).pipe(
        Effect.tap((v) =>
          Effect.sync(() => {
            expect(v.schemaPaths).toEqual(["supabase/1000000000000000000000"]);
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect(
    "formats TOML special-float db.migrations.schema_paths entries like Go's strconv.FormatFloat, not JS's toString (Go parity)",
    () => {
      const dir = withConfig(["[db.migrations]", "schema_paths = [inf, -inf, nan]", ""].join("\n"));
      return read(dir).pipe(
        Effect.tap((v) =>
          Effect.sync(() => {
            expect(v.schemaPaths).toEqual(["supabase/+Inf", "supabase/-Inf", "supabase/NaN"]);
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect(
    "weakly coerces a TOP-LEVEL scalar db.migrations.schema_paths (Go mapstructure weak-decode of a []string field)",
    () => {
      const dirNumber = withConfig(["[db.migrations]", "schema_paths = 42", ""].join("\n"));
      const dirBool = withConfig(["[db.migrations]", "schema_paths = true", ""].join("\n"));
      return Effect.all([read(dirNumber), read(dirBool)]).pipe(
        Effect.tap(([numberResult, boolResult]) =>
          Effect.sync(() => {
            expect(numberResult.schemaPaths).toEqual(["supabase/42"]);
            expect(boolResult.schemaPaths).toEqual(["supabase/1"]);
            rmSync(dirNumber, { recursive: true, force: true });
            rmSync(dirBool, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect(
    "treats a TOP-LEVEL empty-table db.migrations.schema_paths as no patterns (Go mapstructure zero-length-map special case)",
    () => {
      const dir = withConfig(["[db.migrations]", "schema_paths = {}", ""].join("\n"));
      return read(dir).pipe(
        Effect.tap((v) =>
          Effect.sync(() => {
            expect(v.schemaPaths).toEqual([]);
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect.each([
    { name: "offset date-time", literal: "1979-05-27T07:32:00Z", goType: "time.Time" },
    { name: "local date-time", literal: "1979-05-27T07:32:00", goType: "toml.LocalDateTime" },
    { name: "local date", literal: "1979-05-27", goType: "toml.LocalDate" },
    { name: "local time", literal: "07:32:00", goType: "toml.LocalTime" },
  ])(
    "aborts the whole config load on a TOP-LEVEL bare $name db.migrations.schema_paths instead of silently treating it as empty (Go mapstructure UnconvertibleTypeError, review CLI-1958)",
    ({ literal, goType }) => {
      // `smol-toml` parses every TOML datetime variant to a `TomlDate` (a `Date` subclass)
      // that stores its value internally, not as an enumerable own property, so
      // `Object.keys(tomlDate).length === 0` — same as a genuine empty inline table
      // (`schema_paths = {}`, tested above). `TomlDate` must be excluded from that
      // zero-length-map special case, or this would silently resolve to `[]` instead of
      // aborting.
      const dir = withConfig(["[db.migrations]", `schema_paths = ${literal}`, ""].join("\n"));
      return read(dir).pipe(
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              expect(JSON.stringify(exit.cause)).toContain(
                `'db.migrations.schema_paths[0]' expected type 'string', got unconvertible type '${goType}'`,
              );
            }
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect(
    "aborts the whole config load on a bare datetime db.migrations.schema_paths ARRAY element (Go mapstructure UnconvertibleTypeError, review CLI-1958)",
    () => {
      // Same `TomlDate`-vs-generic-object collision as the top-level scalar case above, but
      // reached through the real-array branch instead of the scalar fallback: the valid glob
      // entry must never mask the datetime's failure.
      const dir = withConfig(
        ["[db.migrations]", 'schema_paths = ["schemas/*.sql", 1979-05-27T07:32:00Z]', ""].join(
          "\n",
        ),
      );
      return read(dir).pipe(
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              expect(JSON.stringify(exit.cause)).toContain(
                "'db.migrations.schema_paths[1]' expected type 'string', got unconvertible type 'time.Time'",
              );
            }
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect(
    "aborts the whole config load on a TOP-LEVEL bare datetime db.seed.sql_paths (same UnmarshalExact call as schema_paths, review CLI-1958)",
    () => {
      const dir = withConfig(["[db.seed]", "sql_paths = 1979-05-27T07:32:00Z", ""].join("\n"));
      return read(dir).pipe(
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              expect(JSON.stringify(exit.cause)).toContain(
                "'db.seed.sql_paths[0]' expected type 'string', got unconvertible type 'time.Time'",
              );
            }
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect(
    "aborts the whole config load on a TOP-LEVEL table db.migrations.schema_paths (Go mapstructure UnconvertibleTypeError, synthetic index 0)",
    () => {
      // A non-empty map isn't weakly coercible, so it fails decoding element 0 the same way a
      // nested-array/table array element does.
      const dir = withConfig(["[db.migrations.schema_paths]", 'foo = "bar"', ""].join("\n"));
      return read(dir).pipe(
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              expect(JSON.stringify(exit.cause)).toContain(
                "'db.migrations.schema_paths[0]' expected type 'string', got unconvertible type 'map[string]interface {}'",
              );
            }
            rmSync(dir, { recursive: true, force: true });
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
      const dir = withConfig(["[db.seed]", "enabled = true", "sql_paths = 42", ""].join("\n"));
      return read(dir).pipe(
        Effect.tap((v) =>
          Effect.sync(() => {
            expect(v.seed.sqlPaths).toEqual(["supabase/42"]);
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect(
    "aborts the whole config load on a non-scalar db.migrations.schema_paths element (Go mapstructure UnconvertibleTypeError)",
    () => {
      // Unlike a bool/number (weakly coerced above), a nested array/table fails the whole
      // config load rather than dropping just that element.
      const dir = withConfig(["[db.migrations]", "schema_paths = [[]]", ""].join("\n"));
      return read(dir).pipe(
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              expect(JSON.stringify(exit.cause)).toContain(
                "failed to parse config: decoding failed due to the following error(s):\\n\\n'db.migrations.schema_paths[0]' expected type 'string', got unconvertible type '[]interface {}'",
              );
            }
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect(
    "aborts the whole config load on a table db.migrations.schema_paths element, reporting every bad index (Go mapstructure parity)",
    () => {
      const dir = withConfig(
        ["[db.migrations]", 'schema_paths = ["schemas/*.sql", { path = "x.sql" }]', ""].join("\n"),
      );
      return read(dir).pipe(
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              expect(JSON.stringify(exit.cause)).toContain(
                "'db.migrations.schema_paths[1]' expected type 'string', got unconvertible type 'map[string]interface {}'",
              );
            }
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect(
    "aborts the whole config load on a non-scalar db.seed.sql_paths element (same UnmarshalExact call as schema_paths)",
    () => {
      const dir = withConfig(["[db.seed]", "sql_paths = [[]]", ""].join("\n"));
      return read(dir).pipe(
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              expect(JSON.stringify(exit.cause)).toContain(
                "'db.seed.sql_paths[0]' expected type 'string', got unconvertible type '[]interface {}'",
              );
            }
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect(
    "aggregates unconvertible-entry issues from BOTH db.seed.sql_paths and db.migrations.schema_paths in one error (Go UnmarshalExact single-pass parity, review CLI-1958)",
    () => {
      const dir = withConfig(
        ["[db.seed]", "sql_paths = [[]]", "", "[db.migrations]", "schema_paths = [[]]", ""].join(
          "\n",
        ),
      );
      return read(dir).pipe(
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              const message = JSON.stringify(exit.cause);
              const schemaIssue =
                "'db.migrations.schema_paths[0]' expected type 'string', got unconvertible type '[]interface {}'";
              const seedIssue =
                "'db.seed.sql_paths[0]' expected type 'string', got unconvertible type '[]interface {}'";
              expect(message).toContain(schemaIssue);
              expect(message).toContain(seedIssue);
              expect(message.indexOf(schemaIssue)).toBeLessThan(message.indexOf(seedIssue));
            }
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect(
    "an explicit remote db.migrations.schema_paths beats SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS",
    () => {
      const ref = "schmschmschmschmschm";
      const previous = process.env["SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS"];
      process.env["SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS"] = "env-only.sql";
      const dir = withConfig(
        [
          "[remotes.prod]",
          `project_id = "${ref}"`,
          'db.migrations.schema_paths = ["remote-only.sql"]',
          "",
        ].join("\n"),
      );
      return readRef(dir, ref).pipe(
        Effect.tap((v) =>
          Effect.sync(() => {
            expect(v.schemaPaths).toEqual(["supabase/remote-only.sql"]);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env["SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS"];
            else process.env["SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS"] = previous;
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect("decodes a numeric db.seed.enabled = 0 as false (Go weak-bool decode)", () => {
    const dir = withConfig(["[db.seed]", "enabled = 0", ""].join("\n"));
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.seed.enabled).toBe(false);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("decodes a numeric db.migrations.enabled = 0 as false", () => {
    const dir = withConfig(["[db.migrations]", "enabled = 0", ""].join("\n"));
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.migrationsEnabled).toBe(false);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect(
    "decodes a numeric experimental.pgdelta.enabled = 1 as true (Go weak-bool decode)",
    () => {
      const dir = withConfig(["[experimental.pgdelta]", "enabled = 1", ""].join("\n"));
      return read(dir).pipe(
        Effect.tap((v) =>
          Effect.sync(() => {
            expect(v.pgDelta.enabled).toBe(true);
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect("rejects an explicit db.port = 0 (Go's Missing required field)", () => {
    const dir = withConfig(["[db]", "port = 0", ""].join("\n"));
    return read(dir).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain(
              "Missing required field in config: db.port",
            );
          }
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("an explicit remote db.migrations.enabled beats SUPABASE_DB_MIGRATIONS_ENABLED", () => {
    // Go applies each matched-remote key via v.Set (override tier) above AutomaticEnv,
    // so an explicit remote value wins over the env var.
    const ref = "abcdefghijklmnopqrst";
    const previous = process.env["SUPABASE_DB_MIGRATIONS_ENABLED"];
    process.env["SUPABASE_DB_MIGRATIONS_ENABLED"] = "false";
    const dir = withConfig(
      ["[remotes.prod]", `project_id = "${ref}"`, "db.migrations.enabled = true", ""].join("\n"),
    );
    return readRef(dir, ref).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.migrationsEnabled).toBe(true);
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (previous === undefined) delete process.env["SUPABASE_DB_MIGRATIONS_ENABLED"];
          else process.env["SUPABASE_DB_MIGRATIONS_ENABLED"] = previous;
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("SUPABASE_DB_MIGRATIONS_ENABLED still wins when the remote block omits it", () => {
    const ref = "abcdefghijklmnopqrst";
    const previous = process.env["SUPABASE_DB_MIGRATIONS_ENABLED"];
    process.env["SUPABASE_DB_MIGRATIONS_ENABLED"] = "false";
    const dir = withConfig(["[remotes.prod]", `project_id = "${ref}"`, ""].join("\n"));
    return readRef(dir, ref).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.migrationsEnabled).toBe(false);
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (previous === undefined) delete process.env["SUPABASE_DB_MIGRATIONS_ENABLED"];
          else process.env["SUPABASE_DB_MIGRATIONS_ENABLED"] = previous;
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("collapses. and .. in relative db.migrations.schema_paths like Go's path.Join", () => {
    const dir = withConfig(
      [
        "[db.migrations]",
        'schema_paths = ["../schema.sql", "sub/../other.sql", "./schemas/a.sql"]',
        "",
      ].join("\n"),
    );
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.schemaPaths).toEqual([
            "schema.sql",
            "supabase/other.sql",
            "supabase/schemas/a.sql",
          ]);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect(
    "honors SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS over the TOML array (comma split, no trim)",
    () => {
      const previous = process.env["SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS"];
      process.env["SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS"] = "a.sql, b.sql";
      const dir = withConfig(["[db.migrations]", 'schema_paths = ["ignored.sql"]', ""].join("\n"));
      return read(dir).pipe(
        Effect.tap((v) =>
          Effect.sync(() => {
            expect(v.schemaPaths).toEqual(["supabase/a.sql", "supabase/ b.sql"]);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env["SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS"];
            else process.env["SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS"] = previous;
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect("defaults db.migrations.schema_paths to [] when absent (Go's Glob zero value)", () => {
    const dir = withConfig(["[db]", "port = 54322", ""].join("\n"));
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.schemaPaths).toEqual([]);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect(
    "an explicit remote db.migrations.schema_paths beats SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS",
    () => {
      // Same override-tier precedence as db.migrations.enabled above.
      const ref = "abcdefghijklmnopqrst";
      const previous = process.env["SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS"];
      process.env["SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS"] = "env-wins.sql";
      const dir = withConfig(
        [
          "[remotes.prod]",
          `project_id = "${ref}"`,
          "[remotes.prod.db.migrations]",
          'schema_paths = ["remote-wins.sql"]',
          "",
        ].join("\n"),
      );
      return readRef(dir, ref).pipe(
        Effect.tap((v) =>
          Effect.sync(() => {
            expect(v.schemaPaths).toEqual(["supabase/remote-wins.sql"]);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env["SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS"];
            else process.env["SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS"] = previous;
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect("an explicit remote experimental.pgdelta.enabled beats its SUPABASE_* env var", () => {
    const ref = "abcdefghijklmnopqrst";
    const previous = process.env["SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED"];
    process.env["SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED"] = "false";
    const dir = withConfig(
      [
        "[remotes.prod]",
        `project_id = "${ref}"`,
        "[remotes.prod.experimental.pgdelta]",
        "enabled = true",
        "",
      ].join("\n"),
    );
    return readRef(dir, ref).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.pgDelta.enabled).toBe(true);
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (previous === undefined) delete process.env["SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED"];
          else process.env["SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED"] = previous;
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED still wins when the block omits pgdelta", () => {
    const ref = "abcdefghijklmnopqrst";
    const previous = process.env["SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED"];
    process.env["SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED"] = "true";
    const dir = withConfig(["[remotes.prod]", `project_id = "${ref}"`, ""].join("\n"));
    return readRef(dir, ref).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.pgDelta.enabled).toBe(true);
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (previous === undefined) delete process.env["SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED"];
          else process.env["SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED"] = previous;
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("an explicit remote auth.enabled beats its SUPABASE_AUTH_ENABLED env var", () => {
    const ref = "abcdefghijklmnopqrst";
    const previous = process.env["SUPABASE_AUTH_ENABLED"];
    process.env["SUPABASE_AUTH_ENABLED"] = "true";
    const dir = withConfig(
      [
        "[remotes.prod]",
        `project_id = "${ref}"`,
        "[remotes.prod.auth]",
        "enabled = false",
        "",
      ].join("\n"),
    );
    return readRef(dir, ref).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.baseline.authEnabled).toBe(false);
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (previous === undefined) delete process.env["SUPABASE_AUTH_ENABLED"];
          else process.env["SUPABASE_AUTH_ENABLED"] = previous;
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("SUPABASE_AUTH_ENABLED still wins when the remote block omits auth.enabled", () => {
    const ref = "abcdefghijklmnopqrst";
    const previous = process.env["SUPABASE_AUTH_ENABLED"];
    process.env["SUPABASE_AUTH_ENABLED"] = "false";
    const dir = withConfig(["[remotes.prod]", `project_id = "${ref}"`, ""].join("\n"));
    return readRef(dir, ref).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.baseline.authEnabled).toBe(false);
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (previous === undefined) delete process.env["SUPABASE_AUTH_ENABLED"];
          else process.env["SUPABASE_AUTH_ENABLED"] = previous;
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect(
    "an explicit remote experimental.webhooks.enabled beats its SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED env var",
    () => {
      // Without this precedence, the suppressed env value would win, and the merged
      // [experimental.webhooks] section (present via the remote block) would then fail
      // validation ("Webhooks cannot be deactivated").
      const ref = "abcdefghijklmnopqrst";
      const previous = process.env["SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED"];
      process.env["SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED"] = "false";
      const dir = withConfig(
        [
          "[remotes.prod]",
          `project_id = "${ref}"`,
          "[remotes.prod.experimental.webhooks]",
          "enabled = true",
          "",
        ].join("\n"),
      );
      return readRef(dir, ref).pipe(
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            expect(Exit.isSuccess(exit)).toBe(true);
            if (Exit.isSuccess(exit)) expect(exit.value.webhooksEnabled).toBe(true);
            if (previous === undefined)
              delete process.env["SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED"];
            else process.env["SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED"] = previous;
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect(
    "SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED still wins when the remote block omits webhooks",
    () => {
      // A base [experimental.webhooks] section (present, default true) flipped off by the env
      // var still fails the "cannot be deactivated" validation.
      const ref = "abcdefghijklmnopqrst";
      const previous = process.env["SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED"];
      process.env["SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED"] = "false";
      const dir = withConfig(
        [
          "[experimental.webhooks]",
          "enabled = true",
          "[remotes.prod]",
          `project_id = "${ref}"`,
          "",
        ].join("\n"),
      );
      return readRef(dir, ref).pipe(
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              expect(JSON.stringify(exit.cause)).toContain("Webhooks cannot be deactivated");
            }
            if (previous === undefined)
              delete process.env["SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED"];
            else process.env["SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED"] = previous;
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect(
    "ignores a malformed SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED when [experimental.webhooks] is absent",
    () => {
      // The env override only applies when [experimental.webhooks] is declared (unlike
      // experimental.pgdelta.enabled, always known via defaults); a malformed value must not
      // fail the whole config load when the section is absent.
      const previous = process.env["SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED"];
      process.env["SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED"] = "bogus";
      const dir = withConfig("");
      return read(dir).pipe(
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            expect(Exit.isSuccess(exit)).toBe(true);
            if (Exit.isSuccess(exit)) expect(exit.value.webhooksEnabled).toBe(false);
            if (previous === undefined)
              delete process.env["SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED"];
            else process.env["SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED"] = previous;
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect("matches a remote block by a SUPABASE_REMOTES_<NAME>_PROJECT_ID env override", () => {
    // The env override alone is enough to match the block, with no TOML project_id at all.
    const ref = "abcdefghijklmnopqrst";
    const previous = process.env["SUPABASE_REMOTES_PROD_PROJECT_ID"];
    process.env["SUPABASE_REMOTES_PROD_PROJECT_ID"] = ref;
    const dir = withConfig(["[remotes.prod]", "db.major_version = 15", ""].join("\n"));
    return readRef(dir, ref).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.majorVersion).toBe(15);
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (previous === undefined) delete process.env["SUPABASE_REMOTES_PROD_PROJECT_ID"];
          else process.env["SUPABASE_REMOTES_PROD_PROJECT_ID"] = previous;
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("validates a remote project_id supplied only via env (no TOML literal)", () => {
    // Without the env value, the block (no TOML project_id) would fail validation.
    const ref = "abcdefghijklmnopqrst";
    const previous = process.env["SUPABASE_REMOTES_PROD_PROJECT_ID"];
    process.env["SUPABASE_REMOTES_PROD_PROJECT_ID"] = ref;
    const dir = withConfig(["[remotes.prod]", "db.major_version = 15", ""].join("\n"));
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          // read() without a ref leaves the base major_version default (17) since the block
          // isn't merged.
          expect(v.majorVersion).toBe(17);
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (previous === undefined) delete process.env["SUPABASE_REMOTES_PROD_PROJECT_ID"];
          else process.env["SUPABASE_REMOTES_PROD_PROJECT_ID"] = previous;
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("a remote block forcing db.seed.enabled=false beats SUPABASE_DB_SEED_ENABLED", () => {
    // A remote block that omits db.seed.enabled stays unseeded even with the env var set.
    const ref = "abcdefghijklmnopqrst";
    const previous = process.env["SUPABASE_DB_SEED_ENABLED"];
    process.env["SUPABASE_DB_SEED_ENABLED"] = "true";
    const dir = withConfig(["[remotes.prod]", `project_id = "${ref}"`, ""].join("\n"));
    return readRef(dir, ref).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.seed.enabled).toBe(false);
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (previous === undefined) delete process.env["SUPABASE_DB_SEED_ENABLED"];
          else process.env["SUPABASE_DB_SEED_ENABLED"] = previous;
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("SUPABASE_DB_SEED_ENABLED still wins on the local path (no remote force)", () => {
    const previous = process.env["SUPABASE_DB_SEED_ENABLED"];
    process.env["SUPABASE_DB_SEED_ENABLED"] = "false";
    const dir = withConfig(["[db.seed]", "enabled = true", ""].join("\n"));
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.seed.enabled).toBe(false);
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (previous === undefined) delete process.env["SUPABASE_DB_SEED_ENABLED"];
          else process.env["SUPABASE_DB_SEED_ENABLED"] = previous;
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("reads [edge_runtime] deno_version = 1 (selects the deno1 image)", () => {
    const dir = withConfig(["[edge_runtime]", "deno_version = 1", ""].join("\n"));
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.denoVersion).toBe(1);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("defaults deno_version to 2 when [edge_runtime] omits it", () => {
    const dir = withConfig(["[edge_runtime]", 'policy = "per_worker"', ""].join("\n"));
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.denoVersion).toBe(2);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("fails with DbConfigLoadError when config.toml is malformed", () => {
    const dir = withConfig("[db]\nport = [unterminated");
    return read(dir).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain("DbConfigLoadError");
          }
          rmSync(dir, { recursive: true, force: true });
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
      const dir = withConfig(REMOTE_CONFIG);
      return readRef(dir, "prodprodprodprodprod").pipe(
        Effect.tap((v) =>
          Effect.sync(() => {
            // db.major_version overridden by [remotes.production.db]; password kept from base.
            expect(v.majorVersion).toBe(17);
            expect(v.password).toBe("base-pw");
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    });

    it.effect("ignores the remote block when no ref is passed (local/db-url parity)", () => {
      const dir = withConfig(REMOTE_CONFIG);
      return read(dir).pipe(
        Effect.tap((v) =>
          Effect.sync(() => {
            expect(v.majorVersion).toBe(15);
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    });

    it.effect("ignores the remote block when the ref does not match any project_id", () => {
      const dir = withConfig(REMOTE_CONFIG);
      return readRef(dir, "otherotherotherother").pipe(
        Effect.tap((v) =>
          Effect.sync(() => {
            expect(v.majorVersion).toBe(15);
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    });

    it.effect("forces db.seed.enabled false when the matched remote block omits it", () => {
      const dir = withConfig(
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
      );
      return readRef(dir, "prodprodprodprodprod").pipe(
        Effect.tap((v) =>
          Effect.sync(() => {
            expect(v.seed.enabled).toBe(false);
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    });

    it.effect("keeps db.seed.enabled true when the matched remote block sets it explicitly", () => {
      const dir = withConfig(
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
      );
      return readRef(dir, "prodprodprodprodprod").pipe(
        Effect.tap((v) =>
          Effect.sync(() => {
            expect(v.seed.enabled).toBe(true);
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    });

    it.effect("rejects two remote blocks with the same project_id (any command)", () => {
      const dir = withConfig(
        [
          "[remotes.a]",
          'project_id = "dupdupdupdupdupdupdup0"',
          "[remotes.b]",
          'project_id = "dupdupdupdupdupdupdup0"',
          "",
        ].join("\n"),
      );
      return read(dir).pipe(
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              expect(JSON.stringify(exit.cause)).toContain("duplicate project_id for [remotes.b]");
            }
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    });
  });

  it.effect("rejects an invalid [edge_runtime] deno_version", () => {
    // Valid values are 1 and 2.
    const dir = withConfig(["[edge_runtime]", "deno_version = 3", ""].join("\n"));
    return read(dir).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain(
              "Failed reading config: Invalid edge_runtime.deno_version: 3.",
            );
          }
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("rejects deno_version = 0 with Go's missing-required message", () => {
    const dir = withConfig(["[edge_runtime]", "deno_version = 0", ""].join("\n"));
    return read(dir).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain(
              "Missing required field in config: edge_runtime.deno_version",
            );
          }
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("accepts deno_version = 1", () => {
    const dir = withConfig(["[edge_runtime]", "deno_version = 1", ""].join("\n"));
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.denoVersion).toBe(1);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("rejects invalid [experimental.pgdelta] format_options JSON during load", () => {
    const dir = withConfig('[experimental.pgdelta]\nformat_options = "not-json"\n');
    return read(dir).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const json = JSON.stringify(exit.cause);
            expect(json).toContain("DbConfigLoadError");
            expect(json).toContain(
              "Invalid config for experimental.pgdelta.format_options: must be valid JSON",
            );
          }
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("accepts valid [experimental.pgdelta] format_options JSON", () => {
    const dir = withConfig(
      '[experimental.pgdelta]\nformat_options = "{\\"keywordCase\\":\\"upper\\"}"\n',
    );
    return read(dir).pipe(
      Effect.tap(() => Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
    );
  });

  it.effect("rejects an invalid [storage.buckets.<name>] during load", () => {
    // `#` is outside the allowed bucket-name characters, so this name is rejected.
    const dir = withConfig('[storage.buckets."bad#name"]\n');
    return read(dir).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const json = JSON.stringify(exit.cause);
            expect(json).toContain("DbConfigLoadError");
            // Prose part is backslash-free, so safe to assert through JSON.stringify.
            expect(json).toContain(
              "Invalid Bucket name: bad#name. Only lowercase letters, numbers, dots, hyphens, and spaces are allowed.",
            );
          }
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("rejects an invalid [functions.<slug>] during load", () => {
    // `123` starts with a digit, rejected by `^[A-Za-z][A-Za-z0-9_-]*$`.
    const dir = withConfig("[functions.123]\n");
    return read(dir).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const json = JSON.stringify(exit.cause);
            expect(json).toContain("DbConfigLoadError");
            expect(json).toContain(
              "Invalid Function name: 123. Must start with at least one letter, and only include alphanumeric characters, underscores, and hyphens.",
            );
          }
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("accepts a valid [functions.<slug>] (letters, digits, _ and -)", () => {
    const dir = withConfig("[functions.my-function]\n[functions.function_1]\n");
    return read(dir).pipe(
      Effect.tap(() => Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
    );
  });

  it.effect("accepts an underscore bucket name like Go's permissive pattern", () => {
    // The bucket-name pattern uses `\w` (includes `_`) and is not case-restricted despite the
    // prose, so `Bad_Name` actually passes: match the regex, not the message text.
    const dir = withConfig("[storage.buckets.Bad_Name]\n");
    return read(dir).pipe(
      Effect.tap(() => Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
    );
  });

  it.effect("rejects an unparseable [storage.buckets.<name>].file_size_limit during load", () => {
    // A malformed value must fail config load itself, not only later inside `seedBucketsRun`,
    // where it would go unvalidated on a reused-volume restart or the already-running
    // short-circuit.
    const dir = withConfig('[storage.buckets.avatars]\nfile_size_limit = "bogus"\n');
    return read(dir).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const json = JSON.stringify(exit.cause);
            expect(json).toContain("DbConfigLoadError");
            expect(json).toContain("invalid storage.buckets.avatars.file_size_limit");
          }
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("accepts a bare-number [storage.buckets.<name>].file_size_limit", () => {
    // `@supabase/config`'s schema allows file_size_limit as either a quoted
    // human-readable string or a bare byte count; the numeric form must normalize to
    // a string before `ramInBytes` parses it rather than being rejected outright.
    const dir = withConfig("[storage.buckets.avatars]\nfile_size_limit = 5242880\n");
    return read(dir).pipe(
      Effect.tap(() => Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
    );
  });

  it.effect("parses [api] auto_expose_new_tables string with Go bool tokens (TRUE → true)", () => {
    // `TRUE`/`1`/`t` are also accepted as true, not just lowercase `true`.
    const dir = withConfig('[api]\nauto_expose_new_tables = "TRUE"\n');
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(Option.getOrNull(v.baseline.apiAutoExposeNewTables)).toBe(true);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("decodes empty api schemas while keeping auto_expose_new_tables absent", () => {
    const dir = withConfig('[api]\nschemas = ""\n');
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.apiSchemas).toEqual([]);
          expect(Option.isNone(v.baseline.apiAutoExposeNewTables)).toBe(true);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("rejects a malformed [api] auto_expose_new_tables during load", () => {
    const dir = withConfig('[api]\nauto_expose_new_tables = "maybe"\n');
    return read(dir).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const json = JSON.stringify(exit.cause);
            expect(json).toContain("DbConfigLoadError");
            expect(json).toContain("failed to parse config: invalid api.auto_expose_new_tables.");
          }
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("honors SUPABASE_API_AUTO_EXPOSE_NEW_TABLES env override (AutomaticEnv)", () => {
    const dir = withConfig("[api]\nauto_expose_new_tables = false\n");
    const saved = process.env["SUPABASE_API_AUTO_EXPOSE_NEW_TABLES"];
    process.env["SUPABASE_API_AUTO_EXPOSE_NEW_TABLES"] = "1";
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(Option.getOrNull(v.baseline.apiAutoExposeNewTables)).toBe(true);
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (saved === undefined) delete process.env["SUPABASE_API_AUTO_EXPOSE_NEW_TABLES"];
          else process.env["SUPABASE_API_AUTO_EXPOSE_NEW_TABLES"] = saved;
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("honors SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED / _DECLARATIVE_SCHEMA_PATH env", () => {
    const dir = withConfig(undefined);
    const savedEnabled = process.env["SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED"];
    const savedPath = process.env["SUPABASE_EXPERIMENTAL_PGDELTA_DECLARATIVE_SCHEMA_PATH"];
    process.env["SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED"] = "true";
    process.env["SUPABASE_EXPERIMENTAL_PGDELTA_DECLARATIVE_SCHEMA_PATH"] = "from_env";
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.pgDelta.enabled).toBe(true);
          expect(Option.getOrNull(v.pgDelta.declarativeSchemaPath)).toBe("supabase/from_env");
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (savedEnabled === undefined)
            delete process.env["SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED"];
          else process.env["SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED"] = savedEnabled;
          if (savedPath === undefined)
            delete process.env["SUPABASE_EXPERIMENTAL_PGDELTA_DECLARATIVE_SCHEMA_PATH"];
          else process.env["SUPABASE_EXPERIMENTAL_PGDELTA_DECLARATIVE_SCHEMA_PATH"] = savedPath;
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("expands an env() indirection in the PGDELTA_DECLARATIVE_SCHEMA_PATH override", () => {
    const dir = withConfig(undefined);
    const savedEnabled = process.env["SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED"];
    const savedPath = process.env["SUPABASE_EXPERIMENTAL_PGDELTA_DECLARATIVE_SCHEMA_PATH"];
    const savedDir = process.env["SCHEMA_DIR"];
    process.env["SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED"] = "true";
    process.env["SUPABASE_EXPERIMENTAL_PGDELTA_DECLARATIVE_SCHEMA_PATH"] = "env(SCHEMA_DIR)";
    process.env["SCHEMA_DIR"] = "schemas";
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(Option.getOrNull(v.pgDelta.declarativeSchemaPath)).toBe("supabase/schemas");
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (savedEnabled === undefined)
            delete process.env["SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED"];
          else process.env["SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED"] = savedEnabled;
          if (savedPath === undefined)
            delete process.env["SUPABASE_EXPERIMENTAL_PGDELTA_DECLARATIVE_SCHEMA_PATH"];
          else process.env["SUPABASE_EXPERIMENTAL_PGDELTA_DECLARATIVE_SCHEMA_PATH"] = savedPath;
          if (savedDir === undefined) delete process.env["SCHEMA_DIR"];
          else process.env["SCHEMA_DIR"] = savedDir;
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("treats SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED=1 as true (Go strconv.ParseBool)", () => {
    const dir = withConfig(undefined);
    const saved = process.env["SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED"];
    process.env["SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED"] = "1";
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.pgDelta.enabled).toBe(true);
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (saved === undefined) delete process.env["SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED"];
          else process.env["SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED"] = saved;
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("fails on a malformed SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED (Go config error)", () => {
    const dir = withConfig(undefined);
    const saved = process.env["SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED"];
    process.env["SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED"] = "maybe";
    return read(dir).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain(
              "failed to parse config: invalid experimental.pgdelta.enabled: maybe.",
            );
          }
          if (saved === undefined) delete process.env["SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED"];
          else process.env["SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED"] = saved;
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("parses [auth] enabled string forms via Go ParseBool and fails on malformed", () => {
    const ok = withConfig(["[auth]", 'enabled = "0"', ""].join("\n"));
    const bad = withConfig(["[storage]", 'enabled = "nope"', ""].join("\n"));
    return Effect.gen(function* () {
      const v = yield* read(ok);
      expect(v.baseline.authEnabled).toBe(false); // "0" → false (ParseBool)
      const exit = yield* read(bad).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain(
          "failed to parse config: invalid storage.enabled.",
        );
      }
      rmSync(ok, { recursive: true, force: true });
      rmSync(bad, { recursive: true, force: true });
    });
  });

  it.effect("fails with DbConfigLoadError when config.toml is present but unreadable", () => {
    // A directory at the config.toml path yields a non-NotFound read error.
    const dir = mkdtempSync(join(tmpdir(), "db-toml-"));
    mkdirSync(join(dir, "supabase", "config.toml"), { recursive: true });
    return read(dir).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain("DbConfigLoadError");
            expect(JSON.stringify(exit.cause)).toContain("failed to read file config");
          }
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("falls back to the default password when [db] omits it", () => {
    const dir = withConfig(["[db]", "port = 5000", ""].join("\n"));
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.port).toBe(5000);
          expect(v.password).toBe("postgres");
          expect(Option.isNone(v.poolerConnectionString)).toBe(true);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("reads db + project_id from config.toml and pooler url from .temp", () => {
    const dir = withConfig(
      [
        'project_id = "my-project"',
        "[db]",
        "port = 55555",
        "shadow_port = 55556",
        'password = "hunter2"',
        "",
      ].join("\n"),
      "postgres://postgres.ref:[YOUR-PASSWORD]@pool:6543/postgres",
    );
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.port).toBe(55555);
          expect(v.shadowPort).toBe(55556);
          expect(v.password).toBe("hunter2");
          expect(Option.getOrNull(v.projectId)).toBe("my-project");
          expect(Option.getOrNull(v.poolerConnectionString)).toContain("postgres.ref");
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("expands env(VAR) for password and port like Go's LoadEnvHook", () => {
    process.env["DB_PW"] = "from-env";
    process.env["DB_PORT"] = "6000";
    const dir = withConfig(
      ["[db]", 'port = "env(DB_PORT)"', 'password = "env(DB_PW)"', ""].join("\n"),
    );
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.port).toBe(6000);
          expect(v.password).toBe("from-env");
          delete process.env["DB_PW"];
          delete process.env["DB_PORT"];
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("expands env(VAR) in db.seed.sql_paths entries before supabase-prefixing", () => {
    process.env["SEED_SQL"] = "custom/data.sql";
    const dir = withConfig(["[db.seed]", 'sql_paths = ["env(SEED_SQL)"]', ""].join("\n"));
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.seed.sqlPaths).toEqual(["supabase/custom/data.sql"]);
          delete process.env["SEED_SQL"];
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("honors SUPABASE_DB_SEED_ENABLED over the TOML value (Go AutomaticEnv)", () => {
    process.env["SUPABASE_DB_SEED_ENABLED"] = "false";
    const dir = withConfig(["[db.seed]", "enabled = true", ""].join("\n"));
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.seed.enabled).toBe(false);
          delete process.env["SUPABASE_DB_SEED_ENABLED"];
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("expands an env() indirection in SUPABASE_DB_SEED_ENABLED (Go LoadEnvHook)", () => {
    process.env["SUPABASE_DB_SEED_ENABLED"] = "env(SEED_ON)";
    process.env["SEED_ON"] = "false";
    const dir = withConfig(["[db.seed]", "enabled = true", ""].join("\n"));
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.seed.enabled).toBe(false);
          delete process.env["SUPABASE_DB_SEED_ENABLED"];
          delete process.env["SEED_ON"];
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("honors SUPABASE_DB_MIGRATIONS_ENABLED over the default (Go AutomaticEnv)", () => {
    process.env["SUPABASE_DB_MIGRATIONS_ENABLED"] = "false";
    const dir = withConfig(undefined);
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.migrationsEnabled).toBe(false);
          delete process.env["SUPABASE_DB_MIGRATIONS_ENABLED"];
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("fails the load on a malformed SUPABASE_DB_SEED_ENABLED override", () => {
    process.env["SUPABASE_DB_SEED_ENABLED"] = "notabool";
    const dir = withConfig(undefined);
    return read(dir).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          delete process.env["SUPABASE_DB_SEED_ENABLED"];
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect(
    "expands env(VAR) for the top-level project_id (Go config.Load before Docker IDs)",
    () => {
      process.env["PROJECT_REF"] = "abcdefghijklmnopqrst";
      const dir = withConfig(['project_id = "env(PROJECT_REF)"', ""].join("\n"));
      return read(dir).pipe(
        Effect.tap((v) =>
          Effect.sync(() => {
            expect(Option.getOrNull(v.projectId)).toBe("abcdefghijklmnopqrst");
            delete process.env["PROJECT_REF"];
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect("does not merge a remote block whose project_id is a TOML env() literal", () => {
    // Remote matching happens on the raw `env(...)` literal, before expansion, so this block is
    // never selected by its expanded ref (major_version stays the base 15) even though
    // validation over the expanded field still passes.
    process.env["STAGING_REF"] = "stagingrefstagingref";
    const dir = withConfig(
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
    );
    return readRef(dir, "stagingrefstagingref").pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.majorVersion).toBe(15);
          delete process.env["STAGING_REF"];
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("rejects an env-backed remote project_id that expands to nothing", () => {
    delete process.env["MISSING_REF"];
    const dir = withConfig(["[remotes.staging]", 'project_id = "env(MISSING_REF)"', ""].join("\n"));
    return read(dir).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain(
              "Invalid config for remotes.staging.project_id",
            );
          }
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("parses experimental.orioledb_version (env-expanded) on a 15/17 project", () => {
    process.env["ORIOLE_VER"] = "16.0.0.1";
    const dir = withConfig(
      [
        "[db]",
        "major_version = 17",
        "[experimental]",
        'orioledb_version = "env(ORIOLE_VER)"',
        's3_host = "s3.example.com"',
        's3_region = "us-east-1"',
        's3_access_key = "key"',
        's3_secret_key = "secret"',
        "",
      ].join("\n"),
    );
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(Option.getOrNull(v.orioledbVersion)).toBe("16.0.0.1");
          delete process.env["ORIOLE_VER"];
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("warns (does not fail) for an unset S3 env on an OrioleDB project", () => {
    delete process.env["S3_KEY"];
    const writes: Array<string> = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stderr.write;
    const dir = withConfig(
      [
        "[db]",
        "major_version = 15",
        "[experimental]",
        'orioledb_version = "15.1.0.55"',
        's3_access_key = "env(S3_KEY)"',
        "",
      ].join("\n"),
    );
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(Option.getOrNull(v.orioledbVersion)).toBe("15.1.0.55");
          expect(writes.join("")).toContain("WARN: environment variable is unset: S3_KEY");
          process.stderr.write = original;
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect(
    "warnOnUnresolvedEnv: false suppresses the S3 env WARN (review: Codex, PR #6022)",
    () => {
      // `start`/`db start`'s fresh-volume bootstrap reads this same config.toml more than once
      // per invocation; internal re-reads pass `warnOnUnresolvedEnv: false` so the warning isn't
      // printed a second/third time.
      delete process.env["S3_KEY_QUIET"];
      const writes: Array<string> = [];
      const original = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string | Uint8Array): boolean => {
        writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
        return true;
      }) as typeof process.stderr.write;
      const dir = withConfig(
        [
          "[db]",
          "major_version = 15",
          "[experimental]",
          'orioledb_version = "15.1.0.55"',
          's3_access_key = "env(S3_KEY_QUIET)"',
          "",
        ].join("\n"),
      );
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        return yield* readDbToml(fs, path, dir, undefined, { warnOnUnresolvedEnv: false });
      }).pipe(
        Effect.provide(BunServices.layer),
        Effect.tap((v) =>
          Effect.sync(() => {
            // Config load still succeeds and still resolves the value; only the
            // stderr WARN side effect is suppressed.
            expect(Option.getOrNull(v.orioledbVersion)).toBe("15.1.0.55");
            expect(writes.join("")).not.toContain("WARN: environment variable is unset");
            process.stderr.write = original;
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect("keeps the literal password when its env var is unset/empty", () => {
    delete process.env["DB_UNSET"];
    const dir = withConfig(["[db]", 'password = "env(DB_UNSET)"', ""].join("\n"));
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.password).toBe("env(DB_UNSET)");
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect(
    "fails when a present port is non-numeric, out of range, or an unresolved env()",
    () => {
      delete process.env["DB_UNSET"];
      const cases = ['port = "abc"', "port = 70000", "port = -1", 'port = "env(DB_UNSET)"'];
      return Effect.forEach(cases, (line) => {
        const dir = withConfig(["[db]", line, ""].join("\n"));
        return read(dir).pipe(
          Effect.exit,
          Effect.tap((exit) =>
            Effect.sync(() => {
              expect(Exit.isFailure(exit)).toBe(true);
              if (Exit.isFailure(exit)) {
                expect(JSON.stringify(exit.cause)).toContain("DbConfigLoadError");
                expect(JSON.stringify(exit.cause)).toContain("invalid db.port");
              }
              rmSync(dir, { recursive: true, force: true });
            }),
          ),
        );
      });
    },
  );

  it.effect("fails when a present shadow_port cannot unmarshal into a uint16", () => {
    const dir = withConfig(["[db]", "port = 5000", 'shadow_port = "nope"', ""].join("\n"));
    return read(dir).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain("invalid db.shadow_port");
          }
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("resolves env(VAR) from the project supabase/.env file (Go loadNestedEnv)", () => {
    delete process.env["DB_FILEVAR"];
    const dir = withConfig(
      ["[db]", 'port = "env(DB_FILEVAR)"', 'password = "env(DB_FILEVAR)"', ""].join("\n"),
    );
    writeFileSync(join(dir, "supabase", ".env"), "DB_FILEVAR=7000\n");
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.port).toBe(7000);
          expect(v.password).toBe("7000");
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("lets the shell env win over a project .env value (godotenv no-override)", () => {
    process.env["DB_FILEVAR"] = "shell-wins";
    const dir = withConfig(["[db]", 'password = "env(DB_FILEVAR)"', ""].join("\n"));
    writeFileSync(join(dir, "supabase", ".env"), "DB_FILEVAR=from-file\n");
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.password).toBe("shell-wins");
          delete process.env["DB_FILEVAR"];
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("lets supabase/.env win over a repo-root .env (Go walks supabase/ first)", () => {
    delete process.env["DB_FILEVAR"];
    const dir = withConfig(["[db]", 'password = "env(DB_FILEVAR)"', ""].join("\n"));
    writeFileSync(join(dir, ".env"), "DB_FILEVAR=root\n");
    writeFileSync(join(dir, "supabase", ".env"), "DB_FILEVAR=supabase\n");
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.password).toBe("supabase");
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("fails when a project .env file is malformed", () => {
    const dir = withConfig(["[db]", "port = 5000", ""].join("\n"));
    writeFileSync(join(dir, "supabase", ".env"), "=novalue\n");
    return read(dir).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain("failed to parse environment file");
          }
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("fails when a project .env file exists but cannot be read", () => {
    // A directory at the .env path yields a non-NotFound read error.
    const dir = withConfig(["[db]", "port = 5000", ""].join("\n"));
    mkdirSync(join(dir, "supabase", ".env"), { recursive: true });
    return read(dir).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain("failed to read environment file");
          }
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("lets SUPABASE_DB_* env vars override the [db] config (viper AutomaticEnv)", () => {
    const prev = {
      PORT: process.env["SUPABASE_DB_PORT"],
      SHADOW: process.env["SUPABASE_DB_SHADOW_PORT"],
      PW: process.env["SUPABASE_DB_PASSWORD"],
    };
    process.env["SUPABASE_DB_PORT"] = "6000";
    process.env["SUPABASE_DB_SHADOW_PORT"] = "6001";
    process.env["SUPABASE_DB_PASSWORD"] = "env-override";
    const dir = withConfig(
      ["[db]", "port = 55555", "shadow_port = 55556", 'password = "hunter2"', ""].join("\n"),
    );
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.port).toBe(6000);
          expect(v.shadowPort).toBe(6001);
          // The password is excluded from SUPABASE_DB_* overrides; it stays the config value.
          expect(v.password).toBe("hunter2");
          for (const [k, val] of Object.entries({
            SUPABASE_DB_PORT: prev.PORT,
            SUPABASE_DB_SHADOW_PORT: prev.SHADOW,
            SUPABASE_DB_PASSWORD: prev.PW,
          })) {
            if (val === undefined) delete process.env[k];
            else process.env[k] = val;
          }
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("does not source the local password from SUPABASE_DB_PASSWORD", () => {
    const prev = process.env["SUPABASE_DB_PASSWORD"];
    process.env["SUPABASE_DB_PASSWORD"] = "remote-secret";
    const dir = withConfig(["[db]", "port = 5000", ""].join("\n"));
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.password).toBe("postgres");
          if (prev === undefined) delete process.env["SUPABASE_DB_PASSWORD"];
          else process.env["SUPABASE_DB_PASSWORD"] = prev;
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("rejects db.major_version = 0 with Go's missing-required message", () => {
    const dir = withConfig(["[db]", "major_version = 0", ""].join("\n"));
    return read(dir).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain(
              "Missing required field in config: db.major_version",
            );
          }
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("rejects db.major_version = 12 with Go's 12.x message", () => {
    const dir = withConfig(["[db]", "major_version = 12", ""].join("\n"));
    return read(dir).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain("Postgres version 12.x is unsupported");
          }
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("rejects an unsupported db.major_version with the generic message", () => {
    const dir = withConfig(["[db]", "major_version = 16", ""].join("\n"));
    return read(dir).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain(
              "Failed reading config: Invalid db.major_version: 16.",
            );
          }
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("accepts a supported db.major_version", () => {
    const dir = withConfig(["[db]", "major_version = 15", ""].join("\n"));
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.majorVersion).toBe(15);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("rejects a non-integer db.major_version string instead of truncating it", () => {
    const dir = withConfig(["[db]", 'major_version = "17foo"', ""].join("\n"));
    return read(dir).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain(
              "Failed reading config: Invalid db.major_version: 17foo.",
            );
          }
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("expands env(VAR) for db.major_version like Go's LoadEnvHook", () => {
    process.env["PG_MAJOR"] = "15";
    const dir = withConfig(["[db]", 'major_version = "env(PG_MAJOR)"', ""].join("\n"));
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.majorVersion).toBe(15);
          delete process.env["PG_MAJOR"];
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("honors SUPABASE_DB_MAJOR_VERSION over the TOML value", () => {
    const prev = process.env["SUPABASE_DB_MAJOR_VERSION"];
    process.env["SUPABASE_DB_MAJOR_VERSION"] = "15";
    const dir = withConfig(["[db]", "major_version = 17", ""].join("\n"));
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.majorVersion).toBe(15);
          if (prev === undefined) delete process.env["SUPABASE_DB_MAJOR_VERSION"];
          else process.env["SUPABASE_DB_MAJOR_VERSION"] = prev;
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("honors SUPABASE_EDGE_RUNTIME_DENO_VERSION over the TOML value", () => {
    const prev = process.env["SUPABASE_EDGE_RUNTIME_DENO_VERSION"];
    process.env["SUPABASE_EDGE_RUNTIME_DENO_VERSION"] = "1";
    const dir = withConfig(["[edge_runtime]", "deno_version = 2", ""].join("\n"));
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.denoVersion).toBe(1);
          if (prev === undefined) delete process.env["SUPABASE_EDGE_RUNTIME_DENO_VERSION"];
          else process.env["SUPABASE_EDGE_RUNTIME_DENO_VERSION"] = prev;
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("rejects a non-integer edge_runtime.deno_version string instead of defaulting", () => {
    const dir = withConfig(["[edge_runtime]", 'deno_version = "2foo"', ""].join("\n"));
    return read(dir).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain(
              "Failed reading config: Invalid edge_runtime.deno_version: 2foo.",
            );
          }
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("rejects a malformed [remotes.*] project_id on every load (Go Validate)", () => {
    const dir = withConfig(["[remotes.staging]", 'project_id = "staging"', ""].join("\n"));
    return read(dir).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain(
              "Invalid config for remotes.staging.project_id. Must be like: abcdefghijklmnopqrst",
            );
          }
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("accepts a valid 20-char [remotes.*] project_id", () => {
    const dir = withConfig(
      ["[remotes.staging]", 'project_id = "abcdefghijklmnopqrst"', ""].join("\n"),
    );
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.majorVersion).toBe(17);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("ignores an empty SUPABASE_DB_PORT override (viper AllowEmptyEnv=false)", () => {
    const prev = process.env["SUPABASE_DB_PORT"];
    process.env["SUPABASE_DB_PORT"] = "";
    const dir = withConfig(["[db]", "port = 55555", ""].join("\n"));
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.port).toBe(55555);
          if (prev === undefined) delete process.env["SUPABASE_DB_PORT"];
          else process.env["SUPABASE_DB_PORT"] = prev;
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("loadProjectEnv surfaces SUPABASE_DB_PASSWORD from .env (linked-path source)", () => {
    // The --linked resolver reads SUPABASE_DB_PASSWORD via this map, so a value
    // defined only in supabase/.env must be visible (Go's loadNestedEnv parity).
    delete process.env["SUPABASE_DB_PASSWORD"];
    const dir = mkdtempSync(join(tmpdir(), "db-toml-"));
    mkdirSync(join(dir, "supabase"), { recursive: true });
    writeFileSync(join(dir, "supabase", ".env"), "SUPABASE_DB_PASSWORD=from-dotenv\n");
    return loadEnv(dir).pipe(
      Effect.tap((env) =>
        Effect.sync(() => {
          expect(env["SUPABASE_DB_PASSWORD"]).toBe("from-dotenv");
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("loadProjectEnv is pure: returns every key and never touches process.env", () => {
    // Applying to process.env is the separate, opt-in `applyProjectEnv` below, so a mere load
    // for SUPABASE_YES has no global side effect.
    const saved: Record<string, string | undefined> = {};
    for (const k of ["SUPABASE_INTERNAL_IMAGE_REGISTRY", "SUPABASE_PROJECT_ID", "SUPABASE_ENV"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    const dir = mkdtempSync(join(tmpdir(), "db-toml-"));
    mkdirSync(join(dir, "supabase"), { recursive: true });
    writeFileSync(
      join(dir, "supabase", ".env"),
      "SUPABASE_INTERNAL_IMAGE_REGISTRY=my-mirror.example.com\nSUPABASE_PROJECT_ID=envonlyref\nSUPABASE_ENV=staging\n",
    );
    return loadEnv(dir).pipe(
      Effect.tap((env) =>
        Effect.sync(() => {
          expect(env["SUPABASE_INTERNAL_IMAGE_REGISTRY"]).toBe("my-mirror.example.com");
          expect(env["SUPABASE_PROJECT_ID"]).toBe("envonlyref");
          expect(env["SUPABASE_ENV"]).toBe("staging");
          // process.env stays untouched, including the allowlisted registry key.
          expect(process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"]).toBeUndefined();
          expect(process.env["SUPABASE_PROJECT_ID"]).toBeUndefined();
          expect(process.env["SUPABASE_ENV"]).toBeUndefined();
          for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
          }
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect(
    "applyProjectEnv sets only the allowlisted keys in-scope, never overrides, reverts on close",
    () => {
      // Our resolvers read process.env lazily, so only the allowlisted
      // `SUPABASE_INTERNAL_IMAGE_REGISTRY` (the process.env-only reader) is applied: a .env
      // project-ref must not retarget the lazy ref/pooler resolvers, and a .env SUPABASE_ENV
      // must not switch the env-file set.
      const saved: Record<string, string | undefined> = {};
      for (const k of ["SUPABASE_INTERNAL_IMAGE_REGISTRY", "SUPABASE_PROJECT_ID", "SUPABASE_ENV"]) {
        saved[k] = process.env[k];
        delete process.env[k];
      }
      const loaded = {
        SUPABASE_INTERNAL_IMAGE_REGISTRY: "my-mirror.example.com",
        SUPABASE_PROJECT_ID: "envonlyref",
        SUPABASE_ENV: "staging",
      };
      return Effect.gen(function* () {
        // Inside the scope: only the registry key is applied; the ref/env selector are not.
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* applyProjectEnv(loaded);
            expect(process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"]).toBe("my-mirror.example.com");
            expect(process.env["SUPABASE_PROJECT_ID"]).toBeUndefined();
            expect(process.env["SUPABASE_ENV"]).toBeUndefined();
          }),
        );
        // After the scope closes the applied keys are reverted (no test-worker leak).
        expect(process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"]).toBeUndefined();

        // An existing process.env value is never overridden, and is not deleted on close.
        process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"] = "shell-wins.example.com";
        yield* Effect.scoped(applyProjectEnv(loaded));
        expect(process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"]).toBe("shell-wins.example.com");
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            for (const [k, v] of Object.entries(saved)) {
              if (v === undefined) delete process.env[k];
              else process.env[k] = v;
            }
          }),
        ),
      );
    },
  );

  it.effect("ignores a [db.pooler] connection_string in config.toml (Go reads .temp only)", () => {
    const dir = withConfig(
      [
        "[db.pooler]",
        'connection_string = "postgres://postgres.ref:[YOUR-PASSWORD]@pool:6543/postgres"',
        "",
      ].join("\n"),
    );
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(Option.isNone(v.poolerConnectionString)).toBe(true);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("treats an empty .temp/pooler-url as no pooler configured", () => {
    const dir = withConfig(undefined, "");
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(Option.isNone(v.poolerConnectionString)).toBe(true);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });
});

describe("readDbToml [experimental.pgdelta]", () => {
  it.effect("defaults pg-delta to disabled with no config", () => {
    const dir = withConfig(undefined);
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.pgDelta.enabled).toBe(false);
          expect(Option.isNone(v.pgDelta.declarativeSchemaPath)).toBe(true);
          expect(Option.isNone(v.pgDelta.formatOptions)).toBe(true);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("reads enabled / format_options and prefixes a relative schema path", () => {
    const dir = withConfig(
      [
        "[experimental.pgdelta]",
        "enabled = true",
        'declarative_schema_path = "./db/decl"',
        'format_options = "{\\"keywordCase\\":\\"upper\\",\\"indent\\":2}"',
        "",
      ].join("\n"),
    );
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.pgDelta.enabled).toBe(true);
          expect(Option.getOrNull(v.pgDelta.declarativeSchemaPath)).toBe(
            join("supabase", "db", "decl"),
          );
          expect(Option.getOrNull(v.pgDelta.formatOptions)).toBe(
            '{"keywordCase":"upper","indent":2}',
          );
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("keeps an absolute declarative_schema_path unchanged", () => {
    const dir = withConfig(
      ["[experimental.pgdelta]", 'declarative_schema_path = "/abs/decl"', ""].join("\n"),
    );
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(Option.getOrNull(v.pgDelta.declarativeSchemaPath)).toBe("/abs/decl");
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });
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
      ).toBe(join("supabase", "schemas"));
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("uses the configured declarative_schema_path when set", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(
        resolveDeclarativeDir(path, {
          enabled: true,
          declarativeSchemaPath: Option.some(join("supabase", "db", "decl")),
          formatOptions: Option.none(),
        }),
      ).toBe(join("supabase", "db", "decl"));
    }).pipe(Effect.provide(BunServices.layer)),
  );
});

describe("readDbToml auth.Enabled validation (Go config.Validate parity)", () => {
  // Fails the config load with `message` contained in the surfaced error.
  const failsWith = (
    lines: ReadonlyArray<string>,
    message: string,
    extra?: (dir: string) => void,
  ) =>
    Effect.gen(function* () {
      const dir = withConfig(lines.join("\n"));
      if (extra) extra(dir);
      const exit = yield* read(dir).pipe(Effect.exit);
      expect(Exit.isFailure(exit), `expected failure containing: ${message}`).toBe(true);
      if (Exit.isFailure(exit)) expect(JSON.stringify(exit.cause)).toContain(message);
      rmSync(dir, { recursive: true, force: true });
    });
  // Loads cleanly — no validation error (the read resolves to a value).
  const succeeds = (lines: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const dir = withConfig(lines.join("\n"));
      const v = yield* read(dir);
      expect(v.baseline).toBeDefined();
      rmSync(dir, { recursive: true, force: true });
    });

  it.effect("rejects an explicit empty auth.site_url", () =>
    failsWith(["[auth]", 'site_url = ""'], "Missing required field in config: auth.site_url"),
  );
  it.effect("defaults an absent auth.site_url (Go template default) — no error", () =>
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
      "failed to decode signing keys",
      // A relative signing_keys_path resolves under supabase/.
      (dir) => writeFileSync(join(dir, "supabase", "keys.json"), "{ not json"),
    ),
  );

  it.effect("defaults [auth.email.smtp] enabled=true when the table omits enabled (Go merge)", () =>
    failsWith(
      ["[auth.email.smtp]", 'user = "u"'],
      "Missing required field in config: auth.email.smtp.host",
    ),
  );
  it.effect("respects an explicit [auth.email.smtp] enabled=false (no validation)", () =>
    succeeds(["[auth.email.smtp]", "enabled = false", 'user = "u"']),
  );

  it.effect("skips auth validation when SUPABASE_AUTH_ENABLED=false (env override)", () => {
    const previous = process.env["SUPABASE_AUTH_ENABLED"];
    process.env["SUPABASE_AUTH_ENABLED"] = "false";
    const dir = withConfig(
      ["[auth]", 'site_url = ""', "[auth.passkey]", "enabled = true"].join("\n"),
    );
    return read(dir).pipe(
      Effect.tap((v) => Effect.sync(() => expect(v.baseline).toBeDefined())),
      Effect.ensuring(
        Effect.sync(() => {
          if (previous === undefined) delete process.env["SUPABASE_AUTH_ENABLED"];
          else process.env["SUPABASE_AUTH_ENABLED"] = previous;
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("fails on a malformed auth boolean string instead of coercing to false", () =>
    failsWith(
      ["[auth.passkey]", 'enabled = "maybe"'],
      "failed to parse config: invalid auth.passkey.enabled.",
    ),
  );

  it.effect("rejects an unknown captcha provider (Go enum, regardless of enabled)", () =>
    failsWith(
      ["[auth.captcha]", "enabled = false", 'provider = "cloudflare"'],
      "'auth.captcha.provider' must be one of [hcaptcha turnstile]",
    ),
  );
});

describe("readDbToml encrypted secret decryption (Go DecryptSecretHookFunc parity)", () => {
  // An undecryptable `encrypted:` value anywhere in config.toml aborts the load with
  // `failed to parse config: <error>`.
  const expectFails = (lines: ReadonlyArray<string>, message: string) =>
    Effect.gen(function* () {
      const dir = withConfig(lines.join("\n"));
      const exit = yield* read(dir).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(JSON.stringify(exit.cause)).toContain(message);
      rmSync(dir, { recursive: true, force: true });
    });
  const expectLoads = (lines: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const dir = withConfig(lines.join("\n"));
      const v = yield* read(dir);
      expect(v.baseline).toBeDefined();
      rmSync(dir, { recursive: true, force: true });
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
  it.effect("treats an unset env() secret as a no-op (verbatim, like Go's hook)", () =>
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

describe("readDbToml non-scalar config booleans (Go UnmarshalExact parity)", () => {
  // A present non-scalar boolean must fail the config load rather than falling through to the
  // schema default, which would let `db reset` prompt and drop schemas.
  const failsInvalid = (lines: ReadonlyArray<string>, field: string) =>
    Effect.gen(function* () {
      const dir = withConfig(lines.join("\n"));
      const exit = yield* read(dir).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain(`failed to parse config: invalid ${field}.`);
      }
      rmSync(dir, { recursive: true, force: true });
    });
  it.effect("rejects an array value for [db.migrations] enabled", () =>
    failsInvalid(["[db.migrations]", "enabled = []"], "db.migrations.enabled"),
  );
  it.effect("rejects an inline-table value for [db.seed] enabled", () =>
    failsInvalid(["[db.seed]", "enabled = {}"], "db.seed.enabled"),
  );
});

describe("readDbToml empty project_id (Go config.Validate parity)", () => {
  it.effect("rejects a present-but-empty top-level project_id", () => {
    const dir = withConfig('project_id = ""\n');
    return read(dir).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain(
              "Missing required field in config: project_id",
            );
          }
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("still tolerates an absent project_id (deferred broader requirement)", () => {
    const dir = withConfig("[db]\nmajor_version = 15\n");
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.baseline).toBeDefined();
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });
});

describe("readDbToml [analytics] validation (Go config.Validate parity)", () => {
  const failsWith = (lines: ReadonlyArray<string>, message: string) =>
    Effect.gen(function* () {
      const dir = withConfig(lines.join("\n"));
      const exit = yield* read(dir).pipe(Effect.exit);
      expect(Exit.isFailure(exit), `expected failure containing: ${message}`).toBe(true);
      if (Exit.isFailure(exit)) expect(JSON.stringify(exit.cause)).toContain(message);
      rmSync(dir, { recursive: true, force: true });
    });
  const succeeds = (lines: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const dir = withConfig(lines.join("\n"));
      const v = yield* read(dir);
      expect(v.baseline).toBeDefined();
      rmSync(dir, { recursive: true, force: true });
    });

  it.effect("rejects an unknown analytics.backend regardless of enabled", () =>
    failsWith(
      ["[analytics]", "enabled = false", 'backend = "clickhouse"'],
      "'analytics.backend' must be one of [postgres bigquery]",
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
    const previous = process.env["SUPABASE_ANALYTICS_BACKEND"];
    process.env["SUPABASE_ANALYTICS_BACKEND"] = "bigquery";
    return failsWith(
      ["[analytics]", "enabled = true"],
      "Missing required field in config: analytics.gcp_project_id",
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (previous === undefined) delete process.env["SUPABASE_ANALYTICS_BACKEND"];
          else process.env["SUPABASE_ANALYTICS_BACKEND"] = previous;
        }),
      ),
    );
  });
});

describe("readDbToml SUPABASE_PROJECT_ID override (Go AutomaticEnv parity)", () => {
  const restore = (previous: string | undefined) =>
    Effect.sync(() => {
      if (previous === undefined) delete process.env["SUPABASE_PROJECT_ID"];
      else process.env["SUPABASE_PROJECT_ID"] = previous;
    });

  it.effect("overrides the TOML project_id with SUPABASE_PROJECT_ID", () => {
    const previous = process.env["SUPABASE_PROJECT_ID"];
    process.env["SUPABASE_PROJECT_ID"] = "env-project";
    const dir = withConfig(['project_id = "toml-project"', ""].join("\n"));
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(Option.getOrNull(v.projectId)).toBe("env-project");
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
      Effect.ensuring(restore(previous)),
    );
  });

  it.effect("applies SUPABASE_PROJECT_ID even when config.toml is absent", () => {
    const previous = process.env["SUPABASE_PROJECT_ID"];
    process.env["SUPABASE_PROJECT_ID"] = "env-project";
    const dir = withConfig(undefined);
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(Option.getOrNull(v.projectId)).toBe("env-project");
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
      Effect.ensuring(restore(previous)),
    );
  });

  it.effect("ignores an empty SUPABASE_PROJECT_ID (viper AllowEmptyEnv=false)", () => {
    const previous = process.env["SUPABASE_PROJECT_ID"];
    process.env["SUPABASE_PROJECT_ID"] = "";
    const dir = withConfig(['project_id = "toml-project"', ""].join("\n"));
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(Option.getOrNull(v.projectId)).toBe("toml-project");
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
      Effect.ensuring(restore(previous)),
    );
  });

  it.effect(
    "prefers a matched [remotes.<ref>]'s project_id over a conflicting SUPABASE_PROJECT_ID",
    () => {
      const previous = process.env["SUPABASE_PROJECT_ID"];
      process.env["SUPABASE_PROJECT_ID"] = "local";
      const ref = "abcdefghijklmnopqrst";
      const dir = withConfig(
        ['project_id = "toml-project"', "[remotes.prod]", `project_id = "${ref}"`, ""].join("\n"),
      );
      return readRef(dir, ref).pipe(
        Effect.tap((v) =>
          Effect.sync(() => {
            expect(v.appliedRemote).toBe("prod");
            expect(v.remoteOverrideKeys.has("project_id")).toBe(true);
            expect(Option.getOrNull(v.projectId)).toBe(ref);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
        Effect.ensuring(restore(previous)),
      );
    },
  );

  it.effect("still applies SUPABASE_PROJECT_ID when no [remotes.*] block matches the ref", () => {
    const previous = process.env["SUPABASE_PROJECT_ID"];
    process.env["SUPABASE_PROJECT_ID"] = "env-project";
    const ref = "abcdefghijklmnopqrst";
    const dir = withConfig(['project_id = "toml-project"', ""].join("\n"));
    return readRef(dir, ref).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.appliedRemote).toBeUndefined();
          expect(Option.getOrNull(v.projectId)).toBe("env-project");
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
      Effect.ensuring(restore(previous)),
    );
  });
});

describe("readDbToml remoteOverrideKeys — auth.captcha.provider / auth.email.template/notification", () => {
  const ref = "abcdefghijklmnopqrst";

  it.effect("tracks auth.captcha.provider when a matched remote block supplies it", () => {
    // `provider` is a plain string leaf, not part of a dynamically-keyed section, so it must be
    // tracked via `ENV_OVERRIDABLE_KEYS` like any other fixed-name field.
    const dir = withConfig(
      [
        "[auth.captcha]",
        'provider = "hcaptcha"',
        "[remotes.prod]",
        `project_id = "${ref}"`,
        "[remotes.prod.auth.captcha]",
        'provider = "turnstile"',
        "",
      ].join("\n"),
    );
    return readRef(dir, ref).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.appliedRemote).toBe("prod");
          expect(v.remoteOverrideKeys.has("auth.captcha.provider")).toBe(true);
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("tracks a matched remote block's auth.email.template.<name> leaves dynamically", () => {
    // `auth.email.template.<name>.*` is an arbitrarily-keyed map, same shape as
    // `auth.external.<name>.*`, so it must be flattened dynamically instead of relying on a
    // fixed `ENV_OVERRIDABLE_KEYS` entry.
    const dir = withConfig(
      [
        "[remotes.prod]",
        `project_id = "${ref}"`,
        "[remotes.prod.auth.email.template.invite]",
        'content_path = "remote-invite.html"',
        "",
      ].join("\n"),
    );
    // Template `content_path` resolves relative to the project root (`workdir`, i.e. `dir`).
    writeFileSync(join(dir, "remote-invite.html"), "<html></html>");
    return readRef(dir, ref).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.appliedRemote).toBe("prod");
          expect(v.remoteOverrideKeys.has("auth.email.template.invite.content_path")).toBe(true);
          expect(v.remoteOverrideKeys.has("auth.email.template.invite.subject")).toBe(false);
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect(
    "tracks a matched remote block's auth.email.notification.<name> leaves dynamically",
    () => {
      // Sibling case to auth.email.template, including a boolean leaf (`enabled`).
      const dir = withConfig(
        [
          "[remotes.prod]",
          `project_id = "${ref}"`,
          "[remotes.prod.auth.email.notification.password_changed]",
          "enabled = true",
          'content_path = "remote-pw-changed.html"',
          "",
        ].join("\n"),
      );
      // Notification `content_path` resolves relative to the project root, like a template.
      writeFileSync(join(dir, "remote-pw-changed.html"), "<html></html>");
      return readRef(dir, ref).pipe(
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
        Effect.ensuring(
          Effect.sync(() => {
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );
});
