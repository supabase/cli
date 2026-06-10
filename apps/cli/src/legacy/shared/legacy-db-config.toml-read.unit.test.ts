import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Option, Path } from "effect";

import { legacyReadDbToml } from "./legacy-db-config.toml-read.ts";

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
