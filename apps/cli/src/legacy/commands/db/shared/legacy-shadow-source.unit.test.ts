import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Path } from "effect";

import {
  legacyLoadDeclaredSchemas,
  legacyShouldApplyDeclarativeWithPgDelta,
} from "./legacy-shadow-source.ts";
import type { LegacyPgDeltaTomlConfig } from "../../../shared/legacy-db-config.toml-read.ts";

function pgDelta(overrides: Partial<LegacyPgDeltaTomlConfig> = {}): LegacyPgDeltaTomlConfig {
  return {
    enabled: false,
    declarativeSchemaPath: Option.none(),
    formatOptions: Option.none(),
    npmVersion: Option.none(),
    ...overrides,
  };
}

function makeWorkdir(): string {
  return mkdtempSync(join(tmpdir(), "legacy-shadow-source-"));
}

describe("legacyShouldApplyDeclarativeWithPgDelta", () => {
  it.effect("is false whenever usePgDelta is false, regardless of schema_paths", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(legacyShouldApplyDeclarativeWithPgDelta(path, false, [], pgDelta())).toBe(false);
      expect(
        legacyShouldApplyDeclarativeWithPgDelta(path, false, ["schemas/x.sql"], pgDelta()),
      ).toBe(false);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("is true when usePgDelta and zero schema_paths are configured", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(legacyShouldApplyDeclarativeWithPgDelta(path, true, [], pgDelta())).toBe(true);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("is false when more than one schema_paths entry is configured", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(
        legacyShouldApplyDeclarativeWithPgDelta(path, true, ["a.sql", "b.sql"], pgDelta()),
      ).toBe(false);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "is true when exactly one schema_paths entry resolves to the effective declarative dir",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        expect(legacyShouldApplyDeclarativeWithPgDelta(path, true, ["database"], pgDelta())).toBe(
          true,
        );
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("is false when the single schema_paths entry does not match the declarative dir", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(legacyShouldApplyDeclarativeWithPgDelta(path, true, ["schemas"], pgDelta())).toBe(
        false,
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("matches a configured (non-default) declarative_schema_path the same way", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const configured = pgDelta({ declarativeSchemaPath: Option.some("supabase/custom-decl") });
      expect(legacyShouldApplyDeclarativeWithPgDelta(path, true, ["custom-decl"], configured)).toBe(
        true,
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );
});

describe("legacyLoadDeclaredSchemas", () => {
  it.effect(
    "returns [] when neither schema_paths, an enabled pg-delta dir, nor supabase/schemas exist",
    () => {
      const workdir = makeWorkdir();
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* legacyLoadDeclaredSchemas(fs, path, workdir, [], pgDelta());
        expect(result).toEqual([]);
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect(
    "falls back to sorted supabase/schemas/*.sql when no schema_paths/pg-delta dir apply",
    () => {
      const workdir = makeWorkdir();
      mkdirSync(join(workdir, "supabase", "schemas"), { recursive: true });
      writeFileSync(join(workdir, "supabase", "schemas", "b.sql"), "select 2;\n");
      writeFileSync(join(workdir, "supabase", "schemas", "a.sql"), "select 1;\n");
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* legacyLoadDeclaredSchemas(fs, path, workdir, [], pgDelta());
        expect(result).toEqual(["supabase/schemas/a.sql", "supabase/schemas/b.sql"]);
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect(
    "prefers the pg-delta declarative dir over supabase/schemas when pg-delta is enabled and the dir exists",
    () => {
      const workdir = makeWorkdir();
      mkdirSync(join(workdir, "supabase", "database"), { recursive: true });
      writeFileSync(join(workdir, "supabase", "database", "t.sql"), "select 1;\n");
      mkdirSync(join(workdir, "supabase", "schemas"), { recursive: true });
      writeFileSync(join(workdir, "supabase", "schemas", "unused.sql"), "select 2;\n");
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* legacyLoadDeclaredSchemas(
          fs,
          path,
          workdir,
          [],
          pgDelta({ enabled: true }),
        );
        expect(result).toEqual(["supabase/database/t.sql"]);
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect(
    "prefers db.migrations.schema_paths over both the pg-delta dir and supabase/schemas",
    () => {
      const workdir = makeWorkdir();
      mkdirSync(join(workdir, "supabase", "custom"), { recursive: true });
      writeFileSync(join(workdir, "supabase", "custom", "x.sql"), "select 1;\n");
      mkdirSync(join(workdir, "supabase", "database"), { recursive: true });
      writeFileSync(join(workdir, "supabase", "database", "unused.sql"), "select 2;\n");
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* legacyLoadDeclaredSchemas(
          fs,
          path,
          workdir,
          ["custom/*.sql"],
          pgDelta({ enabled: true }),
        );
        expect(result).toEqual(["supabase/custom/x.sql"]);
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect("fails when a literal (non-glob) schema_paths entry matches nothing", () => {
    const workdir = makeWorkdir();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const exit = yield* legacyLoadDeclaredSchemas(
        fs,
        path,
        workdir,
        ["missing.sql"],
        pgDelta(),
      ).pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
      rmSync(workdir, { recursive: true, force: true });
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("a glob schema_paths entry matching nothing is silently skipped, not an error", () => {
    const workdir = makeWorkdir();
    mkdirSync(join(workdir, "supabase", "custom"), { recursive: true });
    writeFileSync(join(workdir, "supabase", "custom", "x.sql"), "select 1;\n");
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const result = yield* legacyLoadDeclaredSchemas(
        fs,
        path,
        workdir,
        ["custom/*.sql", "empty-glob/*.sql"],
        pgDelta(),
      );
      expect(result).toEqual(["supabase/custom/x.sql"]);
      rmSync(workdir, { recursive: true, force: true });
    }).pipe(Effect.provide(BunServices.layer));
  });
});
