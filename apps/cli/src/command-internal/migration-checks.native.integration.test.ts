import { BunServices } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { vi } from "vitest";
import { Cause, Context, Effect, Exit, FileSystem, Layer, Option, Path, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";

import { stripAnsi } from "../../tests/helpers/ansi.ts";
import {
  mockCommandCredentialsLayer,
  mockCommandPlatformApi,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockTelemetryStateTracked,
} from "../../tests/helpers/command-mocks.ts";
import { cliConfigValuesTestLayer } from "../../tests/helpers/config-values-layer.ts";
import { mockOutput, mockProcessControl, mockTty } from "../../tests/helpers/mocks.ts";
import { selection } from "../../tests/helpers/pins.ts";
import { destroyTestStack } from "../../tests/helpers/stack-cleanup.ts";
import type { DbAdvisorsFlags } from "../commands/db/advisors/advisors.command.ts";
import { dbAdvisors } from "../commands/db/advisors/advisors.handler.ts";
import type { MigrationDownFlags } from "../commands/migration/down/down.command.ts";
import { migrationDown } from "../commands/migration/down/down.handler.ts";
import { migrationUp } from "../commands/migration/up/up.handler.ts";
import type { MigrationUpFlags } from "../commands/migration/up/up.command.ts";
import { ProjectRefResolver } from "../config/project-ref.service.ts";
import { CliArgs } from "../shared/cli/cli-args.service.ts";
import { DbConfigResolver } from "./db-config.service.ts";
import { parseConnectionString } from "./db-config.parse.ts";
import { DbExecError } from "./db-connection.errors.ts";
import { dbConnectionLayer } from "./db-connection.sql-pg.layer.ts";
import { DbConnection, type DbSession, type PgConnInput } from "./db-connection.service.ts";
import { DnsResolverFlag, OutputFlag, YesFlag } from "./global-flags.ts";
import { migrateAndSeed } from "./migrate-and-seed.ts";
import { MigrationApplyError, applyMigrations } from "./migration-apply.ts";
import { MigrationChecksBlockedError, MigrationChecksTimeoutMs } from "./migration-checks.ts";
import { resolveMigrationChecksPolicy } from "./migration-checks-policy.ts";
import { StackApi, stackApiLayer } from "./stack-api.ts";
import { TargetPolicy } from "./target/target-policy.ts";

class TestDatabase extends Context.Service<TestDatabase, { readonly conn: PgConnInput }>()(
  "test/migration-checks/TestDatabase",
) {}

const testDatabaseLayer = Layer.effect(
  TestDatabase,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "cli-migration-checks-db-" });
    const api = yield* StackApi;
    const stack = yield* Effect.acquireRelease(
      api.create({
        projectRoot: root,
        stateRoot: `${root}/stacks`,
        cacheRoot: `${root}/cache`,
        runtime: "native",
      }),
      destroyTestStack,
    );
    const [database] = yield* stack.composition.supabase([
      {
        service: "database" as const,
        pin: selection.database,
        config: {
          databasePassword: Redacted.make("cli-migration-checks-password"),
          jwtSecret: Redacted.make("cli-migration-checks-jwt-secret-at-least-32-chars"),
          jwtExpiry: 3600,
        },
        endpoints: { sql: { port: "auto" as const } },
      },
    ]);
    if (database === undefined) return yield* Effect.die("database was not composed");
    yield* database.start;
    yield* database.ready;
    const { databaseUrl } = yield* database.credentials({ from: "host" });
    if (databaseUrl === undefined) return yield* Effect.die("host database URL missing");
    const conn = yield* parseConnectionString(databaseUrl);
    if (conn === undefined) return yield* Effect.die("invalid host database URL");
    return { conn: { ...conn, user: "postgres" } };
  }),
).pipe(
  Layer.provide(stackApiLayer),
  Layer.provideMerge(dbConnectionLayer),
  Layer.provideMerge(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
);

const localTarget = {
  dbUrl: Option.none(),
  remote: Option.none(),
  linked: false,
  local: true,
  projectRef: Option.none(),
} as const;

const upFlags = (skipChecks = false): MigrationUpFlags => ({
  includeAll: false,
  skipChecks,
  ...localTarget,
});

const withSession = <A, E, R>(use: (session: DbSession) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const { conn } = yield* TestDatabase;
    const dbConnection = yield* DbConnection;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        return yield* use(
          yield* dbConnection.connect(conn, { isLocal: true, dnsResolver: "native" }),
        );
      }),
    );
  });

const sql = (statement: string) => withSession((session) => session.query(statement));

const tableExists = (name: string) =>
  sql(`select to_regclass('public.${name}') is not null as present`).pipe(
    Effect.map((rows) => rows[0]?.["present"] === true),
  );

const historyVersions = sql(
  "select version from supabase_migrations.schema_migrations order by version",
).pipe(Effect.map((rows) => rows.map((row) => row["version"])));

/** Each case owns `public` and the history table, so an earlier case's tables never add findings. */
const resetDatabase = sql(`do $$
declare t record;
begin
  for t in select tablename from pg_catalog.pg_tables where schemaname = 'public' loop
    execute pg_catalog.format('drop table public.%I cascade', t.tablename);
  end loop;
  if pg_catalog.to_regclass('supabase_migrations.schema_migrations') is not null then
    truncate supabase_migrations.schema_migrations;
  end if;
end $$`);

/** Writes a project with `config.toml` and migration files on a reset database. */
const makeProject = Effect.fnUntraced(function* (input: {
  readonly config: string;
  readonly migrations: Readonly<Record<string, string>>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* resetDatabase;
  const workdir = yield* fs.makeTempDirectoryScoped({ prefix: "cli-migration-checks-" });
  const migrationsDir = path.join(workdir, "supabase", "migrations");
  yield* fs.makeDirectory(migrationsDir, { recursive: true });
  yield* fs.writeFileString(path.join(workdir, "supabase", "config.toml"), input.config);
  for (const [name, content] of Object.entries(input.migrations)) {
    yield* fs.writeFileString(path.join(migrationsDir, name), content);
  }
  return { workdir, migrationsDir };
});

/** Runs a command handler against the test database as a local target. */
const runCommand = Effect.fnUntraced(function* <A, E, R>(
  workdir: string,
  command: Effect.Effect<A, E, R>,
  opts: { readonly format?: "text" | "json"; readonly timeoutMs?: number } = {},
) {
  const { conn } = yield* TestDatabase;
  const output = mockOutput({ format: opts.format ?? "text" });
  const exit = yield* command.pipe(
    Effect.provideService(MigrationChecksTimeoutMs, opts.timeoutMs ?? 2000),
    Effect.provide(
      Layer.mergeAll(
        output.layer,
        mockCommandSettings({ workdir }),
        mockTelemetryStateTracked().layer,
        mockLinkedProjectCacheTracked().layer,
        mockCommandCredentialsLayer,
        mockCommandPlatformApi().factoryLayer,
        mockProcessControl().layer,
        cliConfigValuesTestLayer,
        mockTty(),
        Layer.succeed(TargetPolicy, { group: "selectable", consent: "no" }),
        Layer.succeed(YesFlag, false),
        Layer.succeed(OutputFlag, Option.none()),
        Layer.succeed(DnsResolverFlag, "native"),
        Layer.succeed(CliArgs, { args: [] }),
        Layer.succeed(DbConfigResolver, {
          resolveConnection: (resolveInput) =>
            Effect.succeed({
              conn,
              isLocal: true,
              ref: Option.none(),
              target: resolveInput.target,
            }),
          resolvePoolerFallback: () => Effect.succeed(Option.none()),
        }),
        Layer.succeed(ProjectRefResolver, {
          resolve: () => Effect.die("unused"),
          resolveForLink: () => Effect.die("unused"),
          resolveRef: () => Effect.die("unused"),
          resolveOptional: () => Effect.die("unused"),
          promptProjectRef: () => Effect.die("unused"),
        }),
      ),
    ),
    Effect.exit,
  );
  return { exit, output, stderr: stripAnsi(output.stderrText) };
});

/** Writes a project, then runs `migration up` on it. */
const runUp = Effect.fnUntraced(function* (input: {
  readonly config: string;
  readonly migrations: Readonly<Record<string, string>>;
  readonly skipChecks?: boolean;
  readonly format?: "text" | "json";
  readonly timeoutMs?: number;
}) {
  const { workdir } = yield* makeProject(input);
  return yield* runCommand(workdir, migrationUp(upFlags(input.skipChecks)), input);
});

/** The run's `MigrationChecksBlockedError`, failing the test on any other outcome. */
const blockedError = (exit: Exit.Exit<unknown, unknown>): MigrationChecksBlockedError => {
  const error = Exit.isFailure(exit)
    ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
    : undefined;
  if (!(error instanceof MigrationChecksBlockedError)) {
    throw new Error(`expected MigrationChecksBlockedError, got ${String(error)}`);
  }
  return error;
};

const successChecks = (output: ReturnType<typeof mockOutput>) =>
  output.messages.find((message) => message.type === "success")?.data?.["checks"];

/**
 * Every line fits the 80-column output width, except a URL, which stays whole on its own line, and
 * a suggested SQL statement, which is never wrapped so it copies as written.
 */
const expectWrapped = (text: string) => {
  for (const line of stripAnsi(text).split("\n")) {
    if (line.length > 80 && !line.trimEnd().endsWith(";")) expect(line.trim()).not.toContain(" ");
  }
};

/** Collapses wrapping so a phrase can be asserted wherever the lines broke. */
const unwrapped = (text: string) => stripAnsi(text).replace(/\s+/gu, " ");

const RLS_ERROR = '[db.migrations.checks]\nrls_disabled_in_public = "error"\n';

layer(testDatabaseLayer, { timeout: 240_000, excludeTestServices: true })(
  "migration security checks",
  (it) => {
    it.effect("an error-level finding rolls back the file and its history row", () =>
      Effect.gen(function* () {
        vi.stubEnv("CLICOLOR_FORCE", "1");
        const { exit, output } = yield* runUp({
          config: RLS_ERROR,
          migrations: { "20261001000000_blocked.sql": "create table public.blocked_t(id int);\n" },
        }).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())));

        const error = blockedError(exit);
        // Only the tag is coloured, and a reset keeps the red `Output.fail` applies from re-opening after it.
        expect(error.message.replace("\u001b[31m[error]\u001b[39m\u001b[0m", "")).not.toContain(
          "\u001b",
        );
        expectWrapped(error.message);
        expectWrapped(error.suggestion ?? "");
        expect(error.reason).toBe("blocked");
        expect(error.errorCode).toBe("SB001");
        const message = stripAnsi(error.message);
        expect(message).toMatch(/^SB001: Migration 20261001000000_blocked.sql was rolled back/u);
        expect(message).toContain("Table `public.blocked_t` is public");
        expect(message).toContain("rls_disabled_in_public: public.blocked_t (table)");
        expect(message).toContain("Fix:");
        expect(error.suggestion).toContain("[db.migrations.checks.exclude]");
        expect(error.suggestion).not.toContain("--baseline");
        expect(output.stderrText).not.toContain("Security checks found");
        expect(yield* tableExists("blocked_t")).toBe(false);
        expect(yield* historyVersions).toEqual([]);
      }),
    );

    it.effect(
      "recreating a table that already had an error-level finding is blocked and points at --baseline",
      () =>
        Effect.gen(function* () {
          const { workdir } = yield* makeProject({
            config: RLS_ERROR,
            migrations: {
              "20261001000010_recreate.sql":
                "drop table public.legacy_t;\ncreate table public.legacy_t(id int);\n",
            },
          });
          yield* sql("create table public.legacy_t(id int)");

          const { exit } = yield* runCommand(workdir, migrationUp(upFlags()));

          const error = blockedError(exit);
          const message = stripAnsi(error.message);
          expect(message).toContain("rls_disabled_in_public: public.legacy_t");
          expect(unwrapped(message)).toContain(
            "1 existing security finding at error must be resolved or baselined",
          );
          expect(message).not.toContain("security check failed");
          expect(unwrapped(message)).toContain("Run supabase db advisors --baseline to exclude");
          expect(yield* historyVersions).toEqual([]);
        }),
    );

    it.effect("a warn-level finding applies the file and reports it in the JSON result", () =>
      Effect.gen(function* () {
        const { exit, output, stderr } = yield* runUp({
          config: "",
          migrations: { "20261001000001_warned.sql": "create table public.warned_t(id int);\n" },
          format: "json",
        });

        expect(Exit.isSuccess(exit)).toBe(true);
        expect(yield* tableExists("warned_t")).toBe(true);
        expect(yield* historyVersions).toEqual(["20261001000001"]);
        expect(stderr).not.toContain("Security checks found");
        expect(successChecks(output)).toMatchObject({
          outcome: "applied_with_findings",
          findings: [
            {
              rule: "rls_disabled_in_public",
              severity: "warn",
              schema: "public",
              name: "warned_t",
            },
          ],
        });
      }),
    );

    it.effect("a blocked file still reports the warnings of the files committed before it", () =>
      Effect.gen(function* () {
        const { exit, stderr } = yield* runUp({
          config: RLS_ERROR,
          migrations: {
            "20261001000011_first.sql":
              "create table public.first_t(id int);\nalter table public.first_t enable row level security;\n",
            "20261001000012_second.sql": "create table public.second_t(id int);\n",
          },
        });

        expect(blockedError(exit).reason).toBe("blocked");
        expect(stderr).toContain("WARNING: Security checks found 1 warning");
        expect(stderr).toContain("rls_enabled_no_policy: public.first_t");
        expect(yield* historyVersions).toEqual(["20261001000011"]);
      }),
    );

    it.effect("a rule set to off reports nothing for its findings", () =>
      Effect.gen(function* () {
        const { exit, stderr } = yield* runUp({
          config: '[db.migrations.checks]\nrls_disabled_in_public = "off"\n',
          migrations: { "20261001000002_off.sql": "create table public.off_t(id int);\n" },
        });

        expect(Exit.isSuccess(exit)).toBe(true);
        expect(yield* tableExists("off_t")).toBe(true);
        expect(stderr).not.toContain("Security checks found");
      }),
    );

    it.effect("an excluded relation passes an error-level rule", () =>
      Effect.gen(function* () {
        const { exit, stderr } = yield* runUp({
          config: `${RLS_ERROR}[db.migrations.checks.exclude]\nrls_disabled_in_public = ["public.excluded_t"]\n`,
          migrations: {
            "20261001000003_excluded.sql": "create table public.excluded_t(id int);\n",
          },
        });

        expect(Exit.isSuccess(exit)).toBe(true);
        expect(yield* tableExists("excluded_t")).toBe(true);
        expect(stderr).not.toContain("excluded_t");
      }),
    );

    for (const [label, content] of [
      [
        "a concurrent index",
        "create table public.split_t(id int);\ncreate index concurrently split_t_id on public.split_t(id);\n",
      ],
      ["authored transaction control", "begin;\ncreate table public.split_t(id int);\ncommit;\n"],
      [
        "transaction=false",
        "-- pg-delta: transaction=false\ncreate table public.split_t(id int);\n",
      ],
    ] as const) {
      it.effect(`a file run outside one transaction (${label}) stays applied and reports`, () =>
        Effect.gen(function* () {
          const { exit, stderr } = yield* runUp({
            config: RLS_ERROR,
            migrations: { "20261001000004_split.sql": content },
          });

          const error = blockedError(exit);
          expect(error.errorCode).toBe("SB001");
          expect(error.message).toContain("20261001000004_split.sql was already committed");
          expect(stderr).toContain("Security checks found 1 error after this run");
          expect(stderr).toContain("rls_disabled_in_public: public.split_t");
          expect(stderr).not.toContain("WARNING");
          expect(yield* tableExists("split_t")).toBe(true);
          expect(yield* historyVersions).toEqual(["20261001000004"]);
        }),
      );
    }

    it.effect("the after-commit report marks errors that predate the run", () =>
      Effect.gen(function* () {
        const { workdir } = yield* makeProject({
          config: RLS_ERROR,
          migrations: {
            "20261001000005_split.sql":
              "create table public.fresh_t(id int);\ncreate index concurrently fresh_t_id on public.fresh_t(id);\n",
          },
        });
        yield* sql("create table public.legacy_t(id int)");

        const { exit, stderr } = yield* runCommand(workdir, migrationUp(upFlags()));

        blockedError(exit);
        expect(stderr).toContain("Security checks found 1 error after this run:");
        expect(stderr).toContain(
          "Also 1 existing security finding at error that predates this run.",
        );
        expect(stderr.indexOf("public.fresh_t")).toBeLessThan(stderr.indexOf("Also 1 existing"));
        expect(stderr.indexOf("Also 1 existing")).toBeLessThan(stderr.indexOf("public.legacy_t"));
        expect(unwrapped(stderr).match(/Restrict to service_role/g)).toHaveLength(1);
        expect(unwrapped(stderr)).toContain(
          "Fix: same as public.fresh_t above, applied to public.legacy_t.",
        );
        expectWrapped(stderr);
      }),
    );

    it.effect("a file checked after commit fails the run when the after-commit read fails", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { migrationsDir } = yield* makeProject({
          config: "",
          migrations: {
            "20261001000013_unread.sql":
              "-- pg-delta: transaction=false\ncreate table public.unread_t(id int);\n",
          },
        });
        const output = mockOutput();
        let findingReads = 0;

        const exit = yield* withSession((session) =>
          applyMigrations(
            {
              ...session,
              // Fails the second findings read, the one after the run commits.
              query: (statement, params) =>
                statement.startsWith("select l.*") && ++findingReads === 2
                  ? Effect.fail(new DbExecError({ message: "connection reset" }))
                  : session.query(statement, params),
            },
            fs,
            path,
            [path.join(migrationsDir, "20261001000013_unread.sql")],
            (message) => new MigrationApplyError({ message }),
            {
              policy: resolveMigrationChecksPolicy({ rls_disabled_in_public: "error" }),
              exposedSchemas: ["public"],
              skip: false,
              targetFlags: "",
            },
          ),
        ).pipe(Effect.provide(output.layer), Effect.exit);

        const error = blockedError(exit);
        expect(error.reason).toBe("unchecked");
        expect(error.message).toContain("20261001000013_unread.sql");
        expect(stripAnsi(output.stderrText)).toContain(
          "Security checks could not read the database after this run",
        );
        expect(yield* tableExists("unread_t")).toBe(true);
      }),
    );

    it.effect("a check that times out rolls back the file", () =>
      Effect.gen(function* () {
        const { exit } = yield* runUp({
          config: RLS_ERROR,
          migrations: { "20261001000014_slow.sql": "create table public.slow_t(id int);\n" },
          timeoutMs: 1,
        });

        const error = blockedError(exit);
        expect(error.reason).toBe("timed_out");
        expect(error.errorCode).toBe("SB002");
        expect(error.message).toMatch(/^SB002: /u);
        expect(error.suggestion).toContain("--skip-checks");
        expect(yield* tableExists("slow_t")).toBe(false);
        expect(yield* historyVersions).toEqual([]);
      }),
    );

    it.effect("an [api].schemas entry with a comma fails before applying anything", () =>
      Effect.gen(function* () {
        const { exit } = yield* runUp({
          config: `[api]\nschemas = ["public", "a,b"]\n\n${RLS_ERROR}`,
          migrations: { "20261001000015_comma.sql": "create table public.comma_t(id int);\n" },
        });

        const error = blockedError(exit);
        expect(error.reason).toBe("invalid_config");
        expect(error.message).toContain('"a,b"');
        expect(yield* tableExists("comma_t")).toBe(false);
      }),
    );

    it.effect("--skip-checks applies an error-level finding and says checks were skipped", () =>
      Effect.gen(function* () {
        const { exit, stderr } = yield* runUp({
          config: RLS_ERROR,
          migrations: { "20261001000005_skipped.sql": "create table public.skipped_t(id int);\n" },
          skipChecks: true,
        });

        expect(Exit.isSuccess(exit)).toBe(true);
        expect(yield* tableExists("skipped_t")).toBe(true);
        expect(stderr).toContain("Skipping security checks (--skip-checks)");
      }),
    );

    it.effect("a local replay fails on an error-level finding after applying every file", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { workdir } = yield* makeProject({
          config: "",
          migrations: {
            "20261001000006_replay.sql": "create table public.replay_t(id int);\n",
            "20261001000007_replay_more.sql": "create table public.replay_more_t(id int);\n",
          },
        });
        const output = mockOutput();

        const exit = yield* withSession((session) =>
          migrateAndSeed(session, fs, path, workdir, "", {
            migrationsEnabled: true,
            seed: { enabled: false, sqlPaths: [] },
            experimental: false,
            pgDeltaEnabled: true,
            schemaPaths: [],
            checks: {
              migrationChecks: resolveMigrationChecksPolicy({ rls_disabled_in_public: "error" }),
              apiSchemas: ["public"],
            },
          }),
        ).pipe(Effect.provide(output.layer), Effect.exit);

        const replayError = blockedError(exit);
        const message = stripAnsi(replayError.message);
        expect(unwrapped(message)).toContain("The database is left with every migration applied");
        expect(unwrapped(replayError.suggestion ?? "")).toContain(
          "supabase db advisors --baseline",
        );
        expect(replayError.suggestion).toContain("--skip-checks");
        expectWrapped(message);
        expectWrapped(replayError.suggestion ?? "");
        expect(message.indexOf("public.replay_more_t")).toBeLessThan(
          message.indexOf("public.replay_t"),
        );
        expect(message).toContain("rls_disabled_in_public: public.replay_t (table)");
        expect(message).toContain("rls_disabled_in_public: public.replay_more_t (table)");
        expect(yield* tableExists("replay_more_t")).toBe(true);
      }),
    );

    it.effect("migration down checks the replayed end state", () =>
      Effect.gen(function* () {
        const { workdir } = yield* makeProject({
          config: RLS_ERROR,
          migrations: {
            "20261001000016_kept.sql":
              "create table public.down_t(id int);\ncreate table public.down_a_t(id int);\n",
            "20261001000017_reverted.sql": "create table public.reverted_t(id int);\n",
          },
        });
        const up = yield* runCommand(workdir, migrationUp(upFlags(true)));
        expect(Exit.isSuccess(up.exit)).toBe(true);
        const downFlags = (skipChecks: boolean): MigrationDownFlags => ({
          last: 1,
          skipChecks,
          ...localTarget,
        });

        const blocked = yield* runCommand(workdir, migrationDown(downFlags(false)));
        yield* runCommand(workdir, migrationUp(upFlags(true)));
        const skipped = yield* runCommand(workdir, migrationDown(downFlags(true)));

        const downError = blockedError(blocked.exit);
        const downMessage = stripAnsi(downError.message);
        expect(downMessage).toContain("rls_disabled_in_public: public.down_t (table)");
        expect(downMessage.indexOf("public.down_a_t")).toBeLessThan(
          downMessage.indexOf("public.down_t "),
        );
        expect(downError.suggestion).toContain("--skip-checks");
        expect(Exit.isSuccess(skipped.exit)).toBe(true);
        expect(skipped.stderr).toContain("Skipping security checks (--skip-checks)");
        expect(yield* tableExists("reverted_t")).toBe(false);
      }),
    );

    it.effect(
      "db advisors --baseline excludes existing findings so a later migration is not blocked",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const config =
            '# project settings\n[db.migrations.checks]\n# block exposed tables without RLS\nrls_disabled_in_public = "error"\n\n[api]\nenabled = true\n';
          const { workdir } = yield* makeProject({
            config,
            migrations: {
              "20261001000018_new.sql":
                "create table public.new_t(id int);\nalter table public.new_t enable row level security;\n",
            },
          });
          yield* sql("create table public.legacy_t(id int)");
          const configPath = `${workdir}/supabase/config.toml`;
          const baselineFlags: DbAdvisorsFlags = {
            ...localTarget,
            type: Option.none(),
            level: Option.none(),
            failOn: Option.none(),
            baseline: true,
          };

          const first = yield* runCommand(workdir, dbAdvisors(baselineFlags));
          const written = yield* fs.readFileString(configPath);
          const second = yield* runCommand(workdir, dbAdvisors(baselineFlags));
          const up = yield* runCommand(workdir, migrationUp(upFlags()));

          expect(Exit.isSuccess(first.exit)).toBe(true);
          expect(written).toBe(
            '# project settings\n[db.migrations.checks]\n# block exposed tables without RLS\nrls_disabled_in_public = "error"\n\n[db.migrations.checks.exclude]\nrls_disabled_in_public = ["public.legacy_t"]\n\n[api]\nenabled = true\n',
          );
          expect(first.output.stdoutText).toContain("rls_disabled_in_public: public.legacy_t");
          expect(Exit.isSuccess(second.exit)).toBe(true);
          expect(yield* fs.readFileString(configPath)).toBe(written);
          expect(second.output.stdoutText).toContain("No new findings");
          expect(Exit.isSuccess(up.exit)).toBe(true);
          expect(yield* historyVersions).toEqual(["20261001000018"]);
        }),
    );
  },
);
