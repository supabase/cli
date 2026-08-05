import {
  ProjectConfigSchema,
  type LoadedProjectConfig,
  type ProjectEnvironment,
} from "@supabase/config";
import { Effect, Schema } from "effect";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { translateDatabaseBootstrapConfig } from "./database-bootstrap-config.ts";

const decodeProjectConfig = Schema.decodeUnknownSync(ProjectConfigSchema);

function loaded(
  projectRoot: string,
  document: Record<string, unknown>,
  options: { readonly appliedRemote?: string } = {},
): LoadedProjectConfig {
  return {
    path: join(projectRoot, "supabase", "config.toml"),
    format: "toml",
    config: decodeProjectConfig(document),
    document,
    appliedRemote: options.appliedRemote,
    ignoredPaths: [],
  };
}

function environment(
  projectRoot: string,
  values: Readonly<Record<string, string>>,
): ProjectEnvironment {
  return {
    paths: {
      projectRoot,
      supabaseDir: join(projectRoot, "supabase"),
      configPath: join(projectRoot, "supabase", "config.toml"),
      envPath: join(projectRoot, "supabase", ".env"),
      envLocalPath: join(projectRoot, "supabase", ".env.local"),
    },
    values,
    loadedPaths: [],
    sources: {},
  };
}

describe("translateDatabaseBootstrapConfig", () => {
  it("resolves ordered, deduplicated seed inputs", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "stack-database-bootstrap-"));
    const supabaseDir = join(projectRoot, "supabase");
    try {
      await mkdir(join(supabaseDir, "seeds", "nested"), { recursive: true });
      await writeFile(join(supabaseDir, "seeds", "a.sql"), "insert into a values (1);");
      await writeFile(join(supabaseDir, "seeds", "nested", "b.sql"), "insert into b values (2);");

      const result = await Effect.runPromise(
        translateDatabaseBootstrapConfig({
          loadedProjectConfig: loaded(projectRoot, {
            db: {
              migrations: { enabled: false },
              seed: { enabled: true, sql_paths: ["./seeds", "./seeds/a.sql"] },
            },
          }),
          projectEnvironment: null,
          projectRoot,
        }),
      );

      expect(result.config?.seedFiles?.map(({ historyPath }) => historyPath)).toEqual([
        "supabase/seeds/a.sql",
        "supabase/seeds/nested/b.sql",
      ]);
      expect(
        result.config?.seedFiles?.every(({ checksum }) => /^[0-9a-f]{64}$/.test(checksum)),
      ).toBe(true);
      expect(result.warnings).toEqual([]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("blocks conventional migrations until the stack executor preserves legacy semantics", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "stack-database-migrations-"));
    const supabaseDir = join(projectRoot, "supabase");
    try {
      await mkdir(join(supabaseDir, "migrations"), { recursive: true });
      await writeFile(join(supabaseDir, "migrations", "1_private-migration.sql"), "VACUUM;");

      const exit = await Effect.runPromise(
        translateDatabaseBootstrapConfig({
          loadedProjectConfig: loaded(projectRoot, { db: { seed: { enabled: false } } }),
          projectEnvironment: null,
          projectRoot,
        }).pipe(Effect.exit),
      );

      expect(JSON.stringify(exit)).toContain("db.migrations.enabled");
      expect(JSON.stringify(exit)).not.toContain("private-migration.sql");
      expect(JSON.stringify(exit)).not.toContain("VACUUM");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("allows migration discovery to be explicitly disabled", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "stack-database-migrations-disabled-"));
    const supabaseDir = join(projectRoot, "supabase");
    try {
      await mkdir(join(supabaseDir, "migrations"), { recursive: true });
      await writeFile(join(supabaseDir, "migrations", "1_existing.sql"), "select 1;");

      const result = await Effect.runPromise(
        translateDatabaseBootstrapConfig({
          loadedProjectConfig: loaded(projectRoot, {
            db: { migrations: { enabled: false }, seed: { enabled: false } },
          }),
          projectEnvironment: null,
          projectRoot,
        }),
      );

      expect(result).toEqual({ config: undefined, warnings: [] });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("allows migrations to remain enabled when no conventional files exist", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "stack-database-migrations-empty-"));
    try {
      await mkdir(join(projectRoot, "supabase", "migrations"), { recursive: true });

      const result = await Effect.runPromise(
        translateDatabaseBootstrapConfig({
          loadedProjectConfig: loaded(projectRoot, {
            db: { migrations: { enabled: true }, seed: { enabled: false } },
          }),
          projectEnvironment: null,
          projectRoot,
        }),
      );

      expect(result).toEqual({ config: undefined, warnings: [] });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("attributes migration discovery failures to db.migrations only", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "stack-database-migration-errors-"));
    const supabaseDir = join(projectRoot, "supabase");
    try {
      await mkdir(supabaseDir, { recursive: true });
      await writeFile(join(supabaseDir, "migrations"), "not a directory");

      const exit = await Effect.runPromise(
        translateDatabaseBootstrapConfig({
          loadedProjectConfig: loaded(projectRoot, { db: { seed: { enabled: false } } }),
          projectEnvironment: null,
          projectRoot,
        }).pipe(Effect.exit),
      );

      expect(JSON.stringify(exit)).toContain("db.migrations");
      expect(JSON.stringify(exit)).not.toContain("db.seed.sql_paths");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("rejects declarative schema paths without exposing their values", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "stack-database-schema-"));
    const supabaseDir = join(projectRoot, "supabase");
    try {
      await mkdir(join(supabaseDir, "migrations"), { recursive: true });
      await mkdir(join(supabaseDir, "schemas"), { recursive: true });
      await writeFile(join(supabaseDir, "migrations", "20240101000000_ignored.sql"), "select 0;");
      await writeFile(join(supabaseDir, "schemas", "first.sql"), "select 1;");
      await writeFile(join(supabaseDir, "schemas", "second.sql"), "select 2;");

      const exit = await Effect.runPromise(
        translateDatabaseBootstrapConfig({
          loadedProjectConfig: loaded(projectRoot, {
            db: {
              migrations: {
                enabled: true,
                schema_paths: ["./schemas/second.sql", "./schemas/first.sql"],
              },
              seed: { enabled: false },
            },
          }),
          projectEnvironment: null,
          projectRoot,
        }).pipe(Effect.exit),
      );

      expect(JSON.stringify(exit)).toContain("db.migrations.schema_paths");
      expect(JSON.stringify(exit)).not.toContain("second.sql");
      expect(JSON.stringify(exit)).not.toContain("first.sql");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("applies Go-compatible env overrides while preserving remote precedence", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "stack-database-env-"));
    const supabaseDir = join(projectRoot, "supabase");
    try {
      await mkdir(join(supabaseDir, "migrations"), { recursive: true });
      await writeFile(join(supabaseDir, "migrations", "20240101000000_remote.sql"), "select 1;");
      const document = {
        db: {
          migrations: { enabled: false },
          seed: { enabled: false },
        },
        remotes: {
          staging: {
            project_id: "abcdefghijklmnopqrst",
            db: { migrations: { enabled: false }, seed: { enabled: false } },
          },
        },
      };

      const result = await Effect.runPromise(
        translateDatabaseBootstrapConfig({
          loadedProjectConfig: loaded(projectRoot, document, { appliedRemote: "staging" }),
          projectEnvironment: environment(projectRoot, {
            SUPABASE_DB_MIGRATIONS_ENABLED: "false",
            SUPABASE_DB_SEED_ENABLED: "true",
          }),
          projectRoot,
        }),
      );

      expect(result.config).toBeUndefined();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("reports malformed overrides by config path only and warns on unmatched globs", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "stack-database-errors-"));
    try {
      await mkdir(join(projectRoot, "supabase"), { recursive: true });
      const malformed = await Effect.runPromise(
        translateDatabaseBootstrapConfig({
          loadedProjectConfig: loaded(projectRoot, {}),
          projectEnvironment: environment(projectRoot, {
            SUPABASE_DB_SEED_ENABLED: "private-invalid-boolean",
          }),
          projectRoot,
        }).pipe(Effect.exit),
      );
      const unmatched = await Effect.runPromise(
        translateDatabaseBootstrapConfig({
          loadedProjectConfig: loaded(projectRoot, {
            db: {
              migrations: { enabled: false },
              seed: { enabled: true, sql_paths: ["./private-missing-seed.sql"] },
            },
          }),
          projectEnvironment: null,
          projectRoot,
        }),
      );

      expect(JSON.stringify(malformed)).toContain("db.seed.enabled");
      expect(JSON.stringify(malformed)).not.toContain("private-invalid-boolean");
      expect(unmatched.config).toBeUndefined();
      expect(unmatched.warnings).toEqual([
        {
          paths: ["db.seed.sql_paths"],
          message:
            "Some configured db.seed.sql_paths patterns matched no SQL files and were skipped.",
        },
      ]);
      expect(JSON.stringify(unmatched.warnings)).not.toContain("private-missing-seed.sql");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
