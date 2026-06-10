import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Option, Path } from "effect";

import { legacyLoadProjectEnv, legacyReadDbToml } from "./legacy-db-config.toml-read.ts";

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
          expect(v.password).toBe("env-override");
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
