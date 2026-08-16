import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Option, Path } from "effect";
import { PlatformError, SystemError } from "effect/PlatformError";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { stripAnsi } from "../../../../../tests/helpers/ansi.ts";
import {
  LEGACY_FAKE_SHADOW_CONTAINER_ID,
  LEGACY_VALID_REF,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyShadowContainerCliSpawner,
  mockLegacyTelemetryStateTracked,
  useLegacyShadowCacheDisabled,
  useLegacyTempWorkdir,
  withLegacyShadowCacheEnabled,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import {
  mockOutput,
  mockRuntimeInfo,
  mockStdin,
  mockTty,
} from "../../../../../tests/helpers/mocks.ts";
import { dockerfileServiceImage } from "../../../../shared/services/dockerfile-images.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { legacyGetRegistryImageUrl } from "../../../shared/legacy-docker-registry.ts";
import {
  LegacyDebugFlag,
  LegacyDnsResolverFlag,
  LegacyExperimentalFlag,
  LegacyNetworkIdFlag,
  LegacyYesFlag,
} from "../../../../shared/legacy/global-flags.ts";
import type { OutputFormat } from "../../../../shared/output/types.ts";
import { LegacyProjectNotLinkedError } from "../../../config/legacy-project-ref.errors.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LEGACY_INTERNAL_SCHEMAS } from "../../../shared/legacy-pg-dump.env.ts";
import { legacyDumpSchemaScript } from "../../../shared/legacy-pg-dump.scripts.ts";
import { legacyShadowBaselineCacheDir } from "../../../shared/legacy-pgdelta.paths.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import type {
  LegacyDbConfigFlags,
  LegacyResolvedDbConfig,
} from "../../../shared/legacy-db-config.types.ts";
import {
  LegacyDbConnectError,
  LegacyDbExecError,
} from "../../../shared/legacy-db-connection.errors.ts";
import {
  LegacyDbConnection,
  type LegacyDbSession,
  type LegacyPgConnInput,
} from "../../../shared/legacy-db-connection.service.ts";
import { LegacyDebugLogger } from "../../../shared/legacy-debug-logger.service.ts";
import {
  LegacyDockerRun,
  type LegacyDockerRunOpts,
} from "../../../shared/legacy-docker-run.service.ts";
import type { LegacyMigrationSquashFlags } from "./squash.command.ts";
import { legacyMigrationSquash } from "./squash.handler.ts";

// ---------------------------------------------------------------------------
// A fake `LegacyDockerRun` that distinguishes squash's own three one-shot
// `pg_dump` containers from the shadow's PG15+ platform-baseline setup jobs
// purely by their env matrix: only a `pg_dump` invocation ever carries
// `PGDATABASE` (`legacyToDumpEnv`) — none of the realtime/storage/auth
// one-shot jobs do (`db-setup.ts`). Among the dump calls, the first two
// sharing `EXTRA_FLAGS=--schema=auth|storage` are the before/after diff dumps
// (in that call order — `squashMigrations` dumps `before` strictly before
// applying migrations, `after` strictly after); a dump call with no
// `EXTRA_FLAGS` at all is the final, unrestricted full dump.
// ---------------------------------------------------------------------------

function mockSquashDockerRun(
  opts: {
    readonly beforeSql?: string;
    readonly afterSql?: string;
    readonly fullSql?: string;
    readonly failDump?: "before" | "after" | "full";
    readonly failSetupJob?: boolean;
  } = {},
) {
  const dumpCalls: Array<LegacyDockerRunOpts> = [];
  const setupJobCalls: Array<LegacyDockerRunOpts> = [];
  let authStorageCalls = 0;

  const layer = Layer.succeed(LegacyDockerRun, {
    run: () => Effect.die("LegacyDockerRun.run is unused by migration squash"),
    runCapture: () => Effect.die("LegacyDockerRun.runCapture is unused by migration squash"),
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

// ---------------------------------------------------------------------------
// Filesystem fault injection — a single wrapper layer covering every
// filesystem failure squash's own scenarios need, keyed by exact absolute
// path so unrelated reads/writes elsewhere in the setup pipeline are
// unaffected. Follows `tests/helpers/legacy-mocks.ts`'s own
// `legacyFailWriteStringOnNthCallFsLayer` pattern.
// ---------------------------------------------------------------------------

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
  /**
   * Makes `fs.open(path, { flag: "w" })` itself fail — squash's SINGLE target-file open
   * call (CLI-1969 review: collapsed from a truncate-then-reopen two-step into one
   * `O_TRUNC`-equivalent open, matching `new.handler.ts:87`'s precedent).
   */
  readonly failOpenPath?: string;
  /**
   * Lets the Nth+ `writeAll` call on the open handle for `path` fail (1-indexed),
   * succeeding on every earlier call — so the full-dump stream's own `writeAll` (call 1)
   * and the separator/diff tail's `writeAll` (call 2) can be failed independently,
   * exercising both of squash's distinct write-failure call sites.
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

/** The default `[db] shadow_port`, i.e. the port squash's own shadow listens on. */
const LEGACY_SHADOW_PORT = 54320;

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
  /** Omits `ref` entirely from the resolved config, matching the real resolver's own `--local`/`--db-url` shape (`ref` is an optional field, not always `None` — see `legacy-db-config.types.ts`). */
  readonly omitRef?: boolean;
  readonly failResolve?: boolean;
  readonly failSql?: string;
  readonly networkId?: string;
  /**
   * Every connect to the shadow's own port is refused, so its readiness gate
   * (`legacyWaitForShadowReady`) keeps polling until the health budget runs out. That gate is a
   * direct Postgres connect probe, not the Docker healthcheck, so an unconnectable shadow — not
   * an unhealthy container — is what a squash readiness timeout actually looks like.
   */
  readonly neverConnectableShadow?: boolean;
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
  const telemetry = mockLegacyTelemetryStateTracked();
  const cache = mockLegacyLinkedProjectCacheTracked();

  const spawner = mockLegacyShadowContainerCliSpawner({
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
  // Every `exec`/`query` call, in ONE combined call-order log — `execs`/`queries` above
  // can't prove statement ORDER (`.toContain`/`.find` are order-blind), so a swapped
  // DELETE/INSERT in the baseline transaction would ship green against them alone
  // (CLI-1969 review item #7).
  const statements: Array<{ readonly sql: string; readonly params?: ReadonlyArray<unknown> }> = [];
  const connectedDatabases: Array<string> = [];
  const connection = Layer.succeed(LegacyDbConnection, {
    connect: (cfg: LegacyPgConnInput) =>
      Effect.gen(function* () {
        connectedDatabases.push(cfg.database);
        if (opts.neverConnectableShadow === true && cfg.port === LEGACY_SHADOW_PORT) {
          return yield* Effect.fail(new LegacyDbConnectError({ message: "connection refused" }));
        }
        const session: LegacyDbSession = {
          exec: (sql: string) =>
            Effect.suspend(() => {
              execs.push(sql);
              statements.push({ sql });
              return opts.failSql !== undefined && sql.includes(opts.failSql)
                ? Effect.fail(new LegacyDbExecError({ message: "boom" }))
                : Effect.void;
            }),
          query: (sql: string, params?: ReadonlyArray<unknown>) =>
            Effect.suspend(() => {
              queries.push({ sql, params });
              statements.push({ sql, params });
              return opts.failSql !== undefined && sql.includes(opts.failSql)
                ? Effect.fail(new LegacyDbExecError({ message: "boom" }))
                : Effect.succeed<ReadonlyArray<Record<string, unknown>>>([]);
            }),
          extensionExists: () => Effect.succeed(false),
          copyToCsv: () => Effect.succeed(new Uint8Array()),
          queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
        };
        return session;
      }),
  });

  const resolverCalls: Array<LegacyDbConfigFlags> = [];
  const resolver = Layer.succeed(LegacyDbConfigResolver, {
    resolve: (flags: LegacyDbConfigFlags) => {
      resolverCalls.push(flags);
      if (opts.failResolve === true) {
        return Effect.fail(
          new LegacyProjectNotLinkedError({
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
        // A real `--local`/`--db-url` resolution can genuinely omit `ref` altogether
        // (it's an optional field, not always `None`) — `omitRef` reproduces that
        // shape so `runSquash`'s `cfg.ref ?? Option.none()` fallback stays exercised.
        ...(opts.omitRef === true
          ? {}
          : { ref: opts.linkedRef !== undefined ? Option.some(opts.linkedRef) : Option.none() }),
      } satisfies LegacyResolvedDbConfig);
    },
    resolvePoolerFallback: () => Effect.succeed(Option.none()),
  });

  // `loadProjectRef` gives an explicit `--project-ref` flag top precedence, same
  // as Go's `flags.LoadProjectRef` — mirror that so a test can prove the flag
  // (not just the `opts.linkedRef`/`LEGACY_VALID_REF` fallback) drives the linked ref.
  const projectRef = Layer.succeed(LegacyProjectRefResolver, {
    resolve: () => Effect.succeed(opts.linkedRef ?? LEGACY_VALID_REF),
    resolveForLink: () => Effect.succeed(opts.linkedRef ?? LEGACY_VALID_REF),
    resolveOptional: () => Effect.succeed(Option.some(opts.linkedRef ?? LEGACY_VALID_REF)),
    loadProjectRef: (flagValue: Option.Option<string>) =>
      Effect.succeed(
        Option.isSome(flagValue) && flagValue.value.length > 0
          ? flagValue.value
          : (opts.linkedRef ?? LEGACY_VALID_REF),
      ),
    promptProjectRef: () => Effect.succeed(opts.linkedRef ?? LEGACY_VALID_REF),
  });

  const debugLogs: Array<string> = [];
  const debugLogger = Layer.succeed(LegacyDebugLogger, {
    debug: (message: string) =>
      Effect.sync(() => {
        debugLogs.push(message);
      }),
    http: () => Effect.void,
  });

  const baseLayer = Layer.mergeAll(
    // Listed first so every fake service layer below overrides its real
    // implementation — `Layer.mergeAll` is last-wins on a shared service,
    // matching `diff.integration.test.ts`'s own established ordering.
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
    mockLegacyCliConfig({ workdir }),
    Layer.succeed(LegacyDnsResolverFlag, "native"),
    Layer.succeed(LegacyDebugFlag, false),
    Layer.succeed(LegacyExperimentalFlag, false),
    Layer.succeed(LegacyYesFlag, opts.yes ?? false),
    Layer.succeed(
      LegacyNetworkIdFlag,
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

const flags = (over: Partial<LegacyMigrationSquashFlags> = {}): LegacyMigrationSquashFlags => ({
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

const tmp = useLegacyTempWorkdir();
// The shadow baseline cache is ON by default and would otherwise add a `docker stop`/`docker cp`/
// `docker start` round trip plus a snapshot tar to every shadow this suite provisions. This suite
// is about the command, not the cache, so it asserts the plain shadow lifecycle.
useLegacyShadowCacheDisabled();

describe("legacy migration squash", () => {
  describe("flag surface & ordering", () => {
    it.effect("rejects --linked combined with --local", () => {
      const s = setup(tmp.current, { args: ["--linked", "--local"] });
      return Effect.gen(function* () {
        const exit = yield* legacyMigrationSquash(flags({ linked: true, local: true })).pipe(
          Effect.exit,
        );
        expect(failureTag(exit)).toBe("LegacyMigrationTargetFlagsError");
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
        const exit = yield* legacyMigrationSquash(
          flags({ dbUrl: Option.some("postgresql://x"), password: Option.some("y") }),
        ).pipe(Effect.exit);
        expect(failureTag(exit)).toBe("LegacyMigrationPasswordFlagsError");
        if (Exit.isFailure(exit)) {
          const failure = Cause.findErrorOption(exit.cause);
          expect(Option.isSome(failure) && (failure.value as { message: string }).message).toBe(
            "if any flags in the group [db-url password] are set none of the others can be; [db-url password] were all set",
          );
        }
      }).pipe(Effect.provide(s.layer));
    });

    it.effect("rejects --project-ref on the default local target", () => {
      // No target flag given at all — squash defaults to `--local`, so the
      // guard must fire from the flag alone, with no explicit --local needed.
      const s = setup(tmp.current);
      return Effect.gen(function* () {
        const exit = yield* legacyMigrationSquash(
          flags({ projectRef: Option.some(LEGACY_VALID_REF) }),
        ).pipe(Effect.exit);
        expect(failureTag(exit)).toBe("LegacyMigrationTargetFlagsError");
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
        args: ["--db-url", "postgresql://x", "--project-ref", LEGACY_VALID_REF],
      });
      return Effect.gen(function* () {
        const exit = yield* legacyMigrationSquash(
          flags({
            dbUrl: Option.some("postgresql://x"),
            projectRef: Option.some(LEGACY_VALID_REF),
          }),
        ).pipe(Effect.exit);
        expect(failureTag(exit)).toBe("LegacyMigrationTargetFlagsError");
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
          const exit = yield* legacyMigrationSquash(flags({ version: Option.some("0_init") })).pipe(
            Effect.exit,
          );
          expect(failureTag(exit)).toBe("LegacyMigrationInvalidVersionError");
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
        const exit = yield* legacyMigrationSquash(
          flags({ version: Option.some("99999999999999999999") }),
        ).pipe(Effect.exit);
        expect(failureTag(exit)).toBe("LegacyMigrationInvalidVersionError");
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
        const exit = yield* legacyMigrationSquash(flags({ version: Option.some("9") })).pipe(
          Effect.exit,
        );
        expect(failureTag(exit)).toBe("LegacyMigrationFileNotFoundError");
        if (Exit.isFailure(exit)) {
          const failure = Cause.findErrorOption(exit.cause);
          expect(Option.isSome(failure) && (failure.value as { message: string }).message).toBe(
            "glob supabase/migrations/9_*.sql: file does not exist",
          );
        }
      }).pipe(Effect.provide(s.layer));
    });

    it.effect("surfaces a db-config resolution failure before validating --version", () => {
      // Cobra's pre-run order resolves the DB target before `squash.Run`'s own
      // `strconv.Atoi` version check — so an unlinked/invalid target wins over a
      // bad version, matching `migration repair`'s identical ordering test.
      const s = setup(tmp.current, { failResolve: true });
      return Effect.gen(function* () {
        const exit = yield* legacyMigrationSquash(
          flags({ version: Option.some("not-a-number") }),
        ).pipe(Effect.exit);
        expect(failureTag(exit)).toBe("LegacyProjectNotLinkedError");
      }).pipe(Effect.provide(s.layer));
    });

    it.effect("defaults to the local database when no target flag is given", () => {
      seedMigration(tmp.current, "0_init.sql");
      // `omitRef` matches the real resolver's own `--local` shape: no `ref` at all,
      // not merely `None` — exercising the `cfg.ref ?? Option.none()` fallback.
      const s = setup(tmp.current, { args: [], omitRef: true });
      return Effect.gen(function* () {
        yield* legacyMigrationSquash(flags());
        expect(s.resolverCalls[0]?.connType).toBe("local");
      }).pipe(Effect.provide(s.layer));
    });
  });

  describe("squashToVersion", () => {
    it.effect("fails with 'version not found' when the migrations directory is empty", () => {
      const s = setup(tmp.current);
      return Effect.gen(function* () {
        const exit = yield* legacyMigrationSquash(flags()).pipe(Effect.exit);
        expect(failureTag(exit)).toBe("LegacyMigrationSquashMissingVersionError");
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
          const exit = yield* legacyMigrationSquash(flags()).pipe(Effect.exit);
          expect(failureTag(exit)).toBe("LegacyMigrationSquashMissingVersionError");
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
          const error = yield* legacyMigrationSquash(flags()).pipe(Effect.flip);
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
          yield* legacyMigrationSquash(flags());
          expect(stderr(s.out)).toContain(
            "supabase/migrations/0_init.sql is already the earliest migration.",
          );
          expect(s.shadowSpawned).toEqual([]);
          expect(s.dumpCalls).toEqual([]);
          // Step 2 still runs on the no-op path (it falls through to it).
          expect(stdout(s.out)).toContain("Finished supabase migration squash.");
          expect(stderr(s.out)).toContain(
            "Run supabase migration repair --status applied to update your remote migration history table.",
          );
        }).pipe(Effect.provide(s.layer));
      },
    );
  });

  // Happy path — squashing two-or-more migrations

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
          yield* legacyMigrationSquash(flags());

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

          // Hardcoded (not recomputed via `squash.diff.ts`'s own helpers) so a
          // regression in the separator constant or the diff algorithm itself
          // — not just in how `squashMigrations` wires them together — still
          // fails this assertion.
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
          yield* legacyMigrationSquash(flags());
          expect(s.dumpCalls).toHaveLength(3);
          const [before, after, full] = s.dumpCalls;
          expect(before?.env["EXTRA_FLAGS"]).toBe("--schema=auth|storage");
          expect(before?.env["EXCLUDED_SCHEMAS"]).toBeUndefined();
          expect(after?.env["EXTRA_FLAGS"]).toBe("--schema=auth|storage");
          expect(after?.env["EXCLUDED_SCHEMAS"]).toBeUndefined();
          expect(full?.env["EXTRA_FLAGS"]).toBeUndefined();
          expect(full?.env["EXCLUDED_SCHEMAS"]).toBe(LEGACY_INTERNAL_SCHEMAS.join("|"));
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "runs every dump container on host networking with the shadow's connection env and the config Postgres image",
      () => {
        const s = setupHappyPath();
        return Effect.gen(function* () {
          yield* legacyMigrationSquash(flags());
          expect(s.dumpCalls).toHaveLength(3);
          for (const call of s.dumpCalls) {
            expect(call.env["PGPORT"]).toBe("54320");
            expect(call.env["PGUSER"]).toBe("postgres");
            expect(call.env["PGDATABASE"]).toBe("postgres");
            expect(call.network).toEqual({ _tag: "host" });
            expect(call.cmd).toEqual(["bash", "-c", legacyDumpSchemaScript, "--"]);
            // `legacyStreamPgDump` applies the registry mirror itself —
            // the default (no override) registry rewrites
            // to the ECR mirror, not the bare Dockerfile-manifest tag.
            expect(call.image).toBe(legacyGetRegistryImageUrl(dockerfileServiceImage("pg")));
          }
          // Every dump dials the SAME shadow host, whatever this machine's Docker
          // context resolves it to (`legacyGetHostname`) — self-consistency avoids
          // hardcoding the host-dependent value.
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
          yield* legacyMigrationSquash(flags());
          const expectedHost = LEGACY_FAKE_SHADOW_CONTAINER_ID.slice(0, 12);
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
          yield* legacyMigrationSquash(flags());
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
        // The project `.env` is applied before any of
        // squash's three pg_dump containers start; each one resolves its image through
        // the same registry-mirror lookup — so a registry mirror set only in `supabase/.env`
        // reaches all three. The handler applies that with `legacyApplyProjectEnv`, scoped to
        // the run and reverted when it completes.
        const prev = process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"];
        delete process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"];
        const s = setupHappyPath();
        writeFileSync(
          join(tmp.current, "supabase", ".env"),
          "SUPABASE_INTERNAL_IMAGE_REGISTRY=my-mirror.example.com\n",
        );
        return Effect.gen(function* () {
          yield* legacyMigrationSquash(flags());
          expect(s.dumpCalls).toHaveLength(3);
          for (const call of s.dumpCalls) {
            expect(call.image).toMatch(/^my-mirror\.example\.com\/supabase\//u);
          }
          // Reverted once the command's own scope closes (`Effect.scoped` on `runSquash`'s
          // terminal pipe) — never leaks into a later command in the same process.
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
        // Host networking is the default, but an explicit network id
        // overrides it whenever that resolves non-empty — a value sourced only from
        // `supabase/.env` still wins over host.
        const prev = process.env["SUPABASE_NETWORK_ID"];
        delete process.env["SUPABASE_NETWORK_ID"];
        const s = setupHappyPath();
        writeFileSync(join(tmp.current, "supabase", ".env"), "SUPABASE_NETWORK_ID=dotenv-net\n");
        return Effect.gen(function* () {
          yield* legacyMigrationSquash(flags());
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
        yield* legacyMigrationSquash(flags({ version: Option.some("1") }));
        const migrationsDir = join(tmp.current, "supabase", "migrations");
        expect(existsSync(join(migrationsDir, "0_init.sql"))).toBe(false);
        expect(existsSync(join(migrationsDir, "1_target.sql"))).toBe(true);
        // The newer file was never touched — outside the `--version 1` window.
        expect(readFileSync(join(migrationsDir, "2_after.sql"), "utf8")).toBe(
          "create table c (id int);\n",
        );
      }).pipe(Effect.provide(s.layer));
    });
  });

  // The shadow baseline cache (`shared/db-bootstrap/shadow-cache.ts`) is ON by default in
  // production; the suite-wide `useLegacyShadowCacheDisabled` above turns it off everywhere else
  // so the other scenarios assert the plain shadow lifecycle. These scenarios turn it back on —
  // under a per-test `SUPABASE_HOME`, so the ~90MB-in-production tar never lands in the
  // developer's real `~/.supabase` — and drive squash twice to prove the seam is wired: the
  // second run must reuse the first's baseline WITHOUT changing anything squash itself produces.
  // The cache's own mechanics (key derivation, atomic publish, retention, degradation) are
  // covered at their own level in `shared/db-bootstrap/shadow-cache.integration.test.ts`.
  describe("shadow baseline cache", () => {
    const BEFORE_SQL = "CREATE SCHEMA IF NOT EXISTS auth;\nold auth object;\n";
    const AFTER_SQL = "CREATE SCHEMA IF NOT EXISTS auth;\nnew auth object;\n";
    const FULL_SQL = "CREATE TABLE t (id int);\n";
    const EXPECTED_TARGET =
      FULL_SQL +
      "\n--\n-- Dumped schema changes for auth and storage\n--\n\n" +
      "new auth object;\n";

    /** Re-enables the cache the suite-wide gate turned off, rooted at a per-test `SUPABASE_HOME`. */
    const withCacheEnabled = <A, E, R>(body: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      withLegacyShadowCacheEnabled(join(tmp.current, "_supabase_home"), body);

    /** One full squash run over a freshly re-seeded two-migration project. */
    const runSquash = Effect.fnUntraced(function* () {
      seedMigration(tmp.current, "0_init.sql", "create table a (id int);\n");
      seedMigration(tmp.current, "1_target.sql", "create table b (id int);\n");
      const s = setup(tmp.current, {
        beforeDumpSql: BEFORE_SQL,
        afterDumpSql: AFTER_SQL,
        fullDumpSql: FULL_SQL,
      });
      yield* legacyMigrationSquash(flags()).pipe(Effect.provide(s.layer));
      return s;
    });

    it.effect(
      "reuses the first run's platform baseline on the second squash, without changing the dumps it produces",
      () =>
        withCacheEnabled(
          Effect.gen(function* () {
            const cold = yield* runSquash();
            // Cold: the baseline really ran (progress lines + the PG15+ one-shot setup jobs),
            // and the snapshot was taken at the baseline seam (`docker stop` -> `cp` -> `start`).
            expect(stderr(cold.out)).toContain("Initialising schema...");
            expect(stderr(cold.out)).toContain("Seeding globals from roles.sql...");
            expect(cold.setupJobCalls.length).toBeGreaterThan(0);
            expect(cold.shadowSpawned.filter((c) => c.args[0] === "stop")).toHaveLength(1);
            expect(cold.shadowSpawned.filter((c) => c.args[0] === "start").length).toBeGreaterThan(
              0,
            );

            const warm = yield* runSquash();
            // Warm: the restored cluster already carries the baseline, so `SetupDatabase` — and
            // therefore its progress text and its one-shot jobs — is skipped entirely, and
            // nothing is re-snapshotted.
            expect(stderr(warm.out)).not.toContain("Initialising schema...");
            expect(stderr(warm.out)).not.toContain("Seeding globals from roles.sql...");
            expect(warm.setupJobCalls).toHaveLength(0);
            expect(warm.shadowSpawned.filter((c) => c.args[0] === "stop")).toHaveLength(0);

            // Everything downstream of the baseline seam is untouched: both dumps, the
            // migrations, the rewritten target file, and the shadow's own lifecycle.
            expect(warm.dumpCalls).toHaveLength(3);
            expect(stderr(warm.out)).toContain("Applying migration 0_init.sql...");
            expect(stderr(warm.out)).toContain("Applying migration 1_target.sql...");
            expect(stderr(warm.out)).toContain(
              "Squashed local migrations to supabase/migrations/1_target.sql",
            );
            expect(warm.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
            const target = join(tmp.current, "supabase", "migrations", "1_target.sql");
            expect(readFileSync(target, "utf8")).toBe(EXPECTED_TARGET);
          }),
        ),
    );

    it.effect("keys its snapshots under the cache root, not the project directory", () =>
      withCacheEnabled(
        Effect.gen(function* () {
          yield* runSquash();
          // The production path helper resolving the `SUPABASE_HOME` `withCacheEnabled` pinned,
          // not a hand-built join — so this stays honest if the cache root ever moves.
          const cacheDir = legacyShadowBaselineCacheDir(yield* Path.Path);
          const tars = readdirSync(cacheDir).filter((name) => name.endsWith(".tar"));
          expect(tars).toHaveLength(1);
          expect(tars[0]).toMatch(/^shadow-baseline-[0-9a-f]+\.tar$/);
          expect(existsSync(join(tmp.current, "supabase", ".temp", "shadow-baseline"))).toBe(false);
        }).pipe(Effect.provide(BunServices.layer)),
      ),
    );
  });

  // Failure paths — every one leaves the shadow removed (unless creation
  // itself is what failed, matching the established leak-on-create-failure behavior).

  describe("squashMigrations failure paths", () => {
    it.effect("fails when the shadow container cannot be created and never attempts a dump", () => {
      seedMigration(tmp.current, "0_init.sql");
      seedMigration(tmp.current, "1_target.sql");
      const s = setup(tmp.current, { failCreateShadow: true });
      return Effect.gen(function* () {
        const exit = yield* legacyMigrationSquash(flags()).pipe(Effect.exit);
        expect(failureTag(exit)).toBe("LegacyShadowDbError");
        expect(s.shadowSpawned.filter((c) => c.args[0] === "create")).toHaveLength(1);
        // Nothing to release — the container was never created (the established
        // leak-on-create-failure behavior, see `legacyCreateShadowDatabase`'s doc).
        expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toEqual([]);
        expect(s.dumpCalls).toEqual([]);
      }).pipe(Effect.provide(s.layer));
    });

    it.effect(
      "fails with a health-check timeout when the shadow never becomes connectable, and removes it",
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
        const s = setup(tmp.current, { neverConnectableShadow: true });
        return Effect.gen(function* () {
          const exit = yield* legacyMigrationSquash(flags()).pipe(Effect.exit);
          expect(failureTag(exit)).toBe("LegacyHealthCheckTimeoutError");
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
          const exit = yield* legacyMigrationSquash(flags()).pipe(Effect.exit);
          expect(failureTag(exit)).toBe("LegacyDbSetupError");
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
        const exit = yield* legacyMigrationSquash(flags()).pipe(Effect.exit);
        expect(failureTag(exit)).toBe("LegacyMigrationApplyError");
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
          const exit = yield* legacyMigrationSquash(flags()).pipe(Effect.exit);
          expect(failureTag(exit)).toBe("LegacyMigrationSquashDumpError");
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
          const exit = yield* legacyMigrationSquash(flags()).pipe(Effect.exit);
          expect(failureTag(exit)).toBe("LegacyMigrationSquashDumpError");
          expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
          const targetPath = join(tmp.current, "supabase", "migrations", "1_target.sql");
          // Truncated (by the earlier `O_TRUNC`), then only the partial stream the
          // dying container managed to write before failing — no separator/diff
          // was ever appended, since the whole operation aborted first.
          expect(readFileSync(targetPath, "utf8")).toBe("partial output before the container died");
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "fails with 'failed to open migration file' when the target file cannot be truncated/opened",
      () => {
        // Squash's ONE `O_TRUNC`-equivalent open call (CLI-1969 review: collapsed from a
        // truncate-then-reopen two-step into a single `fs.open(path, { flag: "w" })`,
        // matching `new.handler.ts:87`'s precedent) — a single failure site, not two.
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
          const exit = yield* legacyMigrationSquash(flags()).pipe(Effect.exit);
          expect(failureTag(exit)).toBe("LegacyMigrationSquashWriteError");
          if (Exit.isFailure(exit)) {
            const failure = Cause.findErrorOption(exit.cause);
            const message =
              Option.isSome(failure) && (failure.value as { message: string }).message;
            expect(message).toContain("failed to open migration file:");
            // Relativized (CLI-1969 review item #3): the absolute tmp workdir never leaks.
            expect(message).not.toContain(tmp.current);
          }
          expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "fails with 'failed to copy docker logs' when streaming the full dump into the target file fails",
      () => {
        // The underlying failure on this path is the docker-log-stream write into the
        // target file, byte-matching "failed to
        // copy docker logs:" — NOT `lineByLineDiff`'s own "failed to write line:" below.
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
          const exit = yield* legacyMigrationSquash(flags()).pipe(Effect.exit);
          expect(failureTag(exit)).toBe("LegacyMigrationSquashWriteError");
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
          // `fromCall: 2` lets the full-dump stream's own `writeAll` (call 1)
          // succeed, isolating the separator/diff tail's write (call 2).
          fsFaults: { failWriteAllFromCall: { path: targetPath, fromCall: 2 } },
        });
        return Effect.gen(function* () {
          const exit = yield* legacyMigrationSquash(flags()).pipe(Effect.exit);
          expect(failureTag(exit)).toBe("LegacyMigrationSquashWriteError");
          if (Exit.isFailure(exit)) {
            const failure = Cause.findErrorOption(exit.cause);
            const message =
              Option.isSome(failure) && (failure.value as { message: string }).message;
            expect(message).toContain("failed to write line:");
            // Relativized (CLI-1969 review item #3): the absolute tmp workdir never leaks.
            expect(message).not.toContain(tmp.current);
          }
          expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
          // The full dump itself made it onto disk before the tail write failed.
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
        yield* legacyMigrationSquash(flags());
        // Non-fatal: the command still finishes successfully.
        expect(stdout(s.out)).toContain("Finished supabase migration squash.");
        // The failed removal's relativized error text reached stderr — pinned, not just
        // "non-empty", and proves the workdir-relative path (never the absolute one).
        expect(stderr(s.out)).toContain("FileSystem.remove (supabase/migrations/0_init.sql)");
        // The file that failed to be removed is still on disk.
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
          yield* legacyMigrationSquash(flags());
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
        yield* legacyMigrationSquash(flags());
        expect(stdout(s.out)).toContain("Finished supabase migration squash.");
        expect(stderr(s.out)).toContain(
          `Failed to remove container: ${LEGACY_FAKE_SHADOW_CONTAINER_ID}`,
        );
      }).pipe(Effect.provide(s.layer));
    });
  });

  // Step 2 — local target

  describe("local target", () => {
    it.effect(
      "prints Finished on stdout and the repair suggestion on stderr, and never prompts",
      () => {
        seedMigration(tmp.current, "0_init.sql");
        const s = setup(tmp.current, { isLocal: true });
        return Effect.gen(function* () {
          yield* legacyMigrationSquash(flags());
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
        yield* legacyMigrationSquash(flags({ dbUrl: Option.some("postgresql://local") }));
        expect(stdout(s.out)).toContain("Finished supabase migration squash.");
      }).pipe(Effect.provide(s.layer));
    });
  });

  // Step 2 — remote target

  describe("remote target", () => {
    function setupRemote(opts: SetupOpts = {}) {
      seedMigration(tmp.current, "0_init.sql");
      return setup(tmp.current, { isLocal: false, linkedRef: LEGACY_VALID_REF, ...opts });
    }

    it.effect("prompts to update the remote history table and baselines on 'y'", () => {
      const s = setupRemote({ confirm: true, args: ["--linked"] });
      return Effect.gen(function* () {
        yield* legacyMigrationSquash(flags({ linked: true }));
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
          yield* legacyMigrationSquash(flags());
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
          yield* legacyMigrationSquash(flags());
          // ONE ordered log (not `execs`/`queries` separately — `.toContain`/`.find` are
          // order-blind, so an INSERT-before-DELETE regression would ship green against
          // them) — the baseline's own transaction is the LAST 4 statements sent, after
          // `legacyCreateMigrationTable`'s own (exec-only) setup transaction.
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
          const exit = yield* legacyMigrationSquash(flags()).pipe(Effect.exit);
          expect(failureTag(exit)).toBe("LegacyMigrationSquashBaselineError");
          if (Exit.isFailure(exit)) {
            const failure = Cause.findErrorOption(exit.cause);
            expect(
              Option.isSome(failure) && (failure.value as { message: string }).message,
            ).toContain("failed to update migration history:");
          }
          expect(s.execs).toContain("ROLLBACK");
          // Exactly one COMMIT — `legacyCreateMigrationTable`'s own setup transaction,
          // which runs (and commits) BEFORE the baseline's own BEGIN/DELETE/INSERT
          // batch; the baseline's OWN transaction never reaches COMMIT.
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
          const exit = yield* legacyMigrationSquash(flags()).pipe(Effect.exit);
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
        yield* legacyMigrationSquash(flags());
        expect(stderr(s.out)).toContain("Update remote migration history table? [Y/n] y");
        expect(s.execs).toContain("BEGIN");
      }).pipe(Effect.provide(s.layer));
    });

    it.effect("a non-TTY run with no piped answer takes the default (yes) and baselines", () => {
      const s = setupRemote({ isTTY: false, pipedInput: undefined });
      return Effect.gen(function* () {
        yield* legacyMigrationSquash(flags());
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
          linkedRef: LEGACY_VALID_REF,
          confirm: true,
        });
        return Effect.gen(function* () {
          yield* legacyMigrationSquash(flags({ version: Option.some("0") }));
          const insert = s.queries.find((q) => q.sql.includes("INSERT INTO supabase_migrations"));
          expect(insert?.params?.[0]).toBe("0");
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect("baselines the surviving older version when a merged-file removal failed", () => {
      // Local versions are re-listed AFTER the file removals — a failed removal
      // means the squash TARGET survives on disk (already true), but so does
      // the OLDER merged file whose removal failed, and THAT older version is
      // what an empty `--version` baselines to, not the squash target.
      seedMigration(tmp.current, "0_init.sql");
      seedMigration(tmp.current, "1_target.sql");
      const earlierPath = join(tmp.current, "supabase", "migrations", "0_init.sql");
      const s = setup(tmp.current, {
        isLocal: false,
        linkedRef: LEGACY_VALID_REF,
        confirm: true,
        beforeDumpSql: "before;\n",
        afterDumpSql: "after;\n",
        fullDumpSql: "full;\n",
        fsFaults: { failRemovePath: earlierPath },
      });
      return Effect.gen(function* () {
        yield* legacyMigrationSquash(flags());
        const insert = s.queries.find((q) => q.sql.includes("INSERT INTO supabase_migrations"));
        // "0" (the surviving older file), NOT "1" (the squash target).
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
          linkedRef: LEGACY_VALID_REF,
          confirm: true,
          beforeDumpSql: "before;\n",
          afterDumpSql: "after;\n",
          fullDumpSql: "full;\n",
          // The FIRST `readDirectory(migrationsDir)` call is `squashToVersion`'s own
          // listing (must succeed so the squash itself completes); the SECOND is
          // `baselineMigrations`'s post-removal re-list, which this fails — the
          // THIRD (inside `legacyResolveMigrationFile`, resolving the now-empty
          // version) must succeed again so the scenario isolates the reload failure.
          fsFaults: { failReadDirectoryAtCall: { path: migrationsDir, atCall: 2 } },
        });
        return Effect.gen(function* () {
          const exit = yield* legacyMigrationSquash(flags()).pipe(Effect.exit);
          expect(s.debugLogs).toHaveLength(1);
          expect(s.debugLogs[0]).toContain("failed to read directory");
          expect(s.debugLogs[0]).toContain("simulated failure");
          expect(stderr(s.out)).toContain("Baselining migration history to \n");
          // `repair.NewMigrationFromVersion("")` finds no match — the empty-version
          // glob fails, which surfaces as the baseline's own missing-file error,
          // proving `resolvedVersion` genuinely stayed "" rather than falling back
          // to the squash target.
          expect(failureTag(exit)).toBe("LegacyMigrationFileNotFoundError");
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
        linkedRef: LEGACY_VALID_REF,
        args: ["--linked"],
      });
      return Effect.gen(function* () {
        const exit = yield* legacyMigrationSquash(
          flags({ linked: true, version: Option.some("bad") }),
        ).pipe(Effect.exit);
        expect(failureTag(exit)).toBe("LegacyMigrationInvalidVersionError");
        expect(s.cache.cached).toBe(true);
        expect(s.cache.cachedRef).toBe(LEGACY_VALID_REF);
      }).pipe(Effect.provide(s.layer));
    });

    it.effect(
      "--linked --project-ref overrides the workdir's own linked ref for resolution and caching",
      () => {
        // `opts.linkedRef` (LEGACY_VALID_REF) represents whatever the workdir would
        // resolve to absent the flag — the explicit --project-ref flag must win over
        // it, both for the resolver call and for what ultimately gets cached.
        const FLAG_REF = "flagflagflagflagflag";
        const s = setup(tmp.current, {
          isLocal: false,
          linkedRef: LEGACY_VALID_REF,
          args: ["--linked", "--project-ref", FLAG_REF],
        });
        return Effect.gen(function* () {
          const exit = yield* legacyMigrationSquash(
            flags({ linked: true, projectRef: Option.some(FLAG_REF), version: Option.some("bad") }),
          ).pipe(Effect.exit);
          expect(failureTag(exit)).toBe("LegacyMigrationInvalidVersionError");
          expect(s.cache.cached).toBe(true);
          expect(s.cache.cachedRef).toBe(FLAG_REF);
          expect(s.cache.cachedRef).not.toBe(LEGACY_VALID_REF);
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "--linked reads [remotes.<ref>] and prints the config-override line before resolving",
      () => {
        mkdirSync(join(tmp.current, "supabase"), { recursive: true });
        writeFileSync(
          join(tmp.current, "supabase", "config.toml"),
          ["[remotes.dev]", `project_id = "${LEGACY_VALID_REF}"`, ""].join("\n"),
        );
        seedMigration(tmp.current, "0_init.sql");
        const s = setup(tmp.current, {
          isLocal: false,
          linkedRef: LEGACY_VALID_REF,
          confirm: true,
          args: ["--linked"],
        });
        return Effect.gen(function* () {
          yield* legacyMigrationSquash(flags({ linked: true }));
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
        yield* legacyMigrationSquash(flags());
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
        yield* legacyMigrationSquash(flags());
        expect(stdout(s.out)).not.toContain("Finished");
        expect(stderr(s.out)).not.toContain("Run supabase migration repair");
      }).pipe(Effect.provide(s.layer));
    });

    it.effect("stream-json emits the result event on stdout with progress lines on stderr", () => {
      seedMigration(tmp.current, "0_init.sql");
      const s = setup(tmp.current, { format: "stream-json", isLocal: true });
      return Effect.gen(function* () {
        yield* legacyMigrationSquash(flags());
        expect(s.out.messages.some((m) => m.type === "success")).toBe(true);
        expect(stderr(s.out)).toContain("is already the earliest migration.");
      }).pipe(Effect.provide(s.layer));
    });

    it.effect("json still writes the prompt label to stderr and reads the piped answer", () => {
      seedMigration(tmp.current, "0_init.sql");
      const s = setup(tmp.current, {
        format: "json",
        isLocal: false,
        linkedRef: LEGACY_VALID_REF,
        confirm: true,
      });
      return Effect.gen(function* () {
        yield* legacyMigrationSquash(flags());
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
          linkedRef: LEGACY_VALID_REF,
          confirm: false,
        });
        return Effect.gen(function* () {
          yield* legacyMigrationSquash(flags());
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
        linkedRef: LEGACY_VALID_REF,
        confirm: true,
        beforeDumpSql: "before;\n",
        afterDumpSql: "after;\n",
        fullDumpSql: "full;\n",
      });
      return Effect.gen(function* () {
        yield* legacyMigrationSquash(flags());
        const success = s.out.messages.find((m) => m.type === "success");
        // "1_target.sql" is the sole surviving local file once "0_init.sql" is removed, so
        // the empty-`--version` baseline reload (`legacyLoadLocalVersions`, run AFTER the
        // removal) resolves to its own version, "1" — matching `squashedInto` below, NOT
        // the removed file's "0".
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
