import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Option, Path } from "effect";

import {
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

  it.effect("accepts an env-backed remote project_id that expands to a valid ref", () => {
    // Go expands env(VAR) via LoadEnvHook before Validate checks the ref pattern
    // (config.go:832-836), so an env-backed remote project_id is validated and
    // merged by its resolved value.
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
          expect(v.majorVersion).toBe(17); // remote block merged via the expanded ref
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
