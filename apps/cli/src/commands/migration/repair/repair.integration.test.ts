import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";

import { stripAnsi } from "../../../../tests/helpers/ansi.ts";
import {
  VALID_REF,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockTelemetryStateTracked,
  useTempWorkdir,
  sequentialExecBatch,
} from "../../../../tests/helpers/command-mocks.ts";
import { mockOutput, mockStdin, mockTty } from "../../../../tests/helpers/mocks.ts";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { DnsResolverFlag, YesFlag } from "../../../command-internal/global-flags.ts";
import type { OutputFormat } from "../../../shared/output/types.ts";
import { ProjectRefNotLinkedError } from "../../../config/project-ref.errors.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import type { DbConfigFlags, ResolvedDbConfig } from "../../../command-internal/db-config.types.ts";
import { DbExecError } from "../../../command-internal/db-connection.errors.ts";
import { type DbSession, DbConnection } from "../../../command-internal/db-connection.service.ts";
import { migrationRepair, type MigrationRepairInput } from "./repair.handler.ts";

interface SetupOpts {
  readonly format?: OutputFormat;
  readonly isTTY?: boolean;
  readonly pipedInput?: string;
  readonly yes?: boolean;
  readonly confirm?: boolean;
  readonly args?: ReadonlyArray<string>;
  readonly failSql?: string;
  readonly failResolve?: boolean;
}

function setup(workdir: string, opts: SetupOpts = {}) {
  const out = mockOutput({
    format: opts.format ?? "text",
    promptConfirmResponses: opts.confirm === undefined ? undefined : [opts.confirm],
  });
  const telemetry = mockTelemetryStateTracked();
  const cache = mockLinkedProjectCacheTracked();

  const execs: Array<string> = [];
  const queries: Array<{ sql: string; params?: ReadonlyArray<unknown> }> = [];

  const resolver = Layer.succeed(DbConfigResolver, {
    resolve: (_flags: DbConfigFlags) =>
      opts.failResolve === true
        ? Effect.fail(
            new ProjectRefNotLinkedError({
              message: "Cannot find project ref. Have you run link?",
            }),
          )
        : Effect.succeed({
            conn: {
              host: "127.0.0.1",
              port: 54322,
              user: "postgres",
              password: "x",
              database: "postgres",
            },
            isLocal: false,
            ref: Option.some(VALID_REF),
          } satisfies ResolvedDbConfig),
    resolvePoolerFallback: () => Effect.succeed(Option.none()),
  });

  const connection = Layer.succeed(DbConnection, {
    connect: () => {
      const session: DbSession = {
        exec: (sql: string) =>
          Effect.suspend(() => {
            execs.push(sql);
            return opts.failSql !== undefined && sql.includes(opts.failSql)
              ? Effect.fail(new DbExecError({ message: "boom" }))
              : Effect.void;
          }),
        query: (sql: string, params?: ReadonlyArray<unknown>) =>
          Effect.suspend(() => {
            queries.push({ sql, params });
            return opts.failSql !== undefined && sql.includes(opts.failSql)
              ? Effect.fail(new DbExecError({ message: "boom" }))
              : Effect.succeed<ReadonlyArray<Record<string, unknown>>>([]);
          }),
        extensionExists: () => Effect.succeed(false),
        copyToCsv: () => Effect.succeed(new Uint8Array()),
        queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
        // Replays each statement through exec/query so recordings and failure injection apply.
        execBatch: (statements) => sequentialExecBatch(session)(statements),
      };
      return Effect.succeed(session);
    },
  });

  // Gives an explicit --project-ref flag precedence over the VALID_REF fallback, so a
  // test can prove the flag drives the linked ref.
  const projectRef = Layer.succeed(ProjectRefResolver, {
    resolve: () => Effect.succeed(VALID_REF),
    resolveForLink: () => Effect.succeed(VALID_REF),
    resolveOptional: () => Effect.succeed(Option.some(VALID_REF)),
    loadProjectRef: (flagValue: Option.Option<string>) =>
      Effect.succeed(
        Option.isSome(flagValue) && flagValue.value.length > 0 ? flagValue.value : VALID_REF,
      ),
    promptProjectRef: () => Effect.succeed(VALID_REF),
  });

  const layer = Layer.mergeAll(
    out.layer,
    telemetry.layer,
    cache.layer,
    resolver,
    connection,
    projectRef,
    mockCommandSettings({ workdir }),
    Layer.succeed(DnsResolverFlag, "native"),
    Layer.succeed(YesFlag, opts.yes ?? false),
    Layer.succeed(CliArgs, { args: opts.args ?? [] }),
    mockTty({ stdinIsTty: opts.isTTY ?? true }),
    mockStdin(
      opts.isTTY ?? true,
      // Migration prompts read stdin directly, so the confirm answer is piped in.
      opts.pipedInput ?? (opts.confirm === undefined ? undefined : opts.confirm ? "y\n" : "n\n"),
    ),
    BunServices.layer,
  );
  return { layer, out, telemetry, execs, queries, cache };
}

const input = (over: Partial<MigrationRepairInput> = {}): MigrationRepairInput => ({
  versions: over.versions ?? [],
  status: over.status ?? "applied",
  dbUrl: over.dbUrl ?? Option.none(),
  linked: over.linked ?? true,
  local: over.local ?? false,
  projectRef: over.projectRef ?? Option.none(),
  password: over.password ?? Option.none(),
});

const seedMigration = (workdir: string, name: string, body: string) => {
  const dir = join(workdir, "supabase", "migrations");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body);
};

const tmp = useTempWorkdir();

describe("migration repair", () => {
  it.live("marks a version as applied by upserting from its local file", () => {
    seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
    const { layer, execs, queries, out } = setup(tmp.current);
    return Effect.gen(function* () {
      yield* migrationRepair(input({ versions: ["20240101000000"], status: "applied" }));
      expect(stripAnsi(out.stderrText)).toContain("Connecting to remote database...");
      expect(execs).toContain("BEGIN");
      expect(execs).toContain("COMMIT");
      expect(execs).not.toContain("ROLLBACK");
      const upsert = queries.find((q) => q.sql.includes("ON CONFLICT"));
      expect(upsert?.params).toEqual(["20240101000000", "init", ["create table a"]]);
    }).pipe(Effect.provide(layer));
  });

  it.live("resolves the DB target before parsing positional versions", () => {
    const { layer } = setup(tmp.current, { failResolve: true });
    return Effect.gen(function* () {
      const exit = yield* migrationRepair(
        input({ versions: ["not-a-number"], status: "applied" }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe("ProjectRefNotLinkedError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("caches the linked project even when the repair-all prompt is declined", () => {
    const { layer, cache } = setup(tmp.current, { confirm: false });
    return Effect.gen(function* () {
      const exit = yield* migrationRepair(input({ versions: [], status: "applied" })).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe("OperationCanceledError");
      }
      expect(cache.cached).toBe(true);
      expect(cache.cachedRef).toBe(VALID_REF);
    }).pipe(Effect.provide(layer));
  });

  it.live("marks versions as reverted by deleting them", () => {
    const { layer, queries } = setup(tmp.current);
    return Effect.gen(function* () {
      yield* migrationRepair(
        input({ versions: ["20240101000000", "20240102000000"], status: "reverted" }),
      );
      const del = queries.find((q) => q.sql.includes("WHERE version = ANY"));
      expect(del?.params).toEqual([["20240101000000", "20240102000000"]]);
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects a non-numeric version", () => {
    const { layer } = setup(tmp.current);
    return Effect.gen(function* () {
      const exit = yield* migrationRepair(
        input({ versions: ["not-a-number"], status: "applied" }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe("MigrationInvalidVersionError");
        // Unlike db reset's bare message, migration repair keeps the "failed to parse <v>:" wrapper.
        expect(Option.isSome(failure) && failure.value.message).toBe(
          "failed to parse not-a-number: invalid version number",
        );
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects a version outside Go's int range before any DB mutation", () => {
    const { layer, execs, queries } = setup(tmp.current);
    return Effect.gen(function* () {
      const exit = yield* migrationRepair(
        input({ versions: ["99999999999999999999"], status: "applied" }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe("MigrationInvalidVersionError");
      }
      expect(execs).not.toContain("BEGIN");
      expect(queries.some((q) => q.sql.includes("ON CONFLICT"))).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("repair-all truncates and reapplies local files on confirm", () => {
    seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
    const { layer, execs, queries } = setup(tmp.current, { confirm: true });
    return Effect.gen(function* () {
      yield* migrationRepair(input({ versions: [], status: "applied" }));
      expect(execs).toContain("TRUNCATE supabase_migrations.schema_migrations");
      expect(queries.some((q) => q.sql.includes("ON CONFLICT"))).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "repair-all with --status reverted wipes the whole history (no upserts, no deletes)",
    () => {
      // repair-all + reverted only queues TRUNCATE; DELETE is the non-repair-all path
      // and UPSERT is the applied path.
      seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
      const { layer, execs, queries } = setup(tmp.current, { confirm: true });
      return Effect.gen(function* () {
        yield* migrationRepair(input({ versions: [], status: "reverted" }));
        expect(execs).toContain("TRUNCATE supabase_migrations.schema_migrations");
        expect(queries.some((q) => q.sql.includes("ON CONFLICT"))).toBe(false);
        expect(queries.some((q) => q.sql.includes("WHERE version = ANY"))).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("repair-all cancels on a declined prompt", () => {
    seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
    const { layer, execs } = setup(tmp.current, { confirm: false });
    return Effect.gen(function* () {
      const exit = yield* migrationRepair(input({ versions: [], status: "applied" })).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe("OperationCanceledError");
      }
      expect(execs).not.toContain("TRUNCATE supabase_migrations.schema_migrations");
    }).pipe(Effect.provide(layer));
  });

  it.live("repair-all without a TTY and no piped answer falls back to NO (cancel)", () => {
    // isTTY only changes the read timeout; stdin is still read either way.
    const { layer, out } = setup(tmp.current, { isTTY: false });
    return Effect.gen(function* () {
      const exit = yield* migrationRepair(input({ versions: [], status: "applied" })).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe("OperationCanceledError");
      }
      expect(out.promptConfirmCalls.length).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("repair-all honors a piped 'y' answer without a TTY (proceeds)", () => {
    // Piped stdin is read even without a TTY, overriding the default no.
    seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
    const { layer, execs, queries } = setup(tmp.current, { isTTY: false, pipedInput: "y\n" });
    return Effect.gen(function* () {
      yield* migrationRepair(input({ versions: [], status: "applied" }));
      expect(execs).toContain("TRUNCATE supabase_migrations.schema_migrations");
      expect(queries.some((q) => q.sql.includes("ON CONFLICT"))).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("auto-confirms repair-all via SUPABASE_YES (no --yes flag)", () => {
    const previous = process.env["SUPABASE_YES"];
    process.env["SUPABASE_YES"] = "1";
    seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
    const { layer, execs, queries } = setup(tmp.current);
    return Effect.gen(function* () {
      yield* migrationRepair(input({ versions: [], status: "applied" }));
      expect(execs).toContain("TRUNCATE supabase_migrations.schema_migrations");
      expect(queries.some((q) => q.sql.includes("ON CONFLICT"))).toBe(true);
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(
        Effect.sync(() => {
          if (previous === undefined) delete process.env["SUPABASE_YES"];
          else process.env["SUPABASE_YES"] = previous;
        }),
      ),
    );
  });

  it.live(
    "auto-confirms repair-all via SUPABASE_YES in the project .env (Go loadNestedEnv)",
    () => {
      // SUPABASE_YES lives only in supabase/.env; the project env loads it before the prompt.
      seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
      writeFileSync(join(tmp.current, "supabase", ".env"), "SUPABASE_YES=true\n");
      const { layer, execs, queries } = setup(tmp.current);
      return Effect.gen(function* () {
        yield* migrationRepair(input({ versions: [], status: "applied" }));
        expect(execs).toContain("TRUNCATE supabase_migrations.schema_migrations");
        expect(queries.some((q) => q.sql.includes("ON CONFLICT"))).toBe(true);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("surfaces a DB-config error before prompting (repair-all, unlinked)", () => {
    const { layer, out } = setup(tmp.current, { failResolve: true });
    return Effect.gen(function* () {
      const exit = yield* migrationRepair(input({ versions: [], status: "applied" })).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe("ProjectRefNotLinkedError");
      }
      expect(out.promptConfirmCalls.length).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("prints the repaired, finished, and suggestion lines on success", () => {
    seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
    const { layer, out } = setup(tmp.current);
    return Effect.gen(function* () {
      yield* migrationRepair(input({ versions: ["20240101000000"], status: "applied" }));
      const stderr = stripAnsi(out.stderrText);
      const stdout = stripAnsi(out.stdoutText);
      expect(stderr).toContain("Repaired migration history: [20240101000000] => applied");
      expect(stdout).toContain("Finished supabase migration repair.");
      expect(stderr).toContain(
        "Run supabase migration list to show the updated migration history.",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("prints multiple repaired versions using Go's %v slice format", () => {
    // The established format is space-separated and bracketed, with no commas; a
    // `.join(", ")` cleanup would silently change established output.
    seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
    seedMigration(tmp.current, "20240102000000_more.sql", "create table b;\n");
    const { layer, out } = setup(tmp.current);
    return Effect.gen(function* () {
      yield* migrationRepair(
        input({ versions: ["20240101000000", "20240102000000"], status: "applied" }),
      );
      expect(stripAnsi(out.stderrText)).toContain(
        "Repaired migration history: [20240101000000 20240102000000] => applied",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("reports a missing local file in applied mode", () => {
    const { layer } = setup(tmp.current); // no seeded file
    return Effect.gen(function* () {
      const exit = yield* migrationRepair(
        input({ versions: ["20240101000000"], status: "applied" }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe("MigrationFileNotFoundError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("rolls back and reports an update failure", () => {
    const { layer, execs } = setup(tmp.current, { failSql: "WHERE version = ANY" });
    return Effect.gen(function* () {
      const exit = yield* migrationRepair(
        input({ versions: ["20240101000000"], status: "reverted" }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe("MigrationRepairUpdateError");
      }
      expect(execs).toContain("ROLLBACK");
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects --db-url combined with --linked", () => {
    const { layer } = setup(tmp.current, { args: ["--db-url", "postgresql://x", "--linked"] });
    return Effect.gen(function* () {
      const exit = yield* migrationRepair(
        input({
          versions: ["20240101000000"],
          status: "applied",
          dbUrl: Option.some("postgresql://x"),
        }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe("MigrationTargetFlagsError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("repairs the project given via --project-ref, overriding the default linked ref", () => {
    // VALID_REF is the fake resolver's fallback; the flag must win over it and drive
    // the cached ref.
    const FLAG_REF = "flagflagflagflagflag";
    seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
    const { layer, cache } = setup(tmp.current);
    return Effect.gen(function* () {
      yield* migrationRepair(
        input({
          versions: ["20240101000000"],
          status: "applied",
          projectRef: Option.some(FLAG_REF),
        }),
      );
      expect(cache.cached).toBe(true);
      expect(cache.cachedRef).toBe(FLAG_REF);
      expect(cache.cachedRef).not.toBe(VALID_REF);
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects --project-ref combined with an explicit --local target", () => {
    const FLAG_REF = "flagflagflagflagflag";
    const { layer, execs, queries, cache } = setup(tmp.current, { args: ["--local"] });
    return Effect.gen(function* () {
      const exit = yield* migrationRepair(
        input({
          versions: ["20240101000000"],
          status: "applied",
          linked: false,
          local: true,
          projectRef: Option.some(FLAG_REF),
        }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe("MigrationTargetFlagsError");
        expect(Option.isSome(failure) && (failure.value as { message: string }).message).toBe(
          "--project-ref only applies when targeting the linked project; use it with --linked (not --local or --db-url)",
        );
      }
      expect(execs).toEqual([]);
      expect(queries).toEqual([]);
      expect(cache.cached).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a structured result in json mode", () => {
    const { layer, out } = setup(tmp.current, { format: "json" });
    return Effect.gen(function* () {
      yield* migrationRepair(input({ versions: ["20240101000000"], status: "reverted" }));
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "Migration history repaired",
          data: { versions: ["20240101000000"], status: "reverted", repairAll: false },
        }),
      );
    }).pipe(Effect.provide(layer));
  });
});
