import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";

import { stripAnsi } from "../../../../../tests/helpers/ansi.ts";
import {
  LEGACY_VALID_REF,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { mockOutput, mockStdin, mockTty } from "../../../../../tests/helpers/mocks.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { LegacyDnsResolverFlag, LegacyYesFlag } from "../../../../shared/legacy/global-flags.ts";
import type { OutputFormat } from "../../../../shared/output/types.ts";
import { LegacyProjectNotLinkedError } from "../../../config/legacy-project-ref.errors.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import type {
  LegacyDbConfigFlags,
  LegacyResolvedDbConfig,
} from "../../../shared/legacy-db-config.types.ts";
import { LegacyDbExecError } from "../../../shared/legacy-db-connection.errors.ts";
import { LegacyDbConnection } from "../../../shared/legacy-db-connection.service.ts";
import { legacyMigrationRepair, type LegacyMigrationRepairInput } from "./repair.handler.ts";

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
  const telemetry = mockLegacyTelemetryStateTracked();
  const cache = mockLegacyLinkedProjectCacheTracked();

  const execs: Array<string> = [];
  const queries: Array<{ sql: string; params?: ReadonlyArray<unknown> }> = [];

  const resolver = Layer.succeed(LegacyDbConfigResolver, {
    resolve: (_flags: LegacyDbConfigFlags) =>
      opts.failResolve === true
        ? Effect.fail(
            new LegacyProjectNotLinkedError({
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
            ref: Option.some(LEGACY_VALID_REF),
          } satisfies LegacyResolvedDbConfig),
    resolvePoolerFallback: () => Effect.succeed(Option.none()),
  });

  const connection = Layer.succeed(LegacyDbConnection, {
    connect: () =>
      Effect.succeed({
        exec: (sql: string) =>
          Effect.suspend(() => {
            execs.push(sql);
            return opts.failSql !== undefined && sql.includes(opts.failSql)
              ? Effect.fail(new LegacyDbExecError({ message: "boom" }))
              : Effect.void;
          }),
        query: (sql: string, params?: ReadonlyArray<unknown>) =>
          Effect.suspend(() => {
            queries.push({ sql, params });
            return opts.failSql !== undefined && sql.includes(opts.failSql)
              ? Effect.fail(new LegacyDbExecError({ message: "boom" }))
              : Effect.succeed<ReadonlyArray<Record<string, unknown>>>([]);
          }),
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
    Layer.succeed(CliArgs, { args: opts.args ?? [] }),
    mockTty({ stdinIsTty: opts.isTTY ?? true }),
    mockStdin(
      opts.isTTY ?? true,
      // Migration prompts read stdin directly, so a confirm answer is
      // supplied via piped stdin rather than the Output prompt mock.
      opts.pipedInput ?? (opts.confirm === undefined ? undefined : opts.confirm ? "y\n" : "n\n"),
    ),
    BunServices.layer,
  );
  return { layer, out, telemetry, execs, queries, cache };
}

const input = (over: Partial<LegacyMigrationRepairInput> = {}): LegacyMigrationRepairInput => ({
  versions: over.versions ?? [],
  status: over.status ?? "applied",
  dbUrl: over.dbUrl ?? Option.none(),
  linked: over.linked ?? true,
  local: over.local ?? false,
  password: over.password ?? Option.none(),
});

const seedMigration = (workdir: string, name: string, body: string) => {
  const dir = join(workdir, "supabase", "migrations");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body);
};

const tmp = useLegacyTempWorkdir();

describe("legacy migration repair", () => {
  it.live("marks a version as applied by upserting from its local file", () => {
    seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
    const { layer, execs, queries, out } = setup(tmp.current);
    return Effect.gen(function* () {
      yield* legacyMigrationRepair(input({ versions: ["20240101000000"], status: "applied" }));
      // The connection banner prints to stderr before dialing.
      expect(stripAnsi(out.stderrText)).toContain("Connecting to remote database...");
      // One transaction: BEGIN ... COMMIT, no ROLLBACK.
      expect(execs).toContain("BEGIN");
      expect(execs).toContain("COMMIT");
      expect(execs).not.toContain("ROLLBACK");
      const upsert = queries.find((q) => q.sql.includes("ON CONFLICT"));
      expect(upsert?.params).toEqual(["20240101000000", "init", ["create table a"]]);
    }).pipe(Effect.provide(layer));
  });

  it.live("resolves the DB target before parsing positional versions", () => {
    // The DB config resolves before
    // version parsing, so an unlinked target error wins over a bad version.
    const { layer } = setup(tmp.current, { failResolve: true });
    return Effect.gen(function* () {
      const exit = yield* legacyMigrationRepair(
        input({ versions: ["not-a-number"], status: "applied" }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        // The config/target error surfaces first, NOT the invalid-version error.
        expect(Option.isSome(failure) && failure.value._tag).toBe("LegacyProjectNotLinkedError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("caches the linked project even when the repair-all prompt is declined", () => {
    // The project cache runs regardless of the
    // handler's own failure, so a declined repair-all (cancellation) still caches the ref.
    const { layer, cache } = setup(tmp.current, { confirm: false });
    return Effect.gen(function* () {
      const exit = yield* legacyMigrationRepair(input({ versions: [], status: "applied" })).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe("LegacyOperationCanceledError");
      }
      expect(cache.cached).toBe(true);
      expect(cache.cachedRef).toBe(LEGACY_VALID_REF);
    }).pipe(Effect.provide(layer));
  });

  it.live("marks versions as reverted by deleting them", () => {
    const { layer, queries } = setup(tmp.current);
    return Effect.gen(function* () {
      yield* legacyMigrationRepair(
        input({ versions: ["20240101000000", "20240102000000"], status: "reverted" }),
      );
      const del = queries.find((q) => q.sql.includes("WHERE version = ANY"));
      expect(del?.params).toEqual([["20240101000000", "20240102000000"]]);
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects a non-numeric version", () => {
    const { layer } = setup(tmp.current);
    return Effect.gen(function* () {
      const exit = yield* legacyMigrationRepair(
        input({ versions: ["not-a-number"], status: "applied" }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe(
          "LegacyMigrationInvalidVersionError",
        );
        // Guard: unlike `db reset` (bare `invalid version number`),
        // `migration repair` keeps the established `failed to parse <v>:` wrapper.
        expect(Option.isSome(failure) && failure.value.message).toBe(
          "failed to parse not-a-number: invalid version number",
        );
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects a version outside Go's int range before any DB mutation", () => {
    const { layer, execs, queries } = setup(tmp.current);
    return Effect.gen(function* () {
      // Explicit versions validate with a strict integer parse, which
      // rejects values above the int64 range; a 20-digit version must fail
      // `invalid version number` before any glob/upsert/delete.
      const exit = yield* legacyMigrationRepair(
        input({ versions: ["99999999999999999999"], status: "applied" }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe(
          "LegacyMigrationInvalidVersionError",
        );
      }
      // Validation runs before connecting, so no transaction or upsert occurred.
      expect(execs).not.toContain("BEGIN");
      expect(queries.some((q) => q.sql.includes("ON CONFLICT"))).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("repair-all truncates and reapplies local files on confirm", () => {
    seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
    const { layer, execs, queries } = setup(tmp.current, { confirm: true });
    return Effect.gen(function* () {
      yield* legacyMigrationRepair(input({ versions: [], status: "applied" }));
      expect(execs).toContain("TRUNCATE supabase_migrations.schema_migrations");
      expect(queries.some((q) => q.sql.includes("ON CONFLICT"))).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "repair-all with --status reverted wipes the whole history (no upserts, no deletes)",
    () => {
      // repair-all + reverted queues ONLY TRUNCATE: the per-version DELETE is
      // the non-repair-all path and the UPSERT is the applied path, so the net
      // effect is wiping the entire history table.
      seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
      const { layer, execs, queries } = setup(tmp.current, { confirm: true });
      return Effect.gen(function* () {
        yield* legacyMigrationRepair(input({ versions: [], status: "reverted" }));
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
      const exit = yield* legacyMigrationRepair(input({ versions: [], status: "applied" })).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe("LegacyOperationCanceledError");
      }
      expect(execs).not.toContain("TRUNCATE supabase_migrations.schema_migrations");
    }).pipe(Effect.provide(layer));
  });

  it.live("repair-all without a TTY and no piped answer falls back to NO (cancel)", () => {
    // Stdin is read regardless of TTY (isTTY only changes the timeout);
    // with no piped answer the empty read falls back to the default (NO) → cancel.
    const { layer, out } = setup(tmp.current, { isTTY: false });
    return Effect.gen(function* () {
      const exit = yield* legacyMigrationRepair(input({ versions: [], status: "applied" })).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe("LegacyOperationCanceledError");
      }
      expect(out.promptConfirmCalls.length).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("repair-all honors a piped 'y' answer without a TTY (proceeds)", () => {
    // Piped stdin is read even when non-interactive; a piped `y` overrides
    // the default NO, so repair-all truncates and reapplies.
    seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
    const { layer, execs, queries } = setup(tmp.current, { isTTY: false, pipedInput: "y\n" });
    return Effect.gen(function* () {
      yield* legacyMigrationRepair(input({ versions: [], status: "applied" }));
      // Proceeded: repair-all truncates then upserts the local file.
      expect(execs).toContain("TRUNCATE supabase_migrations.schema_migrations");
      expect(queries.some((q) => q.sql.includes("ON CONFLICT"))).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("auto-confirms repair-all via SUPABASE_YES (no --yes flag)", () => {
    // SUPABASE_YES=1 auto-confirms without --yes.
    const previous = process.env["SUPABASE_YES"];
    process.env["SUPABASE_YES"] = "1";
    seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
    const { layer, execs, queries } = setup(tmp.current);
    return Effect.gen(function* () {
      yield* legacyMigrationRepair(input({ versions: [], status: "applied" }));
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
      // SUPABASE_YES set only in supabase/.env (not the shell) — the project env loads it
      // before the repair-all prompt, so it auto-confirms with no --yes flag and no stdin answer.
      seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
      writeFileSync(join(tmp.current, "supabase", ".env"), "SUPABASE_YES=true\n");
      const { layer, execs, queries } = setup(tmp.current);
      return Effect.gen(function* () {
        yield* legacyMigrationRepair(input({ versions: [], status: "applied" }));
        expect(execs).toContain("TRUNCATE supabase_migrations.schema_migrations");
        expect(queries.some((q) => q.sql.includes("ON CONFLICT"))).toBe(true);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("surfaces a DB-config error before prompting (repair-all, unlinked)", () => {
    const { layer, out } = setup(tmp.current, { failResolve: true });
    return Effect.gen(function* () {
      const exit = yield* legacyMigrationRepair(input({ versions: [], status: "applied" })).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe("LegacyProjectNotLinkedError");
      }
      // The DB config resolves before any prompt, so the
      // config error surfaces immediately and the repair-all confirmation is never shown.
      expect(out.promptConfirmCalls.length).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("prints the repaired, finished, and suggestion lines on success", () => {
    seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
    const { layer, out } = setup(tmp.current);
    return Effect.gen(function* () {
      yield* legacyMigrationRepair(input({ versions: ["20240101000000"], status: "applied" }));
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
    // The established slice format prints
    // space-separated, bracketed, NO commas. A `.join(", ")` "cleanup" reads more
    // natural in TS but would silently break byte parity, so lock the format here.
    seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
    seedMigration(tmp.current, "20240102000000_more.sql", "create table b;\n");
    const { layer, out } = setup(tmp.current);
    return Effect.gen(function* () {
      yield* legacyMigrationRepair(
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
      const exit = yield* legacyMigrationRepair(
        input({ versions: ["20240101000000"], status: "applied" }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe(
          "LegacyMigrationFileNotFoundError",
        );
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("rolls back and reports an update failure", () => {
    const { layer, execs } = setup(tmp.current, { failSql: "WHERE version = ANY" });
    return Effect.gen(function* () {
      const exit = yield* legacyMigrationRepair(
        input({ versions: ["20240101000000"], status: "reverted" }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe(
          "LegacyMigrationRepairUpdateError",
        );
      }
      expect(execs).toContain("ROLLBACK");
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects --db-url combined with --linked", () => {
    const { layer } = setup(tmp.current, { args: ["--db-url", "postgresql://x", "--linked"] });
    return Effect.gen(function* () {
      const exit = yield* legacyMigrationRepair(
        input({
          versions: ["20240101000000"],
          status: "applied",
          dbUrl: Option.some("postgresql://x"),
        }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe(
          "LegacyMigrationTargetFlagsError",
        );
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a structured result in json mode", () => {
    const { layer, out } = setup(tmp.current, { format: "json" });
    return Effect.gen(function* () {
      yield* legacyMigrationRepair(input({ versions: ["20240101000000"], status: "reverted" }));
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
