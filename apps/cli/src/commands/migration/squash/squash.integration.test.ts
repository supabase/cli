import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Option } from "effect";
import { PlatformError, SystemError } from "effect/PlatformError";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { stripAnsi } from "../../../../tests/helpers/ansi.ts";
import {
  FAKE_SHADOW_CONTAINER_ID,
  VALID_REF,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockShadowContainerCliSpawner,
  mockTelemetryStateTracked,
  useShadowCacheDisabled,
  useTempWorkdir,
  sequentialExecBatch,
} from "../../../../tests/helpers/command-mocks.ts";
import {
  mockOutput,
  mockRuntimeInfo,
  mockStdin,
  mockTty,
} from "../../../../tests/helpers/mocks.ts";
import { dockerfileServiceImage } from "../../../shared/services/dockerfile-images.ts";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { getRegistryImageUrl } from "../../../command-internal/docker-registry.ts";
import {
  DebugFlag,
  DnsResolverFlag,
  ExperimentalFlag,
  NetworkIdFlag,
  YesFlag,
} from "../../../command-internal/global-flags.ts";
import type { OutputFormat } from "../../../shared/output/types.ts";
import { ProjectRefNotLinkedError } from "../../../config/project-ref.errors.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { INTERNAL_SCHEMAS } from "../../../command-internal/pg-dump.env.ts";
import { dumpSchemaScript } from "../../../command-internal/pg-dump.scripts.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import type { DbConfigFlags, ResolvedDbConfig } from "../../../command-internal/db-config.types.ts";
import { DbExecError } from "../../../command-internal/db-connection.errors.ts";
import {
  DbConnection,
  type DbSession,
  type PgConnInput,
} from "../../../command-internal/db-connection.service.ts";
import { DebugLogger } from "../../../command-internal/debug-logger.service.ts";
import { DockerRun, type DockerRunOpts } from "../../../command-internal/docker-run.service.ts";
import type { MigrationSquashFlags } from "./squash.command.ts";
import { migrationSquash } from "./squash.handler.ts";

// Distinguishes squash's three pg_dump containers from the shadow's setup jobs by env:
// only a pg_dump invocation carries PGDATABASE. Among dump calls, the first two sharing
// EXTRA_FLAGS=--schema=auth|storage are the before/after dumps in call order; a call
// with no EXTRA_FLAGS is the full dump.
function mockSquashDockerRun(
  opts: {
    readonly beforeSql?: string;
    readonly afterSql?: string;
    readonly fullSql?: string;
    readonly failDump?: "before" | "after" | "full";
    readonly failSetupJob?: boolean;
  } = {},
) {
  const dumpCalls: Array<DockerRunOpts> = [];
  const setupJobCalls: Array<DockerRunOpts> = [];
  let authStorageCalls = 0;

  const layer = Layer.succeed(DockerRun, {
    run: () => Effect.die("DockerRun.run is unused by migration squash"),
    runCapture: () => Effect.die("DockerRun.runCapture is unused by migration squash"),
    runStream: (dockerOpts, streamOpts) => {
      const isDump = dockerOpts.env["PGDATABASE"] !== undefined;
      if (!isDump) {
        setupJobCalls.push(dockerOpts);
        return Effect.succeed({ exitCode: opts.failSetupJob === true ? 1 : 0, stderr: "" });
      }
      dumpCalls.push(dockerOpts);
      const isAuthStorage = dockerOpts.env["EXTRA_FLAGS"] === "--schema=auth|storage";
      let kind: "before" | "after" | "full";
      let sql: string;
      if (isAuthStorage) {
        authStorageCalls += 1;
        kind = authStorageCalls === 1 ? "before" : "after";
        sql = kind === "before" ? (opts.beforeSql ?? "") : (opts.afterSql ?? "");
      } else {
        kind = "full";
        sql = opts.fullSql ?? "";
      }
      const exitCode = opts.failDump === kind ? 1 : 0;
      return streamOpts
        .onStdout(new TextEncoder().encode(sql))
        .pipe(Effect.as({ exitCode, stderr: "" }));
    },
  });

  return { layer, dumpCalls, setupJobCalls };
}

// A wrapper layer covering every filesystem failure these scenarios need, keyed by
// exact absolute path so unrelated setup reads/writes stay unaffected.
const simulatedFsError = (path: string, method: string) =>
  new PlatformError(
    new SystemError({
      _tag: "Unknown",
      module: "FileSystem",
      method,
      pathOrDescriptor: path,
      description: "simulated failure",
    }),
  );

interface FsFaultOpts {
  /** Makes `fs.open(path, { flag: "w" })` itself fail — squash's one target-file open call. */
  readonly failOpenPath?: string;
  /**
   * Lets the Nth+ `writeAll` call on the open handle for `path` fail (1-indexed),
   * succeeding on every earlier call, so the full-dump write (call 1) and the
   * separator/diff tail write (call 2) can be failed independently.
   */
  readonly failWriteAllFromCall?: { readonly path: string; readonly fromCall: number };
  readonly failRemovePath?: string;
  readonly failReadDirectoryAtCall?: { readonly path: string; readonly atCall: number };
}

function faultyFsLayer(opts: FsFaultOpts): Layer.Layer<FileSystem.FileSystem> {
  return Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (real) => {
      let readDirCallsForPath = 0;
      return FileSystem.FileSystem.of({
        ...real,
        remove: (path, removeOpts) =>
          opts.failRemovePath !== undefined && path === opts.failRemovePath
            ? Effect.fail(simulatedFsError(path, "remove"))
            : real.remove(path, removeOpts),
        readDirectory: (path, readOpts) => {
          if (
            opts.failReadDirectoryAtCall !== undefined &&
            path === opts.failReadDirectoryAtCall.path
          ) {
            readDirCallsForPath += 1;
            if (readDirCallsForPath === opts.failReadDirectoryAtCall.atCall) {
              return Effect.fail(simulatedFsError(path, "readDirectory"));
            }
          }
          return real.readDirectory(path, readOpts);
        },
        open: (path, openOpts) => {
          if (
            opts.failOpenPath !== undefined &&
            path === opts.failOpenPath &&
            openOpts?.flag === "w"
          ) {
            return Effect.fail(simulatedFsError(path, "open"));
          }
          return real.open(path, openOpts).pipe(
            Effect.map((file) => {
              if (
                opts.failWriteAllFromCall === undefined ||
                path !== opts.failWriteAllFromCall.path
              ) {
                return file;
              }
              let writeAllCalls = 0;
              return {
                ...file,
                writeAll: (buffer: Uint8Array) => {
                  writeAllCalls += 1;
                  return writeAllCalls >= opts.failWriteAllFromCall!.fromCall
                    ? Effect.fail(simulatedFsError(path, "writeAll"))
                    : file.writeAll(buffer);
                },
              };
            }),
          );
        },
      });
    }),
  ).pipe(Layer.provide(BunServices.layer));
}

const alwaysReadyHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))),
  ),
);

interface SetupOpts {
  readonly format?: OutputFormat;
  readonly isTTY?: boolean;
  readonly pipedInput?: string;
  readonly yes?: boolean;
  readonly confirm?: boolean;
  readonly args?: ReadonlyArray<string>;
  readonly isLocal?: boolean;
  readonly linkedRef?: string;
  /** Omits `ref` entirely from the resolved config, matching the real resolver's own `--local`/`--db-url` shape (`ref` is an optional field, not always `None` — see `db-config.types.ts`). */
  readonly omitRef?: boolean;
  readonly failResolve?: boolean;
  readonly failSql?: string;
  readonly networkId?: string;
  readonly neverHealthyShadow?: boolean;
  readonly failCreateShadow?: boolean;
  readonly failRemoveShadow?: boolean;
  readonly failSetupJob?: boolean;
  readonly beforeDumpSql?: string;
  readonly afterDumpSql?: string;
  readonly fullDumpSql?: string;
  readonly failDumpKind?: "before" | "after" | "full";
  readonly fsFaults?: FsFaultOpts;
}

function setup(workdir: string, opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const telemetry = mockTelemetryStateTracked();
  const cache = mockLinkedProjectCacheTracked();

  const spawner = mockShadowContainerCliSpawner({
    neverHealthy: opts.neverHealthyShadow ?? false,
    failCreate: opts.failCreateShadow ?? false,
    failRemove: opts.failRemoveShadow ?? false,
  });
  const docker = mockSquashDockerRun({
    beforeSql: opts.beforeDumpSql,
    afterSql: opts.afterDumpSql,
    fullSql: opts.fullDumpSql,
    failDump: opts.failDumpKind,
    failSetupJob: opts.failSetupJob,
  });

  const execs: Array<string> = [];
  const queries: Array<{ readonly sql: string; readonly params?: ReadonlyArray<unknown> }> = [];
  // A single combined call-order log; execs/queries alone can't prove statement order
  // (.toContain/.find are order-blind), so a swapped DELETE/INSERT would still pass
  // against them.
  const statements: Array<{ readonly sql: string; readonly params?: ReadonlyArray<unknown> }> = [];
  const connectedDatabases: Array<string> = [];
  const connection = Layer.succeed(DbConnection, {
    connect: (cfg: PgConnInput) =>
      Effect.sync(() => {
        connectedDatabases.push(cfg.database);
        const session: DbSession = {
          exec: (sql: string) =>
            Effect.suspend(() => {
              execs.push(sql);
              statements.push({ sql });
              return opts.failSql !== undefined && sql.includes(opts.failSql)
                ? Effect.fail(new DbExecError({ message: "boom" }))
                : Effect.void;
            }),
          query: (sql: string, params?: ReadonlyArray<unknown>) =>
            Effect.suspend(() => {
              queries.push({ sql, params });
              statements.push({ sql, params });
              return opts.failSql !== undefined && sql.includes(opts.failSql)
                ? Effect.fail(new DbExecError({ message: "boom" }))
                : Effect.succeed<ReadonlyArray<Record<string, unknown>>>([]);
            }),
          // Replays each statement through exec/query so the call-order log and failure
          // injection still apply.
          execBatch: (batch) => sequentialExecBatch(session)(batch),
          extensionExists: () => Effect.succeed(false),
          copyToCsv: () => Effect.succeed(new Uint8Array()),
          queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
        };
        return session;
      }),
  });

  const resolverCalls: Array<DbConfigFlags> = [];
  const resolver = Layer.succeed(DbConfigResolver, {
    resolve: (flags: DbConfigFlags) => {
      resolverCalls.push(flags);
      if (opts.failResolve === true) {
        return Effect.fail(
          new ProjectRefNotLinkedError({
            message: "Cannot find project ref. Have you run link?",
          }),
        );
      }
      return Effect.succeed({
        conn: {
          host: "127.0.0.1",
          port: 54322,
          user: "postgres",
          password: "x",
          database: "postgres",
        },
        isLocal: opts.isLocal ?? true,
        // A real --local/--db-url resolution can omit ref altogether (not just None);
        // omitRef reproduces that so the cfg.ref ?? Option.none() fallback stays exercised.
        ...(opts.omitRef === true
          ? {}
          : { ref: opts.linkedRef !== undefined ? Option.some(opts.linkedRef) : Option.none() }),
      } satisfies ResolvedDbConfig);
    },
    resolvePoolerFallback: () => Effect.succeed(Option.none()),
  });

  // Gives an explicit --project-ref flag precedence over the opts.linkedRef/VALID_REF
  // fallback, so a test can prove the flag drives the linked ref.
  const projectRef = Layer.succeed(ProjectRefResolver, {
    resolve: () => Effect.succeed(opts.linkedRef ?? VALID_REF),
    resolveForLink: () => Effect.succeed(opts.linkedRef ?? VALID_REF),
    resolveOptional: () => Effect.succeed(Option.some(opts.linkedRef ?? VALID_REF)),
    loadProjectRef: (flagValue: Option.Option<string>) =>
      Effect.succeed(
        Option.isSome(flagValue) && flagValue.value.length > 0
          ? flagValue.value
          : (opts.linkedRef ?? VALID_REF),
      ),
    promptProjectRef: () => Effect.succeed(opts.linkedRef ?? VALID_REF),
  });

  const debugLogs: Array<string> = [];
  const debugLogger = Layer.succeed(DebugLogger, {
    debug: (message: string) =>
      Effect.sync(() => {
        debugLogs.push(message);
      }),
    http: () => Effect.void,
  });

  const baseLayer = Layer.mergeAll(
    // Listed first so every fake service layer below overrides it; Layer.mergeAll is
    // last-wins on a shared service.
    BunServices.layer,
    out.layer,
    telemetry.layer,
    cache.layer,
    resolver,
    connection,
    projectRef,
    spawner.layer,
    docker.layer,
    debugLogger,
    alwaysReadyHttpClientLayer,
    mockCommandSettings({ workdir }),
    Layer.succeed(DnsResolverFlag, "native"),
    Layer.succeed(DebugFlag, false),
    Layer.succeed(ExperimentalFlag, false),
    Layer.succeed(YesFlag, opts.yes ?? false),
    Layer.succeed(
      NetworkIdFlag,
      opts.networkId === undefined ? Option.none() : Option.some(opts.networkId),
    ),
    Layer.succeed(CliArgs, { args: opts.args ?? [] }),
    mockTty({ stdinIsTty: opts.isTTY ?? true }),
    mockStdin(
      opts.isTTY ?? true,
      opts.pipedInput ?? (opts.confirm === undefined ? undefined : opts.confirm ? "y\n" : "n\n"),
    ),
    mockRuntimeInfo(),
  );

  const layer =
    opts.fsFaults === undefined ? baseLayer : Layer.merge(baseLayer, faultyFsLayer(opts.fsFaults));

  return {
    layer,
    out,
    telemetry,
    cache,
    execs,
    queries,
    statements,
    connectedDatabases,
    resolverCalls,
    debugLogs,
    shadowSpawned: spawner.spawned,
    dumpCalls: docker.dumpCalls,
    setupJobCalls: docker.setupJobCalls,
  };
}

const flags = (over: Partial<MigrationSquashFlags> = {}): MigrationSquashFlags => ({
  version: over.version ?? Option.none(),
  dbUrl: over.dbUrl ?? Option.none(),
  linked: over.linked ?? false,
  local: over.local ?? true,
  password: over.password ?? Option.none(),
  projectRef: over.projectRef ?? Option.none(),
});

const seedMigration = (workdir: string, name: string, body = "create table t (id int);\n") => {
  const dir = join(workdir, "supabase", "migrations");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body);
};

const stdout = (out: ReturnType<typeof mockOutput>) => stripAnsi(out.stdoutText);
const stderr = (out: ReturnType<typeof mockOutput>) => stripAnsi(out.stderrText);

const failureTag = (exit: Exit.Exit<unknown, unknown>): string | undefined => {
  if (!Exit.isFailure(exit)) return undefined;
  const failure = Cause.findErrorOption(exit.cause);
  return Option.isSome(failure) ? (failure.value as { readonly _tag?: string })._tag : undefined;
};

const tmp = useTempWorkdir();
useShadowCacheDisabled();

describe("migration squash", () => {
  describe("flag surface & ordering", () => {
    it.effect("rejects --linked combined with --local", () => {
      const s = setup(tmp.current, { args: ["--linked", "--local"] });
      return Effect.gen(function* () {
        const exit = yield* migrationSquash(flags({ linked: true, local: true })).pipe(Effect.exit);
        expect(failureTag(exit)).toBe("MigrationTargetFlagsError");
        if (Exit.isFailure(exit)) {
          const failure = Cause.findErrorOption(exit.cause);
          expect(Option.isSome(failure) && (failure.value as { message: string }).message).toBe(
            "if any flags in the group [db-url linked local] are set none of the others can be; [linked local] were all set",
          );
        }
      }).pipe(Effect.provide(s.layer));
    });

    it.effect("rejects --db-url combined with --password", () => {
      const s = setup(tmp.current, { args: ["--db-url", "postgresql://x", "--password", "y"] });
      return Effect.gen(function* () {
        const exit = yield* migrationSquash(
          flags({ dbUrl: Option.some("postgresql://x"), password: Option.some("y") }),
        ).pipe(Effect.exit);
        expect(failureTag(exit)).toBe("MigrationPasswordFlagsError");
        if (Exit.isFailure(exit)) {
          const failure = Cause.findErrorOption(exit.cause);
          expect(Option.isSome(failure) && (failure.value as { message: string }).message).toBe(
            "if any flags in the group [db-url password] are set none of the others can be; [db-url password] were all set",
          );
        }
      }).pipe(Effect.provide(s.layer));
    });

    it.effect("rejects --project-ref on the default local target", () => {
      const s = setup(tmp.current);
      return Effect.gen(function* () {
        const exit = yield* migrationSquash(flags({ projectRef: Option.some(VALID_REF) })).pipe(
          Effect.exit,
        );
        expect(failureTag(exit)).toBe("MigrationTargetFlagsError");
        if (Exit.isFailure(exit)) {
          const failure = Cause.findErrorOption(exit.cause);
          expect(Option.isSome(failure) && (failure.value as { message: string }).message).toBe(
            "--project-ref only applies when targeting the linked project; use it with --linked (not --local or --db-url)",
          );
        }
        // The guard fires before any resolver call, shadow/dump work, or cache write.
        expect(s.resolverCalls).toEqual([]);
        expect(s.shadowSpawned).toEqual([]);
        expect(s.dumpCalls).toEqual([]);
        expect(s.setupJobCalls).toEqual([]);
        expect(s.cache.cached).toBe(false);
      }).pipe(Effect.provide(s.layer));
    });

    it.effect("rejects --project-ref combined with an explicit --db-url target", () => {
      const s = setup(tmp.current, {
        args: ["--db-url", "postgresql://x", "--project-ref", VALID_REF],
      });
      return Effect.gen(function* () {
        const exit = yield* migrationSquash(
          flags({
            dbUrl: Option.some("postgresql://x"),
            projectRef: Option.some(VALID_REF),
          }),
        ).pipe(Effect.exit);
        expect(failureTag(exit)).toBe("MigrationTargetFlagsError");
        if (Exit.isFailure(exit)) {
          const failure = Cause.findErrorOption(exit.cause);
          expect(Option.isSome(failure) && (failure.value as { message: string }).message).toBe(
            "--project-ref only applies when targeting the linked project; use it with --linked (not --local or --db-url)",
          );
        }
        expect(s.resolverCalls).toEqual([]);
        expect(s.shadowSpawned).toEqual([]);
        expect(s.dumpCalls).toEqual([]);
        expect(s.setupJobCalls).toEqual([]);
        expect(s.cache.cached).toBe(false);
      }).pipe(Effect.provide(s.layer));
    });

    it.effect(
      "rejects a non-numeric --version with the bare Go message (no 'failed to parse' prefix)",
      () => {
        const s = setup(tmp.current);
        return Effect.gen(function* () {
          const exit = yield* migrationSquash(flags({ version: Option.some("0_init") })).pipe(
            Effect.exit,
          );
          expect(failureTag(exit)).toBe("MigrationInvalidVersionError");
          if (Exit.isFailure(exit)) {
            const failure = Cause.findErrorOption(exit.cause);
            expect(Option.isSome(failure) && (failure.value as { message: string }).message).toBe(
              "invalid version number",
            );
          }
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect("rejects an out-of-int64-range --version with the same bare message", () => {
      const s = setup(tmp.current);
      return Effect.gen(function* () {
        const exit = yield* migrationSquash(
          flags({ version: Option.some("99999999999999999999") }),
        ).pipe(Effect.exit);
        expect(failureTag(exit)).toBe("MigrationInvalidVersionError");
        if (Exit.isFailure(exit)) {
          const failure = Cause.findErrorOption(exit.cause);
          expect(Option.isSome(failure) && (failure.value as { message: string }).message).toBe(
            "invalid version number",
          );
        }
      }).pipe(Effect.provide(s.layer));
    });

    it.effect("fails with a glob not-found error when --version matches no local file", () => {
      seedMigration(tmp.current, "0_init.sql");
      const s = setup(tmp.current);
      return Effect.gen(function* () {
        const exit = yield* migrationSquash(flags({ version: Option.some("9") })).pipe(Effect.exit);
        expect(failureTag(exit)).toBe("MigrationFileNotFoundError");
        if (Exit.isFailure(exit)) {
          const failure = Cause.findErrorOption(exit.cause);
          expect(Option.isSome(failure) && (failure.value as { message: string }).message).toBe(
            "glob supabase/migrations/9_*.sql: file does not exist",
          );
        }
      }).pipe(Effect.provide(s.layer));
    });

    it.effect("surfaces a db-config resolution failure before validating --version", () => {
      // DB target resolution happens before the version check, matching migration
      // repair's identical ordering test.
      const s = setup(tmp.current, { failResolve: true });
      return Effect.gen(function* () {
        const exit = yield* migrationSquash(flags({ version: Option.some("not-a-number") })).pipe(
          Effect.exit,
        );
        expect(failureTag(exit)).toBe("ProjectRefNotLinkedError");
      }).pipe(Effect.provide(s.layer));
    });

    it.effect("defaults to the local database when no target flag is given", () => {
      seedMigration(tmp.current, "0_init.sql");
      // omitRef matches the real resolver's --local shape: no ref at all, not merely None.
      const s = setup(tmp.current, { args: [], omitRef: true });
      return Effect.gen(function* () {
        yield* migrationSquash(flags());
        expect(s.resolverCalls[0]?.connType).toBe("local");
      }).pipe(Effect.provide(s.layer));
    });
  });

  describe("squashToVersion", () => {
    it.effect("fails with 'version not found' when the migrations directory is empty", () => {
      const s = setup(tmp.current);
      return Effect.gen(function* () {
        const exit = yield* migrationSquash(flags()).pipe(Effect.exit);
        expect(failureTag(exit)).toBe("MigrationSquashMissingVersionError");
        if (Exit.isFailure(exit)) {
          const failure = Cause.findErrorOption(exit.cause);
          expect(Option.isSome(failure) && (failure.value as { message: string }).message).toBe(
            "version not found",
          );
        }
      }).pipe(Effect.provide(s.layer));
    });

    it.effect(
      "fails with 'version not found' when the only file is a deprecated <14-digit>_init.sql",
      () => {
        seedMigration(tmp.current, "20211208000000_init.sql");
        const s = setup(tmp.current);
        return Effect.gen(function* () {
          const exit = yield* migrationSquash(flags()).pipe(Effect.exit);
          expect(failureTag(exit)).toBe("MigrationSquashMissingVersionError");
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "surfaces 'failed to read directory' when supabase/migrations is a file, not a directory",
      () => {
        mkdirSync(join(tmp.current, "supabase"), { recursive: true });
        writeFileSync(join(tmp.current, "supabase", "migrations"), "not a directory");
        const s = setup(tmp.current);
        return Effect.gen(function* () {
          const error = yield* migrationSquash(flags()).pipe(Effect.flip);
          expect((error as { message: string }).message).toContain("failed to read directory");
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "no-ops on a single migration: prints the earliest-migration line, spawns no container, and still finishes",
      () => {
        seedMigration(tmp.current, "0_init.sql");
        const s = setup(tmp.current);
        return Effect.gen(function* () {
          yield* migrationSquash(flags());
          expect(stderr(s.out)).toContain(
            "supabase/migrations/0_init.sql is already the earliest migration.",
          );
          expect(s.shadowSpawned).toEqual([]);
          expect(s.dumpCalls).toEqual([]);
          // The Finished/repair-suggestion output still runs on the no-op path.
          expect(stdout(s.out)).toContain("Finished supabase migration squash.");
          expect(stderr(s.out)).toContain(
            "Run supabase migration repair --status applied to update your remote migration history table.",
          );
        }).pipe(Effect.provide(s.layer));
      },
    );
  });

  describe("squashing local migrations", () => {
    const BEFORE_SQL = "CREATE SCHEMA IF NOT EXISTS auth;\nold auth object;\n";
    const AFTER_SQL = "CREATE SCHEMA IF NOT EXISTS auth;\nnew auth object;\n";
    const FULL_SQL = "CREATE TABLE t (id int);\n";

    function setupHappyPath(opts: SetupOpts = {}) {
      seedMigration(tmp.current, "0_init.sql", "create table a (id int);\n");
      seedMigration(tmp.current, "1_target.sql", "create table b (id int);\n");
      return setup(tmp.current, {
        beforeDumpSql: BEFORE_SQL,
        afterDumpSql: AFTER_SQL,
        fullDumpSql: FULL_SQL,
        ...opts,
      });
    }

    it.effect(
      "squashes two migrations into the last file: applies every migration, deletes the earlier one, and prints the summary",
      () => {
        const s = setupHappyPath();
        return Effect.gen(function* () {
          yield* migrationSquash(flags());

          expect(s.shadowSpawned.filter((c) => c.args[0] === "create")).toHaveLength(1);
          expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
          expect(stderr(s.out)).toContain("Initialising schema...");
          expect(stderr(s.out)).toContain("Applying migration 0_init.sql...");
          expect(stderr(s.out)).toContain("Applying migration 1_target.sql...");
          expect(stderr(s.out)).toContain(
            "Squashed local migrations to supabase/migrations/1_target.sql",
          );

          const migrationsDir = join(tmp.current, "supabase", "migrations");
          expect(existsSync(join(migrationsDir, "0_init.sql"))).toBe(false);
          expect(existsSync(join(migrationsDir, "1_target.sql"))).toBe(true);

          // Hardcoded rather than recomputed via squash.diff.ts's helpers, so a regression
          // in the separator constant or the diff algorithm itself still fails this
          // assertion.
          const expectedTail =
            "\n--\n-- Dumped schema changes for auth and storage\n--\n\n" + "new auth object;\n";
          expect(readFileSync(join(migrationsDir, "1_target.sql"), "utf8")).toBe(
            FULL_SQL + expectedTail,
          );

          expect(stdout(s.out)).toContain("Finished supabase migration squash.");
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "runs the before/after dumps scoped to auth|storage and the full dump excluding the internal schemas",
      () => {
        const s = setupHappyPath();
        return Effect.gen(function* () {
          yield* migrationSquash(flags());
          expect(s.dumpCalls).toHaveLength(3);
          const [before, after, full] = s.dumpCalls;
          expect(before?.env["EXTRA_FLAGS"]).toBe("--schema=auth|storage");
          expect(before?.env["EXCLUDED_SCHEMAS"]).toBeUndefined();
          expect(after?.env["EXTRA_FLAGS"]).toBe("--schema=auth|storage");
          expect(after?.env["EXCLUDED_SCHEMAS"]).toBeUndefined();
          expect(full?.env["EXTRA_FLAGS"]).toBeUndefined();
          expect(full?.env["EXCLUDED_SCHEMAS"]).toBe(INTERNAL_SCHEMAS.join("|"));
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "runs every dump container on host networking with the shadow's connection env and the config Postgres image",
      () => {
        const s = setupHappyPath();
        return Effect.gen(function* () {
          yield* migrationSquash(flags());
          expect(s.dumpCalls).toHaveLength(3);
          for (const call of s.dumpCalls) {
            expect(call.env["PGPORT"]).toBe("54320");
            expect(call.env["PGUSER"]).toBe("postgres");
            expect(call.env["PGDATABASE"]).toBe("postgres");
            expect(call.network).toEqual({ _tag: "host" });
            expect(call.cmd).toEqual(["bash", "-c", dumpSchemaScript, "--"]);
            // streamPgDump applies the registry mirror itself; the default registry
            // rewrites to the ECR mirror, not the bare Dockerfile-manifest tag.
            expect(call.image).toBe(getRegistryImageUrl(dockerfileServiceImage("pg")));
          }
          // Every dump dials the same shadow host, whatever this machine's Docker context
          // resolves (getHostname); checked for self-consistency rather than a hardcoded
          // value.
          const hosts = new Set(s.dumpCalls.map((c) => c.env["PGHOST"]));
          expect(hosts.size).toBe(1);
          const [host] = hosts;
          expect(host).toBeTruthy();
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "dials the shadow's PG15+ setup jobs at the container's 12-char short id (DB_HOST)",
      () => {
        const s = setupHappyPath();
        return Effect.gen(function* () {
          yield* migrationSquash(flags());
          const expectedHost = FAKE_SHADOW_CONTAINER_ID.slice(0, 12);
          expect(s.setupJobCalls.length).toBeGreaterThan(0);
          let sawHost = false;
          for (const call of s.setupJobCalls) {
            if (call.env["DB_HOST"] !== undefined) {
              expect(call.env["DB_HOST"]).toBe(expectedHost);
              sawHost = true;
            }
            for (const value of Object.values(call.env)) {
              if (value.includes("@") && value.includes(":")) {
                expect(value).toContain(`@${expectedHost}:`);
                sawHost = true;
              }
            }
          }
          expect(sawHost).toBe(true);
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "forwards --network-id to every dump container as a named network instead of host",
      () => {
        const s = setupHappyPath({ networkId: "custom-net" });
        return Effect.gen(function* () {
          yield* migrationSquash(flags());
          expect(s.dumpCalls).toHaveLength(3);
          for (const call of s.dumpCalls) {
            expect(call.network).toEqual({ _tag: "named", name: "custom-net" });
          }
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "resolves the pg_dump image via SUPABASE_INTERNAL_IMAGE_REGISTRY from supabase/.env",
      () => {
        // applyProjectEnv applies the project .env before any pg_dump container starts,
        // so a registry mirror set only there reaches all three.
        const prev = process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"];
        delete process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"];
        const s = setupHappyPath();
        writeFileSync(
          join(tmp.current, "supabase", ".env"),
          "SUPABASE_INTERNAL_IMAGE_REGISTRY=my-mirror.example.com\n",
        );
        return Effect.gen(function* () {
          yield* migrationSquash(flags());
          expect(s.dumpCalls).toHaveLength(3);
          for (const call of s.dumpCalls) {
            expect(call.image).toMatch(/^my-mirror\.example\.com\/supabase\//u);
          }
          // Reverted once the command's scope closes; never leaks into a later command in
          // the same process.
          expect(process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"]).toBeUndefined();
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (prev === undefined) delete process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"];
              else process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"] = prev;
            }),
          ),
          Effect.provide(s.layer),
        );
      },
    );

    it.effect(
      "resolves the pg_dump network via SUPABASE_NETWORK_ID from supabase/.env when neither the flag nor the ambient env is set",
      () => {
        // Host networking is the default; an explicit network id overrides it whenever
        // it resolves non-empty, even when sourced only from supabase/.env.
        const prev = process.env["SUPABASE_NETWORK_ID"];
        delete process.env["SUPABASE_NETWORK_ID"];
        const s = setupHappyPath();
        writeFileSync(join(tmp.current, "supabase", ".env"), "SUPABASE_NETWORK_ID=dotenv-net\n");
        return Effect.gen(function* () {
          yield* migrationSquash(flags());
          expect(s.dumpCalls).toHaveLength(3);
          for (const call of s.dumpCalls) {
            expect(call.network).toEqual({ _tag: "named", name: "dotenv-net" });
          }
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (prev === undefined) delete process.env["SUPABASE_NETWORK_ID"];
              else process.env["SUPABASE_NETWORK_ID"] = prev;
            }),
          ),
          Effect.provide(s.layer),
        );
      },
    );

    it.effect("squashes only the migrations up to --version, leaving newer ones untouched", () => {
      seedMigration(tmp.current, "0_init.sql", "create table a (id int);\n");
      seedMigration(tmp.current, "1_target.sql", "create table b (id int);\n");
      seedMigration(tmp.current, "2_after.sql", "create table c (id int);\n");
      const s = setup(tmp.current, {
        beforeDumpSql: BEFORE_SQL,
        afterDumpSql: AFTER_SQL,
        fullDumpSql: FULL_SQL,
      });
      return Effect.gen(function* () {
        yield* migrationSquash(flags({ version: Option.some("1") }));
        const migrationsDir = join(tmp.current, "supabase", "migrations");
        expect(existsSync(join(migrationsDir, "0_init.sql"))).toBe(false);
        expect(existsSync(join(migrationsDir, "1_target.sql"))).toBe(true);
        expect(readFileSync(join(migrationsDir, "2_after.sql"), "utf8")).toBe(
          "create table c (id int);\n",
        );
      }).pipe(Effect.provide(s.layer));
    });
  });

  // Every failure path removes the shadow, unless creation itself failed (the
  // established leak-on-create-failure behavior).
  describe("squashMigrations failure paths", () => {
    it.effect("fails when the shadow container cannot be created and never attempts a dump", () => {
      seedMigration(tmp.current, "0_init.sql");
      seedMigration(tmp.current, "1_target.sql");
      const s = setup(tmp.current, { failCreateShadow: true });
      return Effect.gen(function* () {
        const exit = yield* migrationSquash(flags()).pipe(Effect.exit);
        expect(failureTag(exit)).toBe("ShadowDbError");
        expect(s.shadowSpawned.filter((c) => c.args[0] === "create")).toHaveLength(1);
        // Nothing to release; the container was never created (see createShadowDatabase's doc).
        expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toEqual([]);
        expect(s.dumpCalls).toEqual([]);
      }).pipe(Effect.provide(s.layer));
    });

    it.effect(
      "fails with a health-check timeout when the shadow never becomes healthy, and removes it",
      () => {
        seedMigration(tmp.current, "0_init.sql");
        seedMigration(tmp.current, "1_target.sql");
        mkdirSync(join(tmp.current, "supabase"), { recursive: true });
        // A zero-second health timeout means zero retries after the first failed
        // probe — an immediate, deterministic timeout with no real/virtual delay.
        writeFileSync(
          join(tmp.current, "supabase", "config.toml"),
          '[db]\nhealth_timeout = "0s"\n',
        );
        const s = setup(tmp.current, { neverHealthyShadow: true });
        return Effect.gen(function* () {
          const exit = yield* migrationSquash(flags()).pipe(Effect.exit);
          expect(failureTag(exit)).toBe("HealthCheckTimeoutError");
          expect(s.shadowSpawned.filter((c) => c.args[0] === "create")).toHaveLength(1);
          expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
          expect(s.dumpCalls).toEqual([]);
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "fails when the shadow's platform-baseline setup job exits non-zero, and removes it",
      () => {
        seedMigration(tmp.current, "0_init.sql");
        seedMigration(tmp.current, "1_target.sql");
        const s = setup(tmp.current, { failSetupJob: true });
        return Effect.gen(function* () {
          const exit = yield* migrationSquash(flags()).pipe(Effect.exit);
          expect(failureTag(exit)).toBe("DbSetupError");
          expect(s.shadowSpawned.filter((c) => c.args[0] === "create")).toHaveLength(1);
          expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
          expect(s.dumpCalls).toEqual([]);
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect("fails when applying a migration to the shadow errors, and removes it", () => {
      seedMigration(tmp.current, "0_init.sql", "create table boom;\n");
      seedMigration(tmp.current, "1_target.sql");
      const s = setup(tmp.current, { failSql: "create table boom" });
      return Effect.gen(function* () {
        const exit = yield* migrationSquash(flags()).pipe(Effect.exit);
        expect(failureTag(exit)).toBe("MigrationApplyError");
        expect(s.shadowSpawned.filter((c) => c.args[0] === "create")).toHaveLength(1);
        expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
      }).pipe(Effect.provide(s.layer));
    });

    it.effect(
      "fails with 'error running container: exit 1' when the before/after dump container exits non-zero",
      () => {
        seedMigration(tmp.current, "0_init.sql");
        seedMigration(tmp.current, "1_target.sql");
        const s = setup(tmp.current, { failDumpKind: "before" });
        return Effect.gen(function* () {
          const exit = yield* migrationSquash(flags()).pipe(Effect.exit);
          expect(failureTag(exit)).toBe("MigrationSquashDumpError");
          if (Exit.isFailure(exit)) {
            const failure = Cause.findErrorOption(exit.cause);
            expect(Option.isSome(failure) && (failure.value as { message: string }).message).toBe(
              "error running container: exit 1",
            );
          }
          expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "fails with 'error running container: exit 1' when the full-schema dump exits non-zero, leaving the target file truncated",
      () => {
        seedMigration(tmp.current, "0_init.sql");
        seedMigration(tmp.current, "1_target.sql");
        const s = setup(tmp.current, {
          beforeDumpSql: "before;\n",
          afterDumpSql: "after;\n",
          fullDumpSql: "partial output before the container died",
          failDumpKind: "full",
        });
        return Effect.gen(function* () {
          const exit = yield* migrationSquash(flags()).pipe(Effect.exit);
          expect(failureTag(exit)).toBe("MigrationSquashDumpError");
          expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
          const targetPath = join(tmp.current, "supabase", "migrations", "1_target.sql");
          // Truncated by the earlier O_TRUNC, then only the partial stream the dying
          // container wrote before failing; no separator/diff was ever appended.
          expect(readFileSync(targetPath, "utf8")).toBe("partial output before the container died");
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "fails with 'failed to open migration file' when the target file cannot be truncated/opened",
      () => {
        // Squash's single O_TRUNC-equivalent open call, so there is exactly one failure
        // site here, not two.
        seedMigration(tmp.current, "0_init.sql");
        seedMigration(tmp.current, "1_target.sql");
        const targetPath = join(tmp.current, "supabase", "migrations", "1_target.sql");
        const s = setup(tmp.current, {
          beforeDumpSql: "before;\n",
          afterDumpSql: "after;\n",
          fullDumpSql: "full;\n",
          fsFaults: { failOpenPath: targetPath },
        });
        return Effect.gen(function* () {
          const exit = yield* migrationSquash(flags()).pipe(Effect.exit);
          expect(failureTag(exit)).toBe("MigrationSquashWriteError");
          if (Exit.isFailure(exit)) {
            const failure = Cause.findErrorOption(exit.cause);
            const message =
              Option.isSome(failure) && (failure.value as { message: string }).message;
            expect(message).toContain("failed to open migration file:");
            // Relativized: the absolute tmp workdir never leaks.
            expect(message).not.toContain(tmp.current);
          }
          expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "fails with 'failed to copy docker logs' when streaming the full dump into the target file fails",
      () => {
        // The underlying failure here is the docker-log-stream write into the target
        // file, so it reports "failed to copy docker logs:", not lineByLineDiff's
        // "failed to write line:".
        seedMigration(tmp.current, "0_init.sql");
        seedMigration(tmp.current, "1_target.sql");
        const targetPath = join(tmp.current, "supabase", "migrations", "1_target.sql");
        const s = setup(tmp.current, {
          beforeDumpSql: "before;\n",
          afterDumpSql: "after;\n",
          fullDumpSql: "full;\n",
          fsFaults: { failWriteAllFromCall: { path: targetPath, fromCall: 1 } },
        });
        return Effect.gen(function* () {
          const exit = yield* migrationSquash(flags()).pipe(Effect.exit);
          expect(failureTag(exit)).toBe("MigrationSquashWriteError");
          if (Exit.isFailure(exit)) {
            const failure = Cause.findErrorOption(exit.cause);
            expect(
              Option.isSome(failure) && (failure.value as { message: string }).message,
            ).toContain("failed to copy docker logs:");
          }
          expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "fails with 'failed to write line' when appending the separator/diff tail fails (the full dump itself wrote fine)",
      () => {
        seedMigration(tmp.current, "0_init.sql");
        seedMigration(tmp.current, "1_target.sql");
        const targetPath = join(tmp.current, "supabase", "migrations", "1_target.sql");
        const s = setup(tmp.current, {
          beforeDumpSql: "before;\n",
          afterDumpSql: "after;\n",
          fullDumpSql: "full;\n",
          // fromCall: 2 lets the full-dump write (call 1) succeed, isolating the tail
          // write (call 2).
          fsFaults: { failWriteAllFromCall: { path: targetPath, fromCall: 2 } },
        });
        return Effect.gen(function* () {
          const exit = yield* migrationSquash(flags()).pipe(Effect.exit);
          expect(failureTag(exit)).toBe("MigrationSquashWriteError");
          if (Exit.isFailure(exit)) {
            const failure = Cause.findErrorOption(exit.cause);
            const message =
              Option.isSome(failure) && (failure.value as { message: string }).message;
            expect(message).toContain("failed to write line:");
            // Relativized: the absolute tmp workdir never leaks.
            expect(message).not.toContain(tmp.current);
          }
          expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
          expect(readFileSync(targetPath, "utf8")).toBe("full;\n");
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect("prints a merged-file removal error to stderr non-fatally and still succeeds", () => {
      seedMigration(tmp.current, "0_init.sql");
      seedMigration(tmp.current, "1_target.sql");
      const earlierPath = join(tmp.current, "supabase", "migrations", "0_init.sql");
      const s = setup(tmp.current, {
        beforeDumpSql: "before;\n",
        afterDumpSql: "after;\n",
        fullDumpSql: "full;\n",
        fsFaults: { failRemovePath: earlierPath },
      });
      return Effect.gen(function* () {
        yield* migrationSquash(flags());
        expect(stdout(s.out)).toContain("Finished supabase migration squash.");
        expect(stderr(s.out)).toContain("FileSystem.remove (supabase/migrations/0_init.sql)");
        expect(existsSync(earlierPath)).toBe(true);
      }).pipe(Effect.provide(s.layer));
    });

    it.effect(
      "reports the removal failure in the machine-mode payload's removeFailures, leaving removed empty",
      () => {
        seedMigration(tmp.current, "0_init.sql");
        seedMigration(tmp.current, "1_target.sql");
        const earlierPath = join(tmp.current, "supabase", "migrations", "0_init.sql");
        const s = setup(tmp.current, {
          format: "json",
          beforeDumpSql: "before;\n",
          afterDumpSql: "after;\n",
          fullDumpSql: "full;\n",
          fsFaults: { failRemovePath: earlierPath },
        });
        return Effect.gen(function* () {
          yield* migrationSquash(flags());
          const success = s.out.messages.find((m) => m.type === "success");
          const data = success?.data as {
            readonly removed: ReadonlyArray<string>;
            readonly removeFailures: ReadonlyArray<{
              readonly path: string;
              readonly message: string;
            }>;
          };
          expect(data.removed).toEqual([]);
          expect(data.removeFailures).toHaveLength(1);
          expect(data.removeFailures[0]?.path).toBe("supabase/migrations/0_init.sql");
          expect(data.removeFailures[0]?.message).toContain(
            "FileSystem.remove (supabase/migrations/0_init.sql)",
          );
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect("reports a shadow cleanup failure without failing the command", () => {
      seedMigration(tmp.current, "0_init.sql");
      seedMigration(tmp.current, "1_target.sql");
      const s = setup(tmp.current, {
        beforeDumpSql: "before;\n",
        afterDumpSql: "after;\n",
        fullDumpSql: "full;\n",
        failRemoveShadow: true,
      });
      return Effect.gen(function* () {
        yield* migrationSquash(flags());
        expect(stdout(s.out)).toContain("Finished supabase migration squash.");
        expect(stderr(s.out)).toContain(`Failed to remove container: ${FAKE_SHADOW_CONTAINER_ID}`);
      }).pipe(Effect.provide(s.layer));
    });
  });

  describe("local target", () => {
    it.effect(
      "prints Finished on stdout and the repair suggestion on stderr, and never prompts",
      () => {
        seedMigration(tmp.current, "0_init.sql");
        const s = setup(tmp.current, { isLocal: true });
        return Effect.gen(function* () {
          yield* migrationSquash(flags());
          expect(stdout(s.out)).toContain("Finished supabase migration squash.");
          expect(stderr(s.out)).toContain(
            "Run supabase migration repair --status applied to update your remote migration history table.",
          );
          expect(stderr(s.out)).not.toContain("Update remote migration history table?");
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect("a --db-url pointing at the local stack also takes the local-suggestion path", () => {
      seedMigration(tmp.current, "0_init.sql");
      const s = setup(tmp.current, { isLocal: true, args: ["--db-url", "postgresql://local"] });
      return Effect.gen(function* () {
        yield* migrationSquash(flags({ dbUrl: Option.some("postgresql://local") }));
        expect(stdout(s.out)).toContain("Finished supabase migration squash.");
      }).pipe(Effect.provide(s.layer));
    });
  });

  describe("remote target", () => {
    function setupRemote(opts: SetupOpts = {}) {
      seedMigration(tmp.current, "0_init.sql");
      return setup(tmp.current, { isLocal: false, linkedRef: VALID_REF, ...opts });
    }

    it.effect("prompts to update the remote history table and baselines on 'y'", () => {
      const s = setupRemote({ confirm: true, args: ["--linked"] });
      return Effect.gen(function* () {
        yield* migrationSquash(flags({ linked: true }));
        expect(stderr(s.out)).toContain("Update remote migration history table? [Y/n] ");
        expect(s.queries.some((q) => q.sql.includes("DELETE FROM supabase_migrations"))).toBe(true);
        expect(s.queries.some((q) => q.sql.includes("INSERT INTO supabase_migrations"))).toBe(true);
      }).pipe(Effect.provide(s.layer));
    });

    it.effect(
      "prints 'Baselining migration history to <v>' BEFORE 'Connecting to remote database...'",
      () => {
        const s = setupRemote({ confirm: true });
        return Effect.gen(function* () {
          yield* migrationSquash(flags());
          const text = stderr(s.out);
          const baseliningAt = text.indexOf("Baselining migration history to 0");
          const connectingAt = text.indexOf("Connecting to remote database...");
          expect(baseliningAt).toBeGreaterThanOrEqual(0);
          expect(connectingAt).toBeGreaterThan(baseliningAt);
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "baselines via one transaction: BEGIN, DELETE ... WHERE version <= $1, INSERT ..., COMMIT",
      () => {
        const s = setupRemote({ confirm: true });
        return Effect.gen(function* () {
          yield* migrationSquash(flags());
          // A single ordered log, since execs/queries alone are order-blind and would
          // still pass an INSERT-before-DELETE regression; the baseline transaction is
          // the last 4 statements, after createMigrationTable's setup transaction.
          const baseline = s.statements.slice(-4);
          expect(baseline.map((entry) => entry.sql)).toEqual([
            "BEGIN",
            "DELETE FROM supabase_migrations.schema_migrations WHERE version <= $1",
            "INSERT INTO supabase_migrations.schema_migrations(version, name, statements) VALUES($1, $2, $3)",
            "COMMIT",
          ]);
          expect(baseline[1]?.params).toEqual(["0"]);
          expect(baseline[2]?.params).toEqual(["0", "init", ["create table t (id int)"]]);
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "rolls back and reports a baseline failure when the history-table batch fails",
      () => {
        const s = setupRemote({ confirm: true, failSql: "INSERT INTO supabase_migrations" });
        return Effect.gen(function* () {
          const exit = yield* migrationSquash(flags()).pipe(Effect.exit);
          expect(failureTag(exit)).toBe("MigrationSquashBaselineError");
          if (Exit.isFailure(exit)) {
            const failure = Cause.findErrorOption(exit.cause);
            expect(
              Option.isSome(failure) && (failure.value as { message: string }).message,
            ).toContain("failed to update migration history:");
          }
          expect(s.execs).toContain("ROLLBACK");
          // Exactly one COMMIT: createMigrationTable's own setup transaction, which runs
          // before the baseline's BEGIN/DELETE/INSERT batch and never itself reaches COMMIT.
          expect(s.execs.filter((e) => e === "COMMIT")).toHaveLength(1);
          expect(s.execs.filter((e) => e === "BEGIN")).toHaveLength(2);
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "declining the prompt exits 0, runs no baseline query, and still prints Finished",
      () => {
        const s = setupRemote({ confirm: false });
        return Effect.gen(function* () {
          const exit = yield* migrationSquash(flags()).pipe(Effect.exit);
          expect(Exit.isSuccess(exit)).toBe(true);
          expect(s.execs).not.toContain("BEGIN");
          expect(s.queries).toEqual([]);
          expect(stdout(s.out)).toContain("Finished supabase migration squash.");
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect("--yes auto-confirms by echoing the prompt with 'y' and reads no stdin", () => {
      const s = setupRemote({ yes: true, pipedInput: undefined });
      return Effect.gen(function* () {
        yield* migrationSquash(flags());
        expect(stderr(s.out)).toContain("Update remote migration history table? [Y/n] y");
        expect(s.execs).toContain("BEGIN");
      }).pipe(Effect.provide(s.layer));
    });

    it.effect("a non-TTY run with no piped answer takes the default (yes) and baselines", () => {
      const s = setupRemote({ isTTY: false, pipedInput: undefined });
      return Effect.gen(function* () {
        yield* migrationSquash(flags());
        expect(s.execs).toContain("BEGIN");
        expect(s.queries.some((q) => q.sql.includes("INSERT INTO supabase_migrations"))).toBe(true);
      }).pipe(Effect.provide(s.layer));
    });

    it.effect(
      "--version 0 baselines exactly version 0 even though a newer migration survives",
      () => {
        seedMigration(tmp.current, "0_init.sql");
        seedMigration(tmp.current, "1_newer.sql");
        const s = setup(tmp.current, {
          isLocal: false,
          linkedRef: VALID_REF,
          confirm: true,
        });
        return Effect.gen(function* () {
          yield* migrationSquash(flags({ version: Option.some("0") }));
          const insert = s.queries.find((q) => q.sql.includes("INSERT INTO supabase_migrations"));
          expect(insert?.params?.[0]).toBe("0");
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect("baselines the surviving older version when a merged-file removal failed", () => {
      // Local versions are re-listed after the file removals, so a failed removal leaves
      // the older merged file's version as what an empty --version baselines to, not the
      // squash target.
      seedMigration(tmp.current, "0_init.sql");
      seedMigration(tmp.current, "1_target.sql");
      const earlierPath = join(tmp.current, "supabase", "migrations", "0_init.sql");
      const s = setup(tmp.current, {
        isLocal: false,
        linkedRef: VALID_REF,
        confirm: true,
        beforeDumpSql: "before;\n",
        afterDumpSql: "after;\n",
        fullDumpSql: "full;\n",
        fsFaults: { failRemovePath: earlierPath },
      });
      return Effect.gen(function* () {
        yield* migrationSquash(flags());
        const insert = s.queries.find((q) => q.sql.includes("INSERT INTO supabase_migrations"));
        expect(insert?.params?.[0]).toBe("0");
      }).pipe(Effect.provide(s.layer));
    });

    it.effect(
      "debug-logs and baselines with an empty version when the post-squash version reload fails",
      () => {
        seedMigration(tmp.current, "0_init.sql");
        seedMigration(tmp.current, "1_target.sql");
        const migrationsDir = join(tmp.current, "supabase", "migrations");
        const s = setup(tmp.current, {
          isLocal: false,
          linkedRef: VALID_REF,
          confirm: true,
          beforeDumpSql: "before;\n",
          afterDumpSql: "after;\n",
          fullDumpSql: "full;\n",
          // Call 1 is squashToVersion's own listing (must succeed); call 2 is
          // baselineMigrations's post-removal re-list, which this fails; call 3 (inside
          // resolveMigrationFile) must succeed again to isolate the reload failure.
          fsFaults: { failReadDirectoryAtCall: { path: migrationsDir, atCall: 2 } },
        });
        return Effect.gen(function* () {
          const exit = yield* migrationSquash(flags()).pipe(Effect.exit);
          expect(s.debugLogs).toHaveLength(1);
          expect(s.debugLogs[0]).toContain("failed to read directory");
          expect(s.debugLogs[0]).toContain("simulated failure");
          expect(stderr(s.out)).toContain("Baselining migration history to \n");
          // The empty-version glob fails, surfacing as the baseline's missing-file error
          // and proving resolvedVersion genuinely stayed "" rather than falling back to
          // the squash target.
          expect(failureTag(exit)).toBe("MigrationFileNotFoundError");
          if (Exit.isFailure(exit)) {
            const failure = Cause.findErrorOption(exit.cause);
            expect(Option.isSome(failure) && (failure.value as { message: string }).message).toBe(
              "glob supabase/migrations/_*.sql: file does not exist",
            );
          }
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect("--linked caches the linked project ref even when the squash fails", () => {
      const s = setup(tmp.current, {
        isLocal: false,
        linkedRef: VALID_REF,
        args: ["--linked"],
      });
      return Effect.gen(function* () {
        const exit = yield* migrationSquash(
          flags({ linked: true, version: Option.some("bad") }),
        ).pipe(Effect.exit);
        expect(failureTag(exit)).toBe("MigrationInvalidVersionError");
        expect(s.cache.cached).toBe(true);
        expect(s.cache.cachedRef).toBe(VALID_REF);
      }).pipe(Effect.provide(s.layer));
    });

    it.effect(
      "--linked --project-ref overrides the workdir's own linked ref for resolution and caching",
      () => {
        // opts.linkedRef (VALID_REF) is what the workdir would resolve to without the
        // flag; --project-ref must win over it for both the resolver call and the cache.
        const FLAG_REF = "flagflagflagflagflag";
        const s = setup(tmp.current, {
          isLocal: false,
          linkedRef: VALID_REF,
          args: ["--linked", "--project-ref", FLAG_REF],
        });
        return Effect.gen(function* () {
          const exit = yield* migrationSquash(
            flags({ linked: true, projectRef: Option.some(FLAG_REF), version: Option.some("bad") }),
          ).pipe(Effect.exit);
          expect(failureTag(exit)).toBe("MigrationInvalidVersionError");
          expect(s.cache.cached).toBe(true);
          expect(s.cache.cachedRef).toBe(FLAG_REF);
          expect(s.cache.cachedRef).not.toBe(VALID_REF);
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "--linked reads [remotes.<ref>] and prints the config-override line before resolving",
      () => {
        mkdirSync(join(tmp.current, "supabase"), { recursive: true });
        writeFileSync(
          join(tmp.current, "supabase", "config.toml"),
          ["[remotes.dev]", `project_id = "${VALID_REF}"`, ""].join("\n"),
        );
        seedMigration(tmp.current, "0_init.sql");
        const s = setup(tmp.current, {
          isLocal: false,
          linkedRef: VALID_REF,
          confirm: true,
          args: ["--linked"],
        });
        return Effect.gen(function* () {
          yield* migrationSquash(flags({ linked: true }));
          const text = stderr(s.out);
          expect(text).toContain("Loading config override: [remotes.dev]");
          const overrideAt = text.indexOf("Loading config override: [remotes.dev]");
          const promptAt = text.indexOf("Update remote migration history table?");
          expect(promptAt).toBeGreaterThan(overrideAt);
        }).pipe(Effect.provide(s.layer));
      },
    );
  });

  describe("output formats", () => {
    it.effect("json emits the squash payload on stdout and keeps progress on stderr", () => {
      seedMigration(tmp.current, "0_init.sql");
      const s = setup(tmp.current, { format: "json", isLocal: true });
      return Effect.gen(function* () {
        yield* migrationSquash(flags());
        expect(s.out.messages).toContainEqual(
          expect.objectContaining({
            type: "success",
            message: "Migrations squashed",
            data: {
              squashedInto: "supabase/migrations/0_init.sql",
              removed: [],
              removeFailures: [],
              alreadyEarliest: true,
              isLocal: true,
              baselinedVersion: null,
            },
          }),
        );
      }).pipe(Effect.provide(s.layer));
    });

    it.effect("json suppresses the Finished line and the repair suggestion", () => {
      seedMigration(tmp.current, "0_init.sql");
      const s = setup(tmp.current, { format: "json", isLocal: true });
      return Effect.gen(function* () {
        yield* migrationSquash(flags());
        expect(stdout(s.out)).not.toContain("Finished");
        expect(stderr(s.out)).not.toContain("Run supabase migration repair");
      }).pipe(Effect.provide(s.layer));
    });

    it.effect("stream-json emits the result event on stdout with progress lines on stderr", () => {
      seedMigration(tmp.current, "0_init.sql");
      const s = setup(tmp.current, { format: "stream-json", isLocal: true });
      return Effect.gen(function* () {
        yield* migrationSquash(flags());
        expect(s.out.messages.some((m) => m.type === "success")).toBe(true);
        expect(stderr(s.out)).toContain("is already the earliest migration.");
      }).pipe(Effect.provide(s.layer));
    });

    it.effect("json still writes the prompt label to stderr and reads the piped answer", () => {
      seedMigration(tmp.current, "0_init.sql");
      const s = setup(tmp.current, {
        format: "json",
        isLocal: false,
        linkedRef: VALID_REF,
        confirm: true,
      });
      return Effect.gen(function* () {
        yield* migrationSquash(flags());
        expect(stderr(s.out)).toContain("Update remote migration history table? [Y/n] ");
        expect(s.execs).toContain("BEGIN");
      }).pipe(Effect.provide(s.layer));
    });

    it.effect(
      "json on the declined-prompt path reports success with baselinedVersion: null",
      () => {
        seedMigration(tmp.current, "0_init.sql");
        const s = setup(tmp.current, {
          format: "json",
          isLocal: false,
          linkedRef: VALID_REF,
          confirm: false,
        });
        return Effect.gen(function* () {
          yield* migrationSquash(flags());
          const success = s.out.messages.find((m) => m.type === "success");
          expect(success?.data).toMatchObject({ isLocal: false, baselinedVersion: null });
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect("json on the remote-confirmed 2-migration path reports the full real payload", () => {
      seedMigration(tmp.current, "0_init.sql", "create table a (id int);\n");
      seedMigration(tmp.current, "1_target.sql", "create table b (id int);\n");
      const s = setup(tmp.current, {
        format: "json",
        isLocal: false,
        linkedRef: VALID_REF,
        confirm: true,
        beforeDumpSql: "before;\n",
        afterDumpSql: "after;\n",
        fullDumpSql: "full;\n",
      });
      return Effect.gen(function* () {
        yield* migrationSquash(flags());
        const success = s.out.messages.find((m) => m.type === "success");
        // "1_target.sql" is the sole surviving file once "0_init.sql" is removed, so the
        // empty-version baseline reload (run after the removal) resolves to its own
        // version, "1", matching squashedInto below.
        expect(success?.data).toEqual({
          squashedInto: "supabase/migrations/1_target.sql",
          removed: ["supabase/migrations/0_init.sql"],
          removeFailures: [],
          alreadyEarliest: false,
          isLocal: false,
          baselinedVersion: "1",
        });
      }).pipe(Effect.provide(s.layer));
    });
  });
});
