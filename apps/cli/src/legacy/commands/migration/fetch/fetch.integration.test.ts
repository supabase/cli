import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";

import {
  LEGACY_VALID_REF,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { LegacyDnsResolverFlag, LegacyYesFlag } from "../../../../shared/legacy/global-flags.ts";
import type { OutputFormat } from "../../../../shared/output/types.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import type {
  LegacyDbConfigFlags,
  LegacyResolvedDbConfig,
} from "../../../shared/legacy-db-config.types.ts";
import { LegacyDbConnection } from "../../../shared/legacy-db-connection.service.ts";
import { legacyMigrationFetch } from "./fetch.handler.ts";
import type { LegacyMigrationFetchFlags } from "./fetch.command.ts";

const SELECT_SQL =
  "SELECT version, coalesce(name, '') as name, statements FROM supabase_migrations.schema_migrations";

interface MigrationRow {
  readonly version: string;
  readonly name: string;
  readonly statements: ReadonlyArray<string>;
}

interface SetupOpts {
  readonly format?: OutputFormat;
  readonly yes?: boolean;
  readonly confirm?: boolean;
  readonly rows?: ReadonlyArray<MigrationRow>;
}

function setup(workdir: string, opts: SetupOpts = {}) {
  const out = mockOutput({
    format: opts.format ?? "text",
    promptConfirmResponses: opts.confirm === undefined ? undefined : [opts.confirm],
  });
  const telemetry = mockLegacyTelemetryStateTracked();
  const cache = mockLegacyLinkedProjectCacheTracked();

  const resolver = Layer.succeed(LegacyDbConfigResolver, {
    resolve: (_flags: LegacyDbConfigFlags) =>
      Effect.succeed({
        conn: {
          host: "127.0.0.1",
          port: 54322,
          user: "postgres",
          password: "x",
          database: "postgres",
        },
        isLocal: false,
        ref: Option.some(LEGACY_VALID_REF),
      } satisfies LegacyResolvedDbConfig),
    resolvePoolerFallback: () => Effect.succeed(Option.none()),
  });

  const connection = Layer.succeed(LegacyDbConnection, {
    connect: () =>
      Effect.succeed({
        exec: () => Effect.void,
        query: (sql: string) =>
          Effect.suspend(() =>
            sql === SELECT_SQL
              ? Effect.succeed((opts.rows ?? []).map((r) => ({ ...r })))
              : Effect.succeed([]),
          ),
        extensionExists: () => Effect.succeed(false),
        copyToCsv: () => Effect.succeed(new Uint8Array()),
        queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
      }),
  });

  const projectRef = Layer.succeed(LegacyProjectRefResolver, {
    resolve: () => Effect.succeed(LEGACY_VALID_REF),
    resolveForLink: () => Effect.succeed(LEGACY_VALID_REF),
    resolveOptional: () => Effect.succeed(Option.some(LEGACY_VALID_REF)),
    loadProjectRef: () => Effect.succeed(LEGACY_VALID_REF),
    promptProjectRef: () => Effect.succeed(LEGACY_VALID_REF),
  });

  const layer = Layer.mergeAll(
    out.layer,
    telemetry.layer,
    cache.layer,
    resolver,
    connection,
    projectRef,
    mockLegacyCliConfig({ workdir }),
    Layer.succeed(LegacyDnsResolverFlag, "native"),
    Layer.succeed(LegacyYesFlag, opts.yes ?? false),
    Layer.succeed(CliArgs, { args: [] }),
    BunServices.layer,
  );
  return { layer, out, telemetry };
}

const flags = (over: Partial<LegacyMigrationFetchFlags> = {}): LegacyMigrationFetchFlags => ({
  dbUrl: over.dbUrl ?? Option.none(),
  linked: over.linked ?? true,
  local: over.local ?? false,
});

const migrationsDir = (workdir: string) => join(workdir, "supabase", "migrations");
const tmp = useLegacyTempWorkdir();

describe("legacy migration fetch", () => {
  it.live("writes migration files joined with the Go separator when the dir is empty", () => {
    const { layer } = setup(tmp.current, {
      rows: [
        {
          version: "20240101000000",
          name: "init",
          statements: ["create table a", "create index b"],
        },
      ],
    });
    return Effect.gen(function* () {
      yield* legacyMigrationFetch(flags());
      const dir = migrationsDir(tmp.current);
      const files = readdirSync(dir);
      expect(files).toEqual(["20240101000000_init.sql"]);
      expect(readFileSync(join(dir, files[0]!), "utf8")).toBe("create table a;\ncreate index b;\n");
    }).pipe(Effect.provide(layer));
  });

  it.live("writes a lone separator for a row with no statements (Go parity)", () => {
    // A `schema_migrations` row can legally have a NULL/empty `statements` array
    // (older projects, manually-inserted rows). Go does `strings.Join(stmts, ";\n")
    // + ";\n"`, so an empty array yields exactly ";\n" — a file with a stray
    // semicolon, not an empty file. The strict-1:1 port keeps these bytes; lock it
    // so a future "emit an empty file instead" refactor is a conscious divergence.
    const { layer } = setup(tmp.current, {
      rows: [{ version: "20240101000000", name: "empty", statements: [] }],
    });
    return Effect.gen(function* () {
      yield* legacyMigrationFetch(flags());
      const dir = migrationsDir(tmp.current);
      expect(readFileSync(join(dir, "20240101000000_empty.sql"), "utf8")).toBe(";\n");
    }).pipe(Effect.provide(layer));
  });

  it.live("prompts before overwriting a non-empty directory and proceeds on yes", () => {
    mkdirSync(migrationsDir(tmp.current), { recursive: true });
    writeFileSync(join(migrationsDir(tmp.current), "existing.sql"), "select 1;\n");
    const { layer } = setup(tmp.current, {
      confirm: true,
      rows: [{ version: "20240101000000", name: "init", statements: ["create table a"] }],
    });
    return Effect.gen(function* () {
      yield* legacyMigrationFetch(flags());
      expect(readdirSync(migrationsDir(tmp.current))).toContain("20240101000000_init.sql");
    }).pipe(Effect.provide(layer));
  });

  it.live("cancels with context canceled when the overwrite prompt is declined", () => {
    mkdirSync(migrationsDir(tmp.current), { recursive: true });
    writeFileSync(join(migrationsDir(tmp.current), "existing.sql"), "select 1;\n");
    const { layer } = setup(tmp.current, {
      confirm: false,
      rows: [{ version: "20240101000000", name: "init", statements: ["create table a"] }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyMigrationFetch(flags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe("LegacyOperationCanceledError");
      }
      // No new file written on cancel.
      expect(readdirSync(migrationsDir(tmp.current))).toEqual(["existing.sql"]);
    }).pipe(Effect.provide(layer));
  });

  it.live("bypasses the overwrite prompt with --yes (echoes the auto-answer)", () => {
    mkdirSync(migrationsDir(tmp.current), { recursive: true });
    writeFileSync(join(migrationsDir(tmp.current), "existing.sql"), "select 1;\n");
    const { layer, out } = setup(tmp.current, {
      yes: true,
      rows: [{ version: "20240101000000", name: "init", statements: ["create table a"] }],
    });
    return Effect.gen(function* () {
      yield* legacyMigrationFetch(flags());
      expect(out.stderrText).toContain("[Y/n] y");
      expect(readdirSync(migrationsDir(tmp.current))).toContain("20240101000000_init.sql");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits fetched files in json without prompting", () => {
    mkdirSync(migrationsDir(tmp.current), { recursive: true });
    writeFileSync(join(migrationsDir(tmp.current), "existing.sql"), "select 1;\n");
    const { layer, out } = setup(tmp.current, {
      format: "json",
      rows: [{ version: "20240101000000", name: "init", statements: ["create table a"] }],
    });
    return Effect.gen(function* () {
      yield* legacyMigrationFetch(flags());
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "Migration history fetched",
          data: { files: [join(migrationsDir(tmp.current), "20240101000000_init.sql")] },
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects a hostile version/name from the history table (path traversal guard)", () => {
    // A tampered remote `schema_migrations` row could use `..`/separators to
    // escape the migrations dir (CWE-22). The guard rejects it before writing.
    const { layer } = setup(tmp.current, {
      rows: [{ version: "20240101000000", name: "../../../etc/passwd", statements: [] }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyMigrationFetch(flags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe("LegacyMigrationFetchWriteError");
      }
      // Nothing is written when the guard fires.
      expect(readdirSync(migrationsDir(tmp.current))).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live("reports a write failure", () => {
    // A file at <workdir>/supabase makes `makeDirectory(supabase/migrations)` fail.
    writeFileSync(join(tmp.current, "supabase"), "not a directory");
    const { layer } = setup(tmp.current, { rows: [] });
    return Effect.gen(function* () {
      const exit = yield* legacyMigrationFetch(flags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe("LegacyMigrationFetchWriteError");
      }
    }).pipe(Effect.provide(layer));
  });
});
