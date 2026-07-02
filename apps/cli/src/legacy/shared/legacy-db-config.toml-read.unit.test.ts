import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Option, Path } from "effect";

import {
  legacyApplyProjectEnv,
  legacyLoadProjectEnv,
  legacyReadDbToml,
  legacyResolveDeclarativeDir,
} from "./legacy-db-config.toml-read.ts";

function withConfig(content: string | undefined, poolerUrl?: string) {
  const dir = mkdtempSync(join(tmpdir(), "legacy-db-toml-"));
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
    return yield* legacyReadDbToml(fs, path, workdir);
  }).pipe(Effect.provide(BunServices.layer));

const readRef = (workdir: string, ref: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* legacyReadDbToml(fs, path, workdir, ref);
  }).pipe(Effect.provide(BunServices.layer));

const loadEnv = (workdir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* legacyLoadProjectEnv(fs, path, workdir);
  }).pipe(Effect.provide(BunServices.layer));

describe("legacyReadDbToml", () => {
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

  // Go's test vector (`apps/cli-go/pkg/config/secret_test.go`): this ciphertext
  // decrypts to "value" under the keypair below.
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
    // Go aborts the whole command (`failed to parse config: missing private key`)
    // rather than silently skipping the secret (`secret.go`, `config.go:661-667`).
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

  it.effect("collapses . and .. in relative seed sql_paths like Go's path.Join", () => {
    // Go prefixes each relative pattern with `path.Join("supabase", pattern)`, which
    // runs `path.Clean` (`config.go:881-886`). The cleaned path is the seed_files key.
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
    // Go's StringToSliceHookFunc(",") splits without trimming, so " b.sql" keeps its space.
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
    // Go decodes a non-array sql_paths string into a slice (config.go:691), not just the
    // env override; `"a.sql,b.sql"` → two supabase-prefixed paths, no trimming.
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
      // Go runs LoadEnvHook before StringToSliceHookFunc(","), so env(SEEDS)=a.sql,b.sql
      // expands first and then splits into two patterns.
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
    // A TOML array element is decoded string→string: LoadEnvHook expands it, but
    // StringToSliceHookFunc does not fire, so it stays one (comma-containing) pattern.
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
    // Go applies each matched-remote key via v.Set (override tier) above AutomaticEnv
    // (config.go:635-637), so an explicit remote value wins over the env var.
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
    // Control: the env override is suppressed only for keys the matched block explicitly
    // set; a block that omits db.migrations.enabled leaves the env override in force.
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

  it.effect("an explicit remote experimental.pgdelta.enabled beats its SUPABASE_* env var", () => {
    // Go's mergeRemoteConfig applies EVERY matched-block key via v.Set (above AutomaticEnv,
    // config.go:635-637), not just db/seed — so a remote experimental.pgdelta.enabled wins
    // over SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED.
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
    // Control: the env override is suppressed only for keys the matched block explicitly set;
    // a block that omits experimental.pgdelta.enabled leaves the env override in force.
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

  it.effect("matches a remote block by a SUPABASE_REMOTES_<NAME>_PROJECT_ID env override", () => {
    // Viper AutomaticEnv supplies/overrides remotes.prod.project_id, so the block merges
    // even with no TOML project_id (here it lifts major_version 15 over the base default).
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
    // Without the env value the block (no TOML project_id) would fail Validate; the env
    // override supplies a valid ref, so the load succeeds.
    const ref = "abcdefghijklmnopqrst";
    const previous = process.env["SUPABASE_REMOTES_PROD_PROJECT_ID"];
    process.env["SUPABASE_REMOTES_PROD_PROJECT_ID"] = ref;
    const dir = withConfig(["[remotes.prod]", "db.major_version = 15", ""].join("\n"));
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          // Load succeeded (no invalid-remote error); read() without a ref leaves the base
          // major_version default (17) since the block is not merged.
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
    // Go's mergeRemoteConfig v.Set(false) is an override-tier value above AutomaticEnv,
    // so a remote that omits db.seed.enabled stays unseeded even with the env var set.
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
    // Negative control: with no matched remote block, the env override applies normally.
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

  it.effect("fails with LegacyDbConfigLoadError when config.toml is malformed", () => {
    // Go's LoadConfig returns the decode error and aborts, rather than silently
    // running against the default local database (Codex P2 / config parity).
    const dir = withConfig("[db]\nport = [unterminated");
    return read(dir).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain("LegacyDbConfigLoadError");
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
      // Go's mergeRemoteConfig (config.go:638-640) forces db.seed.enabled=false when the
      // matched remote block itself doesn't set it — even if the base config enables it.
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
      // Go's config.Load aborts on duplicate project_id regardless of ref (config.go:506).
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
    // Go's config.Validate aborts on deno_version other than 1/2 (config.go:999-1008).
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
    // Go's config.Validate aborts with this exact message when format_options is
    // non-empty but not valid JSON (`apps/cli-go/pkg/config/config.go:1685-1686`),
    // before any shadow/catalog container runs.
    const dir = withConfig('[experimental.pgdelta]\nformat_options = "not-json"\n');
    return read(dir).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const json = JSON.stringify(exit.cause);
            expect(json).toContain("LegacyDbConfigLoadError");
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
    // Go's config.Validate runs ValidateBucketName over every bucket key on load
    // (`apps/cli-go/pkg/config/config.go:898-903`), aborting with this exact message
    // (`config.go:1386`) before any db command — the trailing `(...)` is the regex
    // source. `#` is outside bucketNamePattern, so this name is rejected.
    const dir = withConfig('[storage.buckets."bad#name"]\n');
    return read(dir).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const json = JSON.stringify(exit.cause);
            expect(json).toContain("LegacyDbConfigLoadError");
            // Prose part is backslash-free, so safe to assert through JSON.stringify;
            // the trailing `(<regex source>)` is built from the pattern's `.source`,
            // guaranteeing it byte-matches Go's `bucketNamePattern.String()`.
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
    // Go's config.Validate runs ValidateFunctionSlug over every functions key on load
    // (`apps/cli-go/pkg/config/config.go:993-998`), aborting with this exact message
    // (`config.go:1376`). `123` starts with a digit → rejected by `^[A-Za-z][A-Za-z0-9_-]*$`.
    const dir = withConfig("[functions.123]\n");
    return read(dir).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const json = JSON.stringify(exit.cause);
            expect(json).toContain("LegacyDbConfigLoadError");
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
    // Go's bucketNamePattern uses `\w` (includes `_`) and is not case-restricted
    // despite the prose, so `Bad_Name` actually passes — match the regex, not the
    // message text.
    const dir = withConfig("[storage.buckets.Bad_Name]\n");
    return read(dir).pipe(
      Effect.tap(() => Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
    );
  });

  it.effect("parses [api] auto_expose_new_tables string with Go bool tokens (TRUE → true)", () => {
    // Go decodes the *bool via strconv.ParseBool, so `TRUE`/`1`/`t` are true — not only
    // the literal lowercase `true`.
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

  it.effect("keeps [api] auto_expose_new_tables tri-state None when absent", () => {
    const dir = withConfig("[api]\n");
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(Option.isNone(v.baseline.apiAutoExposeNewTables)).toBe(true);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("rejects a malformed [api] auto_expose_new_tables during load", () => {
    // Go's UnmarshalExact fails the load on a non-bool string rather than coercing.
    const dir = withConfig('[api]\nauto_expose_new_tables = "maybe"\n');
    return read(dir).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const json = JSON.stringify(exit.cause);
            expect(json).toContain("LegacyDbConfigLoadError");
            expect(json).toContain("failed to parse config: invalid api.auto_expose_new_tables.");
          }
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("honors SUPABASE_API_AUTO_EXPOSE_NEW_TABLES env override (AutomaticEnv)", () => {
    // viper AutomaticEnv overrides the TOML value; `1` decodes to true.
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
    // Go's viper AutomaticEnv overrides TOML for experimental.pgdelta.* before validation.
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
    // Go decodes the AutomaticEnv override through LoadEnvHook (decode_hooks.go:15-26), so an
    // env(VAR) indirection resolves before the supabase/ join — not stored literally.
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

  it.effect("fails with LegacyDbConfigLoadError when config.toml is present but unreadable", () => {
    // Go's mergeFileConfig swallows only os.ErrNotExist; every other read error aborts
    // rather than silently running against the default local database (Codex P2 parity).
    // A directory at the config.toml path yields a non-NotFound PlatformError on read.
    const dir = mkdtempSync(join(tmpdir(), "legacy-db-toml-"));
    mkdirSync(join(dir, "supabase", "config.toml"), { recursive: true });
    return read(dir).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain("LegacyDbConfigLoadError");
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
    process.env["LEGACY_DB_PW"] = "from-env";
    process.env["LEGACY_DB_PORT"] = "6000";
    const dir = withConfig(
      ["[db]", 'port = "env(LEGACY_DB_PORT)"', 'password = "env(LEGACY_DB_PW)"', ""].join("\n"),
    );
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.port).toBe(6000);
          expect(v.password).toBe("from-env");
          delete process.env["LEGACY_DB_PW"];
          delete process.env["LEGACY_DB_PORT"];
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("expands env(VAR) in db.seed.sql_paths entries before supabase-prefixing", () => {
    // Go's LoadEnvHook expands env(VAR) on every string element of db.seed.sql_paths
    // during unmarshal, before resolve() prefixes relative patterns — so the glob is
    // the expanded value, not the literal `supabase/env(...)`.
    process.env["LEGACY_SEED_SQL"] = "custom/data.sql";
    const dir = withConfig(["[db.seed]", 'sql_paths = ["env(LEGACY_SEED_SQL)"]', ""].join("\n"));
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.seed.sqlPaths).toEqual(["supabase/custom/data.sql"]);
          delete process.env["LEGACY_SEED_SQL"];
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
    // Go decodes the AutomaticEnv override through LoadEnvHook before the bool parse
    // (decode_hooks.go:15-26), so `env(SEED_ON)` resolves to SEED_ON's value rather
    // than failing the load on a literal `env(...)` bool.
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
      // Go expands `project_id` via LoadEnvHook before deriving local container names,
      // so a raw `env(...)` must not leak into `supabase_db_env_PROJECT_ID_`.
      process.env["LEGACY_PROJECT_REF"] = "abcdefghijklmnopqrst";
      const dir = withConfig(['project_id = "env(LEGACY_PROJECT_REF)"', ""].join("\n"));
      return read(dir).pipe(
        Effect.tap((v) =>
          Effect.sync(() => {
            expect(Option.getOrNull(v.projectId)).toBe("abcdefghijklmnopqrst");
            delete process.env["LEGACY_PROJECT_REF"];
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect("does not merge a remote block whose project_id is a TOML env() literal", () => {
    // Go's in-load matching reads remotes.<name>.project_id via v.GetString (config.go:510),
    // which returns the RAW literal `env(LEGACY_STAGING_REF)` — LoadEnvHook only expands it
    // during the later UnmarshalExact. So the block is NOT selected by its expanded ref and
    // does not merge (major_version stays the base 15), while Validate over the decoded,
    // expanded field (config.go:909-913) still passes the load.
    process.env["LEGACY_STAGING_REF"] = "stagingrefstagingref";
    const dir = withConfig(
      [
        'project_id = "base"',
        "[db]",
        "major_version = 15",
        "[remotes.staging]",
        'project_id = "env(LEGACY_STAGING_REF)"',
        "[remotes.staging.db]",
        "major_version = 17",
        "",
      ].join("\n"),
    );
    return readRef(dir, "stagingrefstagingref").pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.majorVersion).toBe(15); // block not merged: matched on the raw env() literal
          delete process.env["LEGACY_STAGING_REF"];
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("rejects an env-backed remote project_id that expands to nothing", () => {
    // An unset env() expands to the literal `env(...)`, which fails Go's ref pattern.
    delete process.env["LEGACY_MISSING_REF"];
    const dir = withConfig(
      ["[remotes.staging]", 'project_id = "env(LEGACY_MISSING_REF)"', ""].join("\n"),
    );
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
    process.env["LEGACY_ORIOLE_VER"] = "16.0.0.1";
    const dir = withConfig(
      [
        "[db]",
        "major_version = 17",
        "[experimental]",
        'orioledb_version = "env(LEGACY_ORIOLE_VER)"',
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
          delete process.env["LEGACY_ORIOLE_VER"];
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("warns (does not fail) for an unset S3 env on an OrioleDB project", () => {
    // Go's assertEnvLoaded prints `WARN: environment variable is unset: <NAME>` to
    // stderr for an S3 value still holding an unexpanded env(...), and returns nil.
    delete process.env["LEGACY_S3_KEY"];
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
        's3_access_key = "env(LEGACY_S3_KEY)"',
        "",
      ].join("\n"),
    );
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          // Config load succeeds (warning only), and the orioledb version is parsed.
          expect(Option.getOrNull(v.orioledbVersion)).toBe("15.1.0.55");
          expect(writes.join("")).toContain("WARN: environment variable is unset: LEGACY_S3_KEY");
          process.stderr.write = original;
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("keeps the literal password when its env var is unset/empty", () => {
    // Go's LoadEnvHook only substitutes when len(os.Getenv(name)) > 0; otherwise it
    // preserves the literal string. Password is a plain string field, so an
    // unresolved env() ref stays literal (it is not validated like the ports).
    delete process.env["LEGACY_DB_UNSET"];
    const dir = withConfig(["[db]", 'password = "env(LEGACY_DB_UNSET)"', ""].join("\n"));
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.password).toBe("env(LEGACY_DB_UNSET)");
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect(
    "fails when a present port is non-numeric, out of range, or an unresolved env()",
    () => {
      // Go decodes [db].port into uint16 after LoadEnvHook; a present value that cannot
      // unmarshal aborts config loading rather than silently defaulting to 54322.
      delete process.env["LEGACY_DB_UNSET"];
      const cases = ['port = "abc"', "port = 70000", "port = -1", 'port = "env(LEGACY_DB_UNSET)"'];
      return Effect.forEach(cases, (line) => {
        const dir = withConfig(["[db]", line, ""].join("\n"));
        return read(dir).pipe(
          Effect.exit,
          Effect.tap((exit) =>
            Effect.sync(() => {
              expect(Exit.isFailure(exit)).toBe(true);
              if (Exit.isFailure(exit)) {
                expect(JSON.stringify(exit.cause)).toContain("LegacyDbConfigLoadError");
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
    delete process.env["LEGACY_DB_FILEVAR"];
    const dir = withConfig(
      ["[db]", 'port = "env(LEGACY_DB_FILEVAR)"', 'password = "env(LEGACY_DB_FILEVAR)"', ""].join(
        "\n",
      ),
    );
    writeFileSync(join(dir, "supabase", ".env"), "LEGACY_DB_FILEVAR=7000\n");
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
    process.env["LEGACY_DB_FILEVAR"] = "shell-wins";
    const dir = withConfig(["[db]", 'password = "env(LEGACY_DB_FILEVAR)"', ""].join("\n"));
    writeFileSync(join(dir, "supabase", ".env"), "LEGACY_DB_FILEVAR=from-file\n");
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.password).toBe("shell-wins");
          delete process.env["LEGACY_DB_FILEVAR"];
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("lets supabase/.env win over a repo-root .env (Go walks supabase/ first)", () => {
    delete process.env["LEGACY_DB_FILEVAR"];
    const dir = withConfig(["[db]", 'password = "env(LEGACY_DB_FILEVAR)"', ""].join("\n"));
    writeFileSync(join(dir, ".env"), "LEGACY_DB_FILEVAR=root\n");
    writeFileSync(join(dir, "supabase", ".env"), "LEGACY_DB_FILEVAR=supabase\n");
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
    // Go's loadEnvIfExists swallows only os.ErrNotExist; any other read error
    // aborts rather than hiding a broken env-backed config. A directory at the
    // .env path yields a non-NotFound read error.
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
          // db.password is tagged `json:"-"` in Go, so it is NOT bound from
          // SUPABASE_DB_PASSWORD — the local password stays the config value.
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
    // Go's db.Password is json:"-" — not env-bound; the local default is "postgres".
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
    // Go decodes major_version into a uint after LoadEnvHook; `17foo` fails the parse
    // rather than being truncated to 17 by a parseInt-style read.
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
    process.env["LEGACY_PG_MAJOR"] = "15";
    const dir = withConfig(["[db]", 'major_version = "env(LEGACY_PG_MAJOR)"', ""].join("\n"));
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.majorVersion).toBe(15);
          delete process.env["LEGACY_PG_MAJOR"];
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
    // Go binds this via viper AutomaticEnv before Validate, so an env override of 1
    // selects the deno1 edge-runtime image even when the TOML omits/sets a different value.
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
    // Go decodes deno_version into a uint before Validate; `2foo` fails the parse rather
    // than being read as 2 / falling through to the default Deno 2 image.
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
    // Go's Validate requires every remote project_id to match ^[a-z]{20}$, failing even
    // local/direct commands (config.go:832-836).
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
          expect(v.majorVersion).toBe(17); // loads successfully (no remote selected)
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

  it.effect(
    "legacyLoadProjectEnv surfaces SUPABASE_DB_PASSWORD from .env (linked-path source)",
    () => {
      // The --linked resolver reads SUPABASE_DB_PASSWORD via this map, so a value
      // defined only in supabase/.env must be visible (Go's loadNestedEnv parity).
      delete process.env["SUPABASE_DB_PASSWORD"];
      const dir = mkdtempSync(join(tmpdir(), "legacy-db-toml-"));
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
    },
  );

  it.effect("legacyLoadProjectEnv is pure: returns every key and never touches process.env", () => {
    // The loader is a pure read: it returns all project-.env keys in the map (config
    // env() resolution + the SUPABASE_YES / db-password readers use the map) and does
    // NOT mutate process.env. Applying to process.env is the separate, opt-in
    // legacyApplyProjectEnv (below), so a mere `load` for SUPABASE_YES has no global
    // side effect.
    const saved: Record<string, string | undefined> = {};
    for (const k of ["SUPABASE_INTERNAL_IMAGE_REGISTRY", "SUPABASE_PROJECT_ID", "SUPABASE_ENV"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    const dir = mkdtempSync(join(tmpdir(), "legacy-db-toml-"));
    mkdirSync(join(dir, "supabase"), { recursive: true });
    writeFileSync(
      join(dir, "supabase", ".env"),
      "SUPABASE_INTERNAL_IMAGE_REGISTRY=my-mirror.example.com\nSUPABASE_PROJECT_ID=envonlyref\nSUPABASE_ENV=staging\n",
    );
    return loadEnv(dir).pipe(
      Effect.tap((env) =>
        Effect.sync(() => {
          // The returned map carries all keys.
          expect(env["SUPABASE_INTERNAL_IMAGE_REGISTRY"]).toBe("my-mirror.example.com");
          expect(env["SUPABASE_PROJECT_ID"]).toBe("envonlyref");
          expect(env["SUPABASE_ENV"]).toBe("staging");
          // ...but process.env is untouched, including the allowlisted registry key.
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
    "legacyApplyProjectEnv sets only the allowlisted key in-scope, never overrides, reverts on close",
    () => {
      // Go's loadNestedEnv os.Setenv's the project .env, but its root globals
      // (project-ref, SUPABASE_ENV, workdir/profile) are resolved from the shell
      // BEFORE loadNestedEnv. Our resolvers read process.env lazily, so we apply only
      // the allowlisted `SUPABASE_INTERNAL_IMAGE_REGISTRY` (the one process.env-only
      // reader): a .env project-ref must not retarget the lazy ref/pooler resolvers,
      // and a .env SUPABASE_ENV must not switch the env-file set.
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
            yield* legacyApplyProjectEnv(loaded);
            expect(process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"]).toBe("my-mirror.example.com");
            expect(process.env["SUPABASE_PROJECT_ID"]).toBeUndefined();
            expect(process.env["SUPABASE_ENV"]).toBeUndefined();
          }),
        );
        // After the scope closes the applied key is reverted (no test-worker leak).
        expect(process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"]).toBeUndefined();

        // An existing process.env value is never overridden, and is NOT deleted on close.
        process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"] = "shell-wins.example.com";
        yield* Effect.scoped(legacyApplyProjectEnv(loaded));
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
    // The Go config field is tagged `toml:"-"`, so a connection_string in config.toml
    // is never honored; only supabase/.temp/pooler-url counts.
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

describe("legacyReadDbToml [experimental.pgdelta]", () => {
  it.effect("defaults pg-delta to disabled with no config", () => {
    const dir = withConfig(undefined);
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(v.pgDelta.enabled).toBe(false);
          expect(Option.isNone(v.pgDelta.declarativeSchemaPath)).toBe(true);
          expect(Option.isNone(v.pgDelta.formatOptions)).toBe(true);
          expect(Option.isNone(v.pgDelta.npmVersion)).toBe(true);
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
          // Go's config.resolve prefixes a relative path with SupabaseDirPath.
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

  it.effect("reads the npm version from .temp/pgdelta-version (trimmed)", () => {
    const dir = withConfig(["[experimental.pgdelta]", "enabled = true", ""].join("\n"));
    mkdirSync(join(dir, "supabase", ".temp"), { recursive: true });
    writeFileSync(join(dir, "supabase", ".temp", "pgdelta-version"), "  9.9.9-test  \n");
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(Option.getOrNull(v.pgDelta.npmVersion)).toBe("9.9.9-test");
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("leaves npm version None for an empty .temp/pgdelta-version", () => {
    const dir = withConfig(["[experimental.pgdelta]", "enabled = true", ""].join("\n"));
    mkdirSync(join(dir, "supabase", ".temp"), { recursive: true });
    writeFileSync(join(dir, "supabase", ".temp", "pgdelta-version"), "   \n");
    return read(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(Option.isNone(v.pgDelta.npmVersion)).toBe(true);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });
});

describe("legacyResolveDeclarativeDir", () => {
  it.effect("uses the default supabase/database when no path is configured", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(
        legacyResolveDeclarativeDir(path, {
          enabled: false,
          declarativeSchemaPath: Option.none(),
          formatOptions: Option.none(),
          npmVersion: Option.none(),
        }),
      ).toBe(join("supabase", "database"));
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("uses the configured declarative_schema_path when set", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(
        legacyResolveDeclarativeDir(path, {
          enabled: true,
          declarativeSchemaPath: Option.some(join("supabase", "db", "decl")),
          formatOptions: Option.none(),
          npmVersion: Option.none(),
        }),
      ).toBe(join("supabase", "db", "decl"));
    }).pipe(Effect.provide(BunServices.layer)),
  );
});

describe("legacyReadDbToml auth.Enabled validation (Go config.Validate parity)", () => {
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

  // The reviewer's case: passkey enabled requires a valid [auth.webauthn].
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
      // A relative signing_keys_path resolves under supabase/ (Go's config.go:877-878).
      (dir) => writeFileSync(join(dir, "supabase", "keys.json"), "{ not json"),
    ),
  );

  // --- Follow-up parity fixes (Codex re-review) ---

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

describe("legacyReadDbToml encrypted secret decryption (Go DecryptSecretHookFunc parity)", () => {
  // Go decrypts every config.Secret during decode; an undecryptable `encrypted:` value
  // anywhere in config.toml aborts `config.Load` with `failed to parse config: <error>`.
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
});

describe("legacyReadDbToml [analytics] validation (Go config.Validate parity)", () => {
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

  // `LogflareBackend.UnmarshalText` is a decode-time enum (`config.go:60-66`): it fires whenever
  // `backend` is set, even when analytics is disabled.
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

describe("legacyReadDbToml SUPABASE_PROJECT_ID override (Go AutomaticEnv parity)", () => {
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
});
