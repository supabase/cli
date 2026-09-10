import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { stripAnsi } from "../../../../../../tests/helpers/ansi.ts";

import {
  alwaysReadyHttpClientLayer,
  defaultLocalResetRoute,
  localResetCreateArgs,
  localResetRemovedContainers,
  mockContainerCliSpawner,
} from "../../../../../../tests/helpers/local-reset.ts";
import {
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
  mockStdin,
  mockTty,
} from "../../../../../../tests/helpers/mocks.ts";
import {
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockLocalDockerEngineUnavailableLayer,
  mockCommandPlatformApiService,
  mockTelemetryStateTracked,
  useTempWorkdir,
  sequentialExecBatch,
} from "../../../../../../tests/helpers/command-mocks.ts";
import { CliArgs } from "../../../../../shared/cli/cli-args.service.ts";
import {
  DebugFlag,
  DnsResolverFlag,
  ExperimentalFlag,
  NetworkIdFlag,
  YesFlag,
} from "../../../../../command-internal/global-flags.ts";
import { GoProxy } from "../../../../../command-internal/go-proxy.service.ts";
import { CommandPlatformApi } from "../../../../../auth/command-platform-api.service.ts";
import { CommandPlatformApiFactory } from "../../../../../auth/command-platform-api-factory.service.ts";
import { dockerRunLayer } from "../../../../../command-internal/docker-run.layer.ts";
import { DbConfigResolver } from "../../../../../command-internal/db-config.service.ts";
import {
  type DbSession,
  DbConnection,
} from "../../../../../command-internal/db-connection.service.ts";
import { PgDeltaEngine, PgDeltaEngineError } from "../../../shared/pgdelta-engine.service.ts";
import { DeclarativeShadowDbError } from "../../../shared/pgdelta.errors.ts";
import { DeclarativeSeam } from "../../../shared/pgdelta.seam.service.ts";
import type { DbSchemaDeclarativeGenerateFlags } from "./generate.command.ts";
import { dbSchemaDeclarativeGenerate } from "./generate.handler.ts";

interface SetupOpts {
  experimental?: boolean;
  args?: ReadonlyArray<string>;
  yes?: boolean;
  stdinIsTty?: boolean;
  promptConfirmResponses?: ReadonlyArray<boolean>;
  promptSelectResponses?: ReadonlyArray<string>;
  promptTextResponses?: ReadonlyArray<string>;
  /**
   * Makes the local-reset prompt's `resetLocalDatabase` fail immediately
   * with `ResetLocalDbNotRunningError` (the local `db` container reports as
   * not running) instead of completing a real recreate.
   */
  resetShouldFail?: boolean;
  networkId?: Option.Option<string>;
  projectId?: Option.Option<string>;
  /** Makes the engine's `exportDeclarativeSchema` fail after recording the call. */
  exportFails?: boolean;
  staleLocalImage?: boolean;
}

/** What the handler handed the engine for one `exportDeclarativeSchema` call. */
interface EngineExportCall {
  readonly targetRef: string;
  readonly projectRef: string | undefined;
  readonly strictCoverage: boolean;
}

function setup(workdir: string, opts: SetupOpts = {}) {
  const out = mockOutput({
    promptConfirmResponses: opts.promptConfirmResponses,
    promptSelectResponses: opts.promptSelectResponses,
    promptTextResponses: opts.promptTextResponses,
  });
  const telemetry = mockTelemetryStateTracked();
  const cache = mockLinkedProjectCacheTracked();
  const localPostgresImageChecks: Array<true> = [];
  let ensureStartedCalls = 0;
  const platformApi = mockCommandPlatformApiService({});
  // Backs `resetLocalDatabase`'s real, native container-recreate, reached when the smart-target
  // local-reset prompt is confirmed.
  const child = mockContainerCliSpawner(
    defaultLocalResetRoute("test", { running: opts.resetShouldFail !== true }),
  );
  const dbExec: string[] = [];
  const dbConn = Layer.succeed(DbConnection, {
    connect: () => {
      const session: DbSession = {
        exec: (sql: string) =>
          Effect.sync(() => {
            dbExec.push(sql);
          }),
        query: (sql: string) =>
          Effect.sync(() => {
            dbExec.push(sql);
            return [];
          }),
        extensionExists: () => Effect.succeed(false),
        copyToCsv: () => Effect.succeed(new Uint8Array()),
        queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
        // A migration file's statements arrive as one batch; replay them through
        // `exec`/`query` so this suite's recordings and failure injection still apply.
        execBatch: (statements) => sequentialExecBatch(session)(statements),
      };
      return Effect.succeed(session);
    },
  });
  const seam = Layer.succeed(DeclarativeSeam, {
    ensureLocalDatabaseStarted: () =>
      Effect.sync(() => {
        ensureStartedCalls += 1;
      }),
    isLocalDatabaseRunning: () => Effect.die("isLocalDatabaseRunning not used in generate tests"),
    ensureLocalPostgresImageCurrent: () =>
      Effect.sync(() => {
        localPostgresImageChecks.push(true);
      }).pipe(
        Effect.flatMap(() =>
          opts.staleLocalImage === true
            ? Effect.fail(
                new DeclarativeShadowDbError({
                  message: "local Postgres container image is stale",
                }),
              )
            : Effect.void,
        ),
      ),
  });
  const engineExportCalls: EngineExportCall[] = [];
  const engine = Layer.succeed(
    PgDeltaEngine,
    PgDeltaEngine.of({
      diffExplicit: () => Effect.die("diffExplicit not used in generate tests"),
      diffDatabase: () => Effect.die("diffDatabase not used in generate tests"),
      planDeclarativeSchema: () => Effect.die("planDeclarativeSchema not used in generate tests"),
      exportDeclarativeSchema: (input) =>
        Effect.suspend(() => {
          engineExportCalls.push({
            targetRef: input.target.ref,
            projectRef: input.projectRef,
            strictCoverage: input.strictCoverage,
          });
          return opts.exportFails === true
            ? Effect.fail(
                new PgDeltaEngineError({
                  message: "declarative export failed",
                  cause: undefined,
                }),
              )
            : Effect.succeed({
                files: [{ name: "public/tables/players.sql", sql: "create table players ();" }],
                manifest: { redactSecrets: true, scope: "database", profile: "supabase" },
              });
        }),
    }),
  );
  const resolverCalls: unknown[] = [];
  const resolver = Layer.succeed(DbConfigResolver, {
    resolve: (flags) => {
      resolverCalls.push(flags);
      return Effect.succeed({
        conn: {
          host: "db.remote",
          port: 5432,
          user: "postgres",
          password: "x",
          database: "postgres",
        },
        isLocal: false,
      });
    },
    resolvePoolerFallback: () => Effect.succeed(Option.none()),
  });
  const proxyCalls: ReadonlyArray<string>[] = [];
  const proxy = Layer.succeed(GoProxy, {
    exec: (args) => Effect.sync(() => void proxyCalls.push(args)),
    execCapture: () => Effect.succeed(""),
  });
  const runtimeInfo = mockRuntimeInfo({ platform: "linux" });
  const processControl = mockProcessControl();
  const experimentalFlag = Layer.succeed(ExperimentalFlag, opts.experimental ?? true);
  const cliArgs = Layer.succeed(CliArgs, {
    args: opts.args ?? ["db", "schema", "declarative", "generate"],
  });
  const networkIdFlag = Layer.succeed(NetworkIdFlag, opts.networkId ?? Option.none());
  const debugFlag = Layer.succeed(DebugFlag, false);
  const dockerRun = dockerRunLayer.pipe(
    Layer.provide(child.layer),
    Layer.provide(processControl.layer),
  );
  const layer = Layer.mergeAll(
    out.layer,
    telemetry.layer,
    cache.layer,
    seam,
    engine,
    mockLocalDockerEngineUnavailableLayer,
    resolver,
    proxy,
    dbConn,
    mockCommandSettings({ workdir, projectId: opts.projectId ?? Option.some("test") }),
    mockTty({ stdinIsTty: opts.stdinIsTty ?? false, stdoutIsTty: false }),
    mockStdin(opts.stdinIsTty ?? false),
    experimentalFlag,
    cliArgs,
    Layer.succeed(YesFlag, opts.yes ?? false),
    networkIdFlag,
    Layer.succeed(DnsResolverFlag, "native"),
    debugFlag,
    // The local-reset bucket-seed core statically requires the (lazy) Management-API
    // factory; never invoked on the local reset (projectRef === "").
    Layer.succeed(CommandPlatformApiFactory, {
      make: CommandPlatformApi.pipe(Effect.provide(platformApi.layer)),
    }),
    BunServices.layer,
    // `child.layer` must be listed after `BunServices.layer` — `Layer.mergeAll` resolves a
    // duplicate service tag to whichever layer is listed last, so this mock overrides Bun's
    // real `ChildProcessSpawner` instead of the reverse.
    child.layer,
    runtimeInfo,
    processControl.layer,
    alwaysReadyHttpClientLayer,
    dockerRun,
  );
  return {
    layer,
    out,
    cache,
    telemetry,
    child,
    dbExec,
    engineExportCalls,
    resolverCalls,
    proxyCalls,
    localPostgresImageChecks,
    get ensureStartedCalls() {
      return ensureStartedCalls;
    },
  };
}

const flags = (
  over: Partial<DbSchemaDeclarativeGenerateFlags> = {},
): DbSchemaDeclarativeGenerateFlags => ({
  noCache: over.noCache ?? false,
  strictCoverage: over.strictCoverage ?? false,
  overwrite: over.overwrite ?? false,
  outputDir: over.outputDir ?? Option.none(),
  reset: over.reset ?? false,
  schema: over.schema ?? [],
  dbUrl: over.dbUrl ?? Option.none(),
  linked: over.linked ?? Option.none(),
  local: over.local ?? Option.none(),
  password: over.password ?? Option.none(),
});

const failError = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined;

describe("db schema declarative generate integration", () => {
  const tmp = useTempWorkdir();

  it.effect("gate: fails when neither --experimental nor config enables pg-delta", () => {
    const { layer } = setup(tmp.current, { experimental: false });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        dbSchemaDeclarativeGenerate(flags({ local: Option.some(true) })),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failError(exit)?.constructor.name).toBe("DeclarativeNotEnabledError");
    }).pipe(Effect.provide(layer));
  });

  it.effect("--local --linked with --experimental fails with the mutex error", () => {
    const { layer } = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        dbSchemaDeclarativeGenerate(flags({ local: Option.some(true), linked: Option.some(true) })),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failError(exit)).toMatchObject({
        _tag: "DeclarativeMutuallyExclusiveFlagsError",
        message:
          "if any flags in the group [db-url linked local] are set none of the others can be; [linked local] were all set",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "--local --linked without --experimental fails with the gate error, not the mutex error",
    () => {
      const { layer } = setup(tmp.current, { experimental: false });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          dbSchemaDeclarativeGenerate(
            flags({ local: Option.some(true), linked: Option.some(true) }),
          ),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(failError(exit)?.constructor.name).toBe("DeclarativeNotEnabledError");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "--local --linked with SUPABASE_EXPERIMENTAL env (no --experimental flag) fails with the mutex error",
    () => {
      const { layer } = setup(tmp.current, { experimental: false });
      const ENV = "SUPABASE_EXPERIMENTAL";
      return Effect.gen(function* () {
        const saved = process.env[ENV];
        process.env[ENV] = "1";
        const exit = yield* Effect.exit(
          dbSchemaDeclarativeGenerate(
            flags({ local: Option.some(true), linked: Option.some(true) }),
          ),
        );
        if (saved === undefined) delete process.env[ENV];
        else process.env[ENV] = saved;
        expect(Exit.isFailure(exit)).toBe(true);
        expect(failError(exit)).toMatchObject({
          _tag: "DeclarativeMutuallyExclusiveFlagsError",
          message:
            "if any flags in the group [db-url linked local] are set none of the others can be; [linked local] were all set",
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "an explicit --experimental=false closes the gate even when SUPABASE_EXPERIMENTAL is set",
    () => {
      const { layer } = setup(tmp.current, {
        experimental: false,
        args: ["db", "schema", "declarative", "generate", "--experimental=false"],
      });
      const ENV = "SUPABASE_EXPERIMENTAL";
      return Effect.gen(function* () {
        const saved = process.env[ENV];
        process.env[ENV] = "1";
        const exit = yield* Effect.exit(
          dbSchemaDeclarativeGenerate(flags({ local: Option.some(true) })),
        );
        if (saved === undefined) delete process.env[ENV];
        else process.env[ENV] = saved;
        expect(Exit.isFailure(exit)).toBe(true);
        expect(failError(exit)?.constructor.name).toBe("DeclarativeNotEnabledError");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "--local --linked with SUPABASE_EXPERIMENTAL set only in the project .env fails with the mutex error",
    () => {
      const saved = process.env["SUPABASE_EXPERIMENTAL"];
      delete process.env["SUPABASE_EXPERIMENTAL"];
      mkdirSync(join(tmp.current, "supabase"), { recursive: true });
      writeFileSync(join(tmp.current, "supabase", ".env"), "SUPABASE_EXPERIMENTAL=true\n");
      const { layer } = setup(tmp.current, { experimental: false });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          dbSchemaDeclarativeGenerate(
            flags({ local: Option.some(true), linked: Option.some(true) }),
          ),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(failError(exit)).toMatchObject({
          _tag: "DeclarativeMutuallyExclusiveFlagsError",
          message:
            "if any flags in the group [db-url linked local] are set none of the others can be; [linked local] were all set",
        });
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.sync(() => {
            if (saved === undefined) delete process.env["SUPABASE_EXPERIMENTAL"];
            else process.env["SUPABASE_EXPERIMENTAL"] = saved;
          }),
        ),
      );
    },
  );

  it.effect("warns when the tree still lives under the former supabase/database default", () => {
    // Upgrade path: the implicit default moved from supabase/database to
    // supabase/schemas; a project relying on the old default must be told before
    // a fresh tree is generated somewhere its existing files are not.
    mkdirSync(join(tmp.current, "supabase", "database"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "database", "public.sql"), "create table a();");
    const s = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeGenerate(flags({ local: Option.some(true) }));
      expect(stripAnsi(s.out.stderrText)).toContain(
        "WARNING: found declarative schema files in supabase/database, but the default declarative directory is now supabase/schemas.",
      );
      expect(stripAnsi(s.out.stderrText)).toContain('declarative_schema_path = "./database"');
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("explicit --local: exports from the local database and writes files", () => {
    const s = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeGenerate(flags({ local: Option.some(true) }));
      expect(s.engineExportCalls[0]!.targetRef).toContain(
        "postgresql://postgres:postgres@127.0.0.1:54322",
      );
      const written = yield* Effect.promise(async () =>
        (await import("node:fs")).readFileSync(
          join(tmp.current, "supabase", "schemas", "public", "tables", "players.sql"),
          "utf8",
        ),
      );
      expect(written).toBe("create table players ();");
      expect(
        s.out.rawChunks.map((c) => ({ text: stripAnsi(c.text), stream: c.stream })),
      ).toContainEqual({
        text: `Declarative schema written to ${join("supabase", "schemas")}\n`,
        stream: "stderr",
      });
      expect(s.out.rawChunks.some((c) => c.text.includes(tmp.current))).toBe(false);
      expect(s.ensureStartedCalls).toBe(1);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "--output-dir writes a complete export relative to the project without activating it",
    () => {
      mkdirSync(join(tmp.current, "supabase", "database"), { recursive: true });
      writeFileSync(join(tmp.current, "supabase", "database", "configured.sql"), "select 1;");
      const configPath = join(tmp.current, "supabase", "config.toml");
      const config = [
        "[experimental.pgdelta]",
        "enabled = true",
        'declarative_schema_path = "supabase/database"',
        "",
      ].join("\n");
      writeFileSync(configPath, config);
      const destination = join("supabase", "database-next");
      const s = setup(tmp.current, { experimental: true });
      return Effect.gen(function* () {
        yield* dbSchemaDeclarativeGenerate(
          flags({ local: Option.some(true), outputDir: Option.some(destination) }),
        );

        expect(
          readFileSync(join(tmp.current, destination, "public", "tables", "players.sql"), "utf8"),
        ).toBe("create table players ();");
        expect(
          JSON.parse(readFileSync(join(tmp.current, destination, ".pgdelta-export.json"), "utf8")),
        ).toMatchObject({
          formatVersion: 1,
          profile: "supabase",
          files: ["public/tables/players.sql"],
        });
        expect(
          readFileSync(join(tmp.current, "supabase", "database", "configured.sql"), "utf8"),
        ).toBe("select 1;");
        expect(readFileSync(configPath, "utf8")).toBe(config);
        expect(
          s.out.rawChunks.map((chunk) => ({ text: stripAnsi(chunk.text), stream: chunk.stream })),
        ).toContainEqual({
          text: `Declarative schema written to ${destination}\n`,
          stream: "stderr",
        });
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("--output-dir protects a non-empty destination without --overwrite", () => {
    const destination = join(tmp.current, "staged-schema");
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, "keep.sql"), "select 'keep';");
    const s = setup(tmp.current, {
      experimental: true,
      promptConfirmResponses: [false],
    });
    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeGenerate(
        flags({ local: Option.some(true), outputDir: Option.some(destination) }),
      );
      expect(readFileSync(join(destination, "keep.sql"), "utf8")).toBe("select 'keep';");
      expect(existsSync(join(destination, ".pgdelta-export.json"))).toBe(false);
      expect(s.out.rawChunks.some((chunk) => chunk.text.includes("Skipped writing"))).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("rejects output paths that could overwrite the project or an ancestor", () => {
    const projectDir = join(tmp.current, "project");
    mkdirSync(projectDir, { recursive: true });
    const sentinel = join(projectDir, "project-sentinel.txt");
    writeFileSync(sentinel, "keep");
    const s = setup(projectDir, { experimental: true });
    return Effect.gen(function* () {
      for (const output of ["", ".", "..", dirname(projectDir)]) {
        const exit = yield* dbSchemaDeclarativeGenerate(
          flags({ local: Option.some(true), outputDir: Option.some(output), overwrite: true }),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(failError(exit)).toMatchObject({
          _tag: "DeclarativeWriteError",
          message:
            "declarative output directory must not be empty, resolve to the project directory, or contain the project directory",
        });
        expect(readFileSync(sentinel, "utf8")).toBe("keep");
      }
      expect(s.localPostgresImageChecks).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("--output-dir leaves the configured declarative tree untouched", () => {
    const s = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeGenerate(
        flags({ local: Option.some(true), outputDir: Option.some("staged-schema") }),
      );
      expect(
        existsSync(join(tmp.current, "staged-schema", "public", "tables", "players.sql")),
      ).toBe(true);
      expect(existsSync(join(tmp.current, "supabase", "schemas"))).toBe(false);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("explicit --local checks the local Postgres image before generating", () => {
    const s = setup(tmp.current, { experimental: true, staleLocalImage: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        dbSchemaDeclarativeGenerate(flags({ local: Option.some(true) })),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failError(exit)).toMatchObject({
        _tag: "DeclarativeShadowDbError",
        message: "local Postgres container image is stale",
      });
      expect(s.localPostgresImageChecks).toHaveLength(1);
      expect(s.ensureStartedCalls).toBe(0);
      expect(s.engineExportCalls).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("honors --yes to overwrite existing declarative files without prompting", () => {
    // Pre-seeds the declarative dir so the overwrite branch is reached. No
    // `promptConfirmResponses` are queued, so reaching the prompt would error — success proves
    // `--yes` bypassed it.
    mkdirSync(join(tmp.current, "supabase", "schemas"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "schemas", "existing.sql"), "create table x ();");
    const s = setup(tmp.current, { experimental: true, yes: true });
    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeGenerate(flags({ local: Option.some(true) }));
      const written = yield* Effect.promise(async () =>
        (await import("node:fs")).readFileSync(
          join(tmp.current, "supabase", "schemas", "public", "tables", "players.sql"),
          "utf8",
        ),
      );
      expect(written).toBe("create table players ();");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("aborts (does not overwrite) when the declarative dir cannot be read", () => {
    // Seeding `supabase/schemas` as a file makes `readDirectory` fail with ENOTDIR.
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "schemas"), "not a directory");
    const s = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        dbSchemaDeclarativeGenerate(flags({ local: Option.some(true) })),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(readFileSync(join(tmp.current, "supabase", "schemas"), "utf8")).toBe(
        "not a directory",
      );
      expect(s.out.rawChunks.some((c) => c.text.includes("Declarative schema written to"))).toBe(
        false,
      );
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("explicit --db-url: resolves the remote URL via the resolver", () => {
    const s = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeGenerate(flags({ dbUrl: Option.some("postgres://remote/db") }));
      expect(s.resolverCalls.length).toBe(1);
      expect(s.engineExportCalls[0]!.targetRef).toContain("@db.remote:5432");
      expect(s.ensureStartedCalls).toBe(0);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("writes to an absolute declarative_schema_path as-is (no workdir prefix)", () => {
    const absSchema = mkdtempSync(join(tmpdir(), "decl-abs-"));
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(
      join(tmp.current, "supabase", "config.toml"),
      [
        "[experimental.pgdelta]",
        "enabled = true",
        `declarative_schema_path = "${absSchema}"`,
        "",
      ].join("\n"),
    );
    const s = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeGenerate(flags({ local: Option.some(true) }));
      expect(existsSync(join(absSchema, "public", "tables", "players.sql"))).toBe(true);
      expect(readFileSync(join(absSchema, "public", "tables", "players.sql"), "utf8")).toBe(
        "create table players ();",
      );
      expect(
        s.out.rawChunks.map((c) => ({ text: stripAnsi(c.text), stream: c.stream })),
      ).toContainEqual({
        text: `Declarative schema written to ${absSchema}\n`,
        stream: "stderr",
      });
      rmSync(absSchema, { recursive: true, force: true });
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("explicit --linked applies a matching [remotes.<ref>] schema-path override", () => {
    const ref = "abcdefghijklmnopqrst";
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(
      join(tmp.current, "supabase", "config.toml"),
      [
        'project_id = "base"',
        "[experimental.pgdelta]",
        "enabled = true",
        "[remotes.prod]",
        `project_id = "${ref}"`,
        "[remotes.prod.experimental.pgdelta]",
        'declarative_schema_path = "remote_schema"',
        "",
      ].join("\n"),
    );
    const s = setup(tmp.current, { experimental: true, projectId: Option.some(ref) });
    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeGenerate(flags({ linked: Option.some(true) }));
      const written = yield* Effect.promise(async () =>
        (await import("node:fs")).readFileSync(
          join(tmp.current, "supabase", "remote_schema", "public", "tables", "players.sql"),
          "utf8",
        ),
      );
      expect(written).toBe("create table players ();");
      expect(s.engineExportCalls[0]!.projectRef).toBe(ref);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("--linked=false is an explicit linked target (Go gates on flag.Changed)", () => {
    // Non-interactive (no TTY, no --yes), so a smart-mode fall-through would fail with "specify
    // a target" instead.
    const s = setup(tmp.current, { experimental: true, stdinIsTty: false });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        dbSchemaDeclarativeGenerate(flags({ linked: Option.some(false) })),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(s.resolverCalls).toContainEqual(expect.objectContaining({ connType: "linked" }));
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("caches the linked project after generate --linked (Go PersistentPostRun)", () => {
    const ref = "abcdefghijklmnopqrst";
    const s = setup(tmp.current, { experimental: true, projectId: Option.some(ref) });
    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeGenerate(flags({ linked: Option.some(true) }));
      expect(s.cache.cached).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("--local=false selects the local target but does NOT auto-start the stack", () => {
    const s = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeGenerate(flags({ local: Option.some(false) }));
      expect(s.engineExportCalls).toHaveLength(1);
      expect(s.ensureStartedCalls).toBe(0);
      expect(s.localPostgresImageChecks).toHaveLength(1);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "explicit --linked gates pg-delta on base config, not a remote enabled override",
    () => {
      const ref = "abcdefghijklmnopqrst";
      mkdirSync(join(tmp.current, "supabase"), { recursive: true });
      writeFileSync(
        join(tmp.current, "supabase", "config.toml"),
        [
          'project_id = "base"',
          "[remotes.prod]",
          `project_id = "${ref}"`,
          "[remotes.prod.experimental.pgdelta]",
          "enabled = true",
          "",
        ].join("\n"),
      );
      const s = setup(tmp.current, { experimental: false, projectId: Option.some(ref) });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          dbSchemaDeclarativeGenerate(flags({ linked: Option.some(true) })),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(failError(exit)?.constructor.name).toBe("DeclarativeNotEnabledError");
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("smart mode: non-TTY without --yes fails with the target hint", () => {
    const s = setup(tmp.current, { experimental: true, stdinIsTty: false, yes: false });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(dbSchemaDeclarativeGenerate(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      expect((failError(exit) as { message: string }).message).toContain(
        "in non-interactive mode, specify a target",
      );
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("smart mode: existing files + decline regenerate → skips", () => {
    const declDir = join(tmp.current, "supabase", "schemas");
    mkdirSync(declDir, { recursive: true });
    writeFileSync(join(declDir, "existing.sql"), "-- existing");
    const s = setup(tmp.current, {
      experimental: true,
      stdinIsTty: true,
      promptConfirmResponses: [false],
    });
    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeGenerate(flags());
      expect(s.engineExportCalls).toEqual([]);
      expect(
        s.out.rawChunks.some((c) => c.text.includes("Skipped generating declarative schema")),
      ).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("smart mode: --yes regenerates over existing files without prompting", () => {
    // No migrations, so the smart target resolves to local without a further prompt. No
    // `promptConfirmResponses` are queued, so a prompt would throw.
    const declDir = join(tmp.current, "supabase", "schemas");
    mkdirSync(declDir, { recursive: true });
    writeFileSync(join(declDir, "existing.sql"), "-- existing");
    const s = setup(tmp.current, { experimental: true, stdinIsTty: false, yes: true });
    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeGenerate(flags());
      expect(s.engineExportCalls).toHaveLength(1);
      expect(stripAnsi(s.out.stderrText)).toContain(
        `Declarative schema already exists at ${join("supabase", "schemas")}. Regenerate from database? This will overwrite existing files. [y/N] y\n`,
      );
      expect(
        s.out.rawChunks.some((c) => c.text.includes("Skipped generating declarative schema")),
      ).toBe(false);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("smart mode: SUPABASE_YES=1 regenerates over existing files like --yes", () => {
    const declDir = join(tmp.current, "supabase", "schemas");
    mkdirSync(declDir, { recursive: true });
    writeFileSync(join(declDir, "existing.sql"), "-- existing");
    const prev = process.env["SUPABASE_YES"];
    process.env["SUPABASE_YES"] = "1";
    const s = setup(tmp.current, { experimental: true, stdinIsTty: false, yes: false });
    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeGenerate(flags());
      expect(s.engineExportCalls).toHaveLength(1);
      expect(stripAnsi(s.out.stderrText)).toContain(
        `Declarative schema already exists at ${join("supabase", "schemas")}. Regenerate from database? This will overwrite existing files. [y/N] y\n`,
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (prev === undefined) delete process.env["SUPABASE_YES"];
          else process.env["SUPABASE_YES"] = prev;
        }),
      ),
      Effect.provide(s.layer),
    );
  });

  it.effect("passes --strict-coverage through to the engine export", () => {
    const s = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeGenerate(
        flags({ local: Option.some(true), noCache: true, strictCoverage: true }),
      );
      expect(s.engineExportCalls).toEqual([expect.objectContaining({ strictCoverage: true })]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("fails generate when the engine export fails", () => {
    const s = setup(tmp.current, { experimental: true, exportFails: true });
    return Effect.gen(function* () {
      const exit = yield* dbSchemaDeclarativeGenerate(flags({ local: Option.some(true) })).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failError(exit)).toMatchObject({
        _tag: "PgDeltaEngineError",
        message: "declarative export failed",
      });
      expect(s.out.rawChunks.some((c) => c.text.includes("Declarative schema written to"))).toBe(
        false,
      );
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("smart mode: propagates a reset failure instead of exiting the process", () => {
    mkdirSync(join(tmp.current, "supabase", "migrations"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "migrations", "0001_init.sql"), "select 1;");
    const s = setup(tmp.current, {
      experimental: true,
      stdinIsTty: true,
      promptSelectResponses: ["local"],
      resetShouldFail: true,
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(dbSchemaDeclarativeGenerate(flags({ reset: true })));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failError(exit)).toMatchObject({
        message: "database reset failed: supabase start is not running.",
      });
      expect(localResetRemovedContainers(s.child.spawned)).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("smart mode: offers and resolves the linked project when the workdir is linked", () => {
    // A valid 20-char ref is required for the linked choice to show.
    mkdirSync(join(tmp.current, "supabase", "migrations"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "migrations", "0001_init.sql"), "select 1;");
    const s = setup(tmp.current, {
      experimental: true,
      stdinIsTty: true,
      projectId: Option.some("abcdefghijklmnopqrst"),
      promptSelectResponses: ["linked"],
    });
    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeGenerate(flags());
      const options = s.out.promptSelectCalls[0]?.options ?? [];
      expect(options.map((o) => o.value)).toEqual(["local", "linked", "custom"]);
      expect(s.resolverCalls).toContainEqual(expect.objectContaining({ connType: "linked" }));
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("smart mode: local target checks the local Postgres image before generating", () => {
    mkdirSync(join(tmp.current, "supabase", "migrations"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "migrations", "0001_init.sql"), "select 1;");
    const s = setup(tmp.current, {
      experimental: true,
      stdinIsTty: true,
      staleLocalImage: true,
      promptSelectResponses: ["local"],
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(dbSchemaDeclarativeGenerate(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failError(exit)).toMatchObject({
        _tag: "DeclarativeShadowDbError",
        message: "local Postgres container image is stale",
      });
      expect(s.localPostgresImageChecks).toHaveLength(1);
      expect(s.engineExportCalls).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "smart mode: caches the linked project even when the user picks local (Go PostRun)",
    () => {
      mkdirSync(join(tmp.current, "supabase", "migrations"), { recursive: true });
      writeFileSync(join(tmp.current, "supabase", "migrations", "0001_init.sql"), "select 1;");
      const s = setup(tmp.current, {
        experimental: true,
        stdinIsTty: true,
        yes: true,
        projectId: Option.some("abcdefghijklmnopqrst"),
        promptSelectResponses: ["local"],
      });
      return Effect.gen(function* () {
        yield* dbSchemaDeclarativeGenerate(flags());
        expect(s.cache.cached).toBe(true);
        // The in-process local reset's own body never touches the linked-project cache or
        // telemetry, so the outer command's single `Effect.ensuring` finalizer must still fire
        // exactly once each, not twice.
        expect(s.cache.cacheCount).toBe(1);
        expect(s.telemetry.flushCount).toBe(1);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("smart mode: does not cache when no migrations exist (Go skips LoadProjectRef)", () => {
    const s = setup(tmp.current, {
      experimental: true,
      yes: true,
      projectId: Option.some("abcdefghijklmnopqrst"),
    });
    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeGenerate(flags());
      expect(s.cache.cached).toBe(false);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("smart mode: hides the linked choice when the workdir is not linked", () => {
    mkdirSync(join(tmp.current, "supabase", "migrations"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "migrations", "0001_init.sql"), "select 1;");
    const s = setup(tmp.current, {
      experimental: true,
      stdinIsTty: true,
      projectId: Option.none(),
      promptSelectResponses: ["local"],
    });
    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeGenerate(flags());
      const options = s.out.promptSelectCalls[0]?.options ?? [];
      expect(options.map((o) => o.value)).toEqual(["local", "custom"]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("smart mode: an unreadable migrations path is treated as no migrations", () => {
    // Seeding `supabase/migrations` as a file makes the list fail with ENOTDIR.
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "migrations"), "not a directory");
    const s = setup(tmp.current, { experimental: true, yes: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(dbSchemaDeclarativeGenerate(flags()));
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(s.ensureStartedCalls).toBe(1);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("smart mode: an unreadable ref file just omits the linked choice", () => {
    // Seeding `.temp/project-ref` as a directory makes the read fail.
    mkdirSync(join(tmp.current, "supabase", "migrations"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "migrations", "0001_init.sql"), "select 1;");
    mkdirSync(join(tmp.current, "supabase", ".temp", "project-ref"), { recursive: true });
    const s = setup(tmp.current, {
      experimental: true,
      stdinIsTty: true,
      yes: true,
      projectId: Option.none(),
      promptSelectResponses: ["local"],
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(dbSchemaDeclarativeGenerate(flags()));
      expect(Exit.isSuccess(exit)).toBe(true);
      expect((s.out.promptSelectCalls[0]?.options ?? []).map((o) => o.value)).toEqual([
        "local",
        "custom",
      ]);
      expect(s.cache.cached).toBe(false);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("smart mode: --yes auto-resets the local database without prompting", () => {
    // No `promptConfirmResponses` are supplied, so a prompt would throw.
    mkdirSync(join(tmp.current, "supabase", "migrations"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "migrations", "0001_init.sql"), "select 1;");
    // `resetLocalDatabase`'s container-recreate resolves its own project id from
    // `@supabase/config`, independently of the mocked `CommandSettings.projectId` — pin it to
    // "test" so the recreated container name matches the spawner route's assumption.
    writeFileSync(join(tmp.current, "supabase", "config.toml"), 'project_id = "test"\n');
    const s = setup(tmp.current, {
      experimental: true,
      stdinIsTty: true,
      yes: true,
      promptSelectResponses: ["local"],
    });
    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeGenerate(flags());
      expect(localResetRemovedContainers(s.child.spawned)).toContain("supabase_db_test");
      expect(localResetCreateArgs(s.child.spawned)).not.toBeUndefined();
      expect(s.out.rawChunks.some((c) => c.text.includes("Resetting local database"))).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("smart mode: forwards --network-id to the local reset", () => {
    mkdirSync(join(tmp.current, "supabase", "migrations"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "migrations", "0001_init.sql"), "select 1;");
    writeFileSync(join(tmp.current, "supabase", "config.toml"), 'project_id = "test"\n');
    const s = setup(tmp.current, {
      experimental: true,
      stdinIsTty: true,
      yes: true,
      networkId: Option.some("my-net"),
      promptSelectResponses: ["local"],
    });
    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeGenerate(flags());
      const createArgs = localResetCreateArgs(s.child.spawned);
      const networkIndex = createArgs?.indexOf("--network") ?? -1;
      expect(networkIndex).toBeGreaterThanOrEqual(0);
      expect(createArgs?.[networkIndex + 1]).toBe("my-net");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("smart mode: rejects a malformed custom database URL", () => {
    mkdirSync(join(tmp.current, "supabase", "migrations"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "migrations", "0001_init.sql"), "select 1;");
    const s = setup(tmp.current, {
      experimental: true,
      stdinIsTty: true,
      promptSelectResponses: ["custom"],
      promptTextResponses: ["not a url"],
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(dbSchemaDeclarativeGenerate(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failError(exit)).toMatchObject({
        _tag: "DeclarativeInvalidDbUrlError",
        message: "failed to parse connection string: not a url",
      });
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("smart mode: normalizes a valid custom database URL before pg-delta", () => {
    mkdirSync(join(tmp.current, "supabase", "migrations"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "migrations", "0001_init.sql"), "select 1;");
    const s = setup(tmp.current, {
      experimental: true,
      stdinIsTty: true,
      promptSelectResponses: ["custom"],
      promptTextResponses: ["postgres://user:secret@db.example.com:5432/app"],
    });
    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeGenerate(flags());
      expect(s.engineExportCalls[0]!.targetRef).toContain(
        "@db.example.com:5432/app?connect_timeout=",
      );
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("writes the engine's export manifest alongside the declarative tree", () => {
    const s = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeGenerate(flags({ local: Option.some(true) }));
      const manifest = JSON.parse(
        readFileSync(join(tmp.current, "supabase", "schemas", ".pgdelta-export.json"), "utf8"),
      );
      expect(manifest).toMatchObject({
        formatVersion: 1,
        redactSecrets: true,
        scope: "database",
        files: ["public/tables/players.sql"],
      });
    }).pipe(Effect.provide(s.layer));
  });
});
