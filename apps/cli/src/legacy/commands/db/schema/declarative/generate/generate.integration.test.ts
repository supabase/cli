import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { stripAnsi } from "../../../../../../../tests/helpers/ansi.ts";

import {
  alwaysReadyHttpClientLayer,
  defaultLocalResetRoute,
  legacyLocalResetCreateArgs,
  legacyLocalResetRemovedContainers,
  mockContainerCliSpawner,
} from "../../../../../../../tests/helpers/legacy-local-reset.ts";
import {
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
  mockStdin,
  mockTty,
} from "../../../../../../../tests/helpers/mocks.ts";
import {
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApiService,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../../../tests/helpers/legacy-mocks.ts";
import { CliArgs } from "../../../../../../shared/cli/cli-args.service.ts";
import {
  LegacyDebugFlag,
  LegacyDnsResolverFlag,
  LegacyExperimentalFlag,
  LegacyNetworkIdFlag,
  LegacyYesFlag,
} from "../../../../../../shared/legacy/global-flags.ts";
import { LegacyGoProxy } from "../../../../../../shared/legacy/go-proxy.service.ts";
import { LegacyPlatformApi } from "../../../../../auth/legacy-platform-api.service.ts";
import { LegacyPlatformApiFactory } from "../../../../../auth/legacy-platform-api-factory.service.ts";
import { legacyDockerRunLayer } from "../../../../../shared/legacy-docker-run.layer.ts";
import { LegacyDbConfigResolver } from "../../../../../shared/legacy-db-config.service.ts";
import { LegacyDbConnection } from "../../../../../shared/legacy-db-connection.service.ts";
import {
  type LegacyEdgeRuntimeRunOpts,
  LegacyEdgeRuntimeScript,
} from "../../../../../shared/legacy-edge-runtime-script.service.ts";
import { LegacyPgDeltaSslProbe } from "../../../../../shared/legacy-pgdelta-ssl-probe.service.ts";
import { legacyPgDeltaLegacyEngineLayer } from "../../../shared/legacy-pgdelta-engine.legacy.layer.ts";
import { LegacyPgDeltaEngine } from "../../../shared/legacy-pgdelta-engine.service.ts";
import { LegacyDeclarativeShadowDbError } from "../../../shared/legacy-pgdelta.errors.ts";
import {
  type LegacyCatalogMode,
  LegacyDeclarativeSeam,
} from "../../../shared/legacy-pgdelta.seam.service.ts";
import type { LegacyDbSchemaDeclarativeGenerateFlags } from "./generate.command.ts";
import { legacyDbSchemaDeclarativeGenerate } from "./generate.handler.ts";

const EXPORT_JSON = JSON.stringify({
  version: 1,
  mode: "declarative",
  files: [
    {
      path: "schemas/public/tables/players.sql",
      order: 0,
      statements: 1,
      sql: "create table players ();",
    },
  ],
});

interface SetupOpts {
  experimental?: boolean;
  args?: ReadonlyArray<string>;
  yes?: boolean;
  stdinIsTty?: boolean;
  promptConfirmResponses?: ReadonlyArray<boolean>;
  promptSelectResponses?: ReadonlyArray<string>;
  promptTextResponses?: ReadonlyArray<string>;
  exportJson?: string;
  /**
   * Makes the local-reset prompt's `legacyResetLocalDatabase` fail immediately
   * with `LegacyResetLocalDbNotRunningError` (the local `db` container reports as
   * not running) instead of completing a real recreate.
   */
  resetShouldFail?: boolean;
  networkId?: Option.Option<string>;
  projectId?: Option.Option<string>;
  exportFailsForMode?: LegacyCatalogMode;
  staleLocalImage?: boolean;
  engineImplementation?: "legacy" | "next";
}

function setup(workdir: string, opts: SetupOpts = {}) {
  const out = mockOutput({
    promptConfirmResponses: opts.promptConfirmResponses,
    promptSelectResponses: opts.promptSelectResponses,
    promptTextResponses: opts.promptTextResponses,
  });
  const telemetry = mockLegacyTelemetryStateTracked();
  const cache = mockLegacyLinkedProjectCacheTracked();
  const seamCalls: LegacyCatalogMode[] = [];
  const seamExportCalls: Array<{ mode: LegacyCatalogMode; projectRef?: string }> = [];
  const localPostgresImageChecks: Array<true> = [];
  let ensureStartedCalls = 0;
  const platformApi = mockLegacyPlatformApiService({});
  // Backs `legacyResetLocalDatabase`'s real, native container-recreate — reached
  // when the smart-target local-reset prompt is confirmed (CLI-2062: it now runs
  // in-process instead of shelling out to a second `supabase-go` child).
  const child = mockContainerCliSpawner(
    defaultLocalResetRoute("test", { running: opts.resetShouldFail !== true }),
  );
  const dbExec: string[] = [];
  const dbConn = Layer.succeed(LegacyDbConnection, {
    connect: () =>
      Effect.succeed({
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
      }),
  });
  const seam = Layer.succeed(LegacyDeclarativeSeam, {
    exportCatalog: ({ mode, projectRef }) => {
      seamCalls.push(mode);
      seamExportCalls.push({ mode, projectRef });
      return opts.exportFailsForMode === mode
        ? Effect.fail(new LegacyDeclarativeShadowDbError({ message: `export failed for ${mode}` }))
        : Effect.succeed("supabase/.temp/pgdelta/base.json");
    },
    ensureLocalDatabaseStarted: () =>
      Effect.sync(() => {
        ensureStartedCalls += 1;
      }),
    ensureLocalPostgresImageCurrent: () =>
      Effect.sync(() => {
        localPostgresImageChecks.push(true);
      }).pipe(
        Effect.flatMap(() =>
          opts.staleLocalImage === true
            ? Effect.fail(
                new LegacyDeclarativeShadowDbError({
                  message: "local Postgres container image is stale",
                }),
              )
            : Effect.void,
        ),
      ),
  });
  const edgeCalls: LegacyEdgeRuntimeRunOpts[] = [];
  const edge = Layer.succeed(LegacyEdgeRuntimeScript, {
    run: (runOpts: LegacyEdgeRuntimeRunOpts) => {
      edgeCalls.push(runOpts);
      return Effect.succeed({ stdout: opts.exportJson ?? EXPORT_JSON, stderr: "" });
    },
  });
  const resolverCalls: unknown[] = [];
  const resolver = Layer.succeed(LegacyDbConfigResolver, {
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
  const proxy = Layer.succeed(LegacyGoProxy, {
    exec: (args) => Effect.sync(() => void proxyCalls.push(args)),
    execCapture: () => Effect.succeed(""),
  });
  const sslProbe = Layer.succeed(LegacyPgDeltaSslProbe, {
    requireSsl: () => Effect.succeed(false),
    requireSslForHost: () => Effect.succeed(false),
  });
  const runtimeInfo = mockRuntimeInfo({ platform: "linux" });
  const processControl = mockProcessControl();
  const experimentalFlag = Layer.succeed(LegacyExperimentalFlag, opts.experimental ?? true);
  const cliArgs = Layer.succeed(CliArgs, {
    args: opts.args ?? ["db", "schema", "declarative", "generate"],
  });
  const networkIdFlag = Layer.succeed(LegacyNetworkIdFlag, opts.networkId ?? Option.none());
  const debugFlag = Layer.succeed(LegacyDebugFlag, false);
  const dockerRun = legacyDockerRunLayer.pipe(
    Layer.provide(child.layer),
    Layer.provide(processControl.layer),
  );
  const engineRuntime = Layer.mergeAll(
    seam,
    edge,
    sslProbe,
    out.layer,
    dbConn,
    runtimeInfo,
    experimentalFlag,
    cliArgs,
    networkIdFlag,
    debugFlag,
    processControl.layer,
    alwaysReadyHttpClientLayer,
    dockerRun,
    BunServices.layer,
    child.layer,
  );
  const engine =
    opts.engineImplementation === "next"
      ? Layer.succeed(
          LegacyPgDeltaEngine,
          LegacyPgDeltaEngine.of({
            implementation: "next",
            diffExplicit: () => Effect.die("diffExplicit not used in generate tests"),
            diffDatabase: () => Effect.die("diffDatabase not used in generate tests"),
            planDeclarativeSchema: () =>
              Effect.die("planDeclarativeSchema not used in generate tests"),
            exportDeclarativeSchema: () =>
              Effect.succeed({
                files: [
                  { name: "schemas/public/tables/players.sql", sql: "create table players ();" },
                ],
                manifest: { redactSecrets: true, scope: "database", profile: "supabase" },
              }),
          }),
        )
      : legacyPgDeltaLegacyEngineLayer.pipe(Layer.provide(engineRuntime));
  const layer = Layer.mergeAll(
    out.layer,
    telemetry.layer,
    cache.layer,
    seam,
    edge,
    engine,
    resolver,
    proxy,
    dbConn,
    mockLegacyCliConfig({ workdir, projectId: opts.projectId ?? Option.some("test") }),
    mockTty({ stdinIsTty: opts.stdinIsTty ?? false, stdoutIsTty: false }),
    mockStdin(opts.stdinIsTty ?? false),
    experimentalFlag,
    cliArgs,
    Layer.succeed(LegacyYesFlag, opts.yes ?? false),
    networkIdFlag,
    Layer.succeed(LegacyDnsResolverFlag, "native"),
    debugFlag,
    // The remote ref is a non-Supabase host that refuses TLS → no SSL env.
    sslProbe,
    // The local-reset bucket-seed core statically requires the (lazy) Management-API
    // factory; never invoked on the local reset (projectRef === "").
    Layer.succeed(LegacyPlatformApiFactory, {
      make: LegacyPlatformApi.pipe(Effect.provide(platformApi.layer)),
    }),
    BunServices.layer,
    // `child.layer` must be listed AFTER `BunServices.layer` — `Layer.mergeAll`
    // resolves a duplicate service tag to whichever layer is listed LAST, so this
    // mock overrides Bun's real `ChildProcessSpawner` instead of the reverse.
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
    seamCalls,
    seamExportCalls,
    edgeCalls,
    resolverCalls,
    proxyCalls,
    localPostgresImageChecks,
    get ensureStartedCalls() {
      return ensureStartedCalls;
    },
  };
}

const flags = (
  over: Partial<LegacyDbSchemaDeclarativeGenerateFlags> = {},
): LegacyDbSchemaDeclarativeGenerateFlags => ({
  noCache: over.noCache ?? false,
  strictCoverage: over.strictCoverage ?? false,
  overwrite: over.overwrite ?? false,
  output: over.output ?? Option.none(),
  reset: over.reset ?? false,
  schema: over.schema ?? [],
  dbUrl: over.dbUrl ?? Option.none(),
  linked: over.linked ?? Option.none(),
  local: over.local ?? Option.none(),
  password: over.password ?? Option.none(),
});

const failError = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined;

describe("legacy db schema declarative generate integration", () => {
  const tmp = useLegacyTempWorkdir();

  it.effect("gate: fails when neither --experimental nor config enables pg-delta", () => {
    const { layer } = setup(tmp.current, { experimental: false });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyDbSchemaDeclarativeGenerate(flags({ local: Option.some(true) })),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failError(exit)?.constructor.name).toBe("LegacyDeclarativeNotEnabledError");
    }).pipe(Effect.provide(layer));
  });

  it.effect("--local --linked with --experimental fails with the mutex error", () => {
    // Go's declarative PersistentPreRunE gate (db_schema_declarative.go:49-99) runs
    // BEFORE cobra's ValidateFlagGroups() mutex check (cobra@v1.10.2/command.go:985,
    // 1010), so the mutex error only surfaces once the gate is open.
    const { layer } = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyDbSchemaDeclarativeGenerate(
          flags({ local: Option.some(true), linked: Option.some(true) }),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failError(exit)).toMatchObject({
        _tag: "LegacyDeclarativeMutuallyExclusiveFlagsError",
        message:
          "if any flags in the group [db-url linked local] are set none of the others can be; [linked local] were all set",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "--local --linked without --experimental fails with the gate error, not the mutex error",
    () => {
      // Mirrors storage's experimental-gate-vs-mutex ordering fix (CLI-1855 / CLI-1876):
      // the pg-delta gate runs before the mutex check, so an unopened gate wins even
      // when the flags would also violate mutual exclusivity.
      const { layer } = setup(tmp.current, { experimental: false });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacyDbSchemaDeclarativeGenerate(
            flags({ local: Option.some(true), linked: Option.some(true) }),
          ),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(failError(exit)?.constructor.name).toBe("LegacyDeclarativeNotEnabledError");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "--local --linked with SUPABASE_EXPERIMENTAL env (no --experimental flag) fails with the mutex error",
    () => {
      // Go's gate reads viper.GetBool("EXPERIMENTAL") (db_schema_declarative.go:78),
      // which picks up SUPABASE_EXPERIMENTAL via viper.AutomaticEnv (root.go:318-334),
      // so an env-only experimental session still opens the gate and lets the mutex
      // check fire. legacyResolveExperimental (not the raw LegacyExperimentalFlag) is
      // what makes the TS gate honor the env var the same way.
      const { layer } = setup(tmp.current, { experimental: false });
      const ENV = "SUPABASE_EXPERIMENTAL";
      return Effect.gen(function* () {
        const saved = process.env[ENV];
        process.env[ENV] = "1";
        const exit = yield* Effect.exit(
          legacyDbSchemaDeclarativeGenerate(
            flags({ local: Option.some(true), linked: Option.some(true) }),
          ),
        );
        if (saved === undefined) delete process.env[ENV];
        else process.env[ENV] = saved;
        expect(Exit.isFailure(exit)).toBe(true);
        expect(failError(exit)).toMatchObject({
          _tag: "LegacyDeclarativeMutuallyExclusiveFlagsError",
          message:
            "if any flags in the group [db-url linked local] are set none of the others can be; [linked local] were all set",
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "an explicit --experimental=false closes the gate even when SUPABASE_EXPERIMENTAL is set",
    () => {
      // viper's bound-pflag lookup returns the flag value whenever Changed is true —
      // BEFORE falling back to AutomaticEnv (viper@v1.21.0/viper.go:1176-1178) — so an
      // explicit --experimental=false must win over SUPABASE_EXPERIMENTAL=1, closing the
      // gate instead of letting the env value override it.
      const { layer } = setup(tmp.current, {
        experimental: false,
        args: ["db", "schema", "declarative", "generate", "--experimental=false"],
      });
      const ENV = "SUPABASE_EXPERIMENTAL";
      return Effect.gen(function* () {
        const saved = process.env[ENV];
        process.env[ENV] = "1";
        const exit = yield* Effect.exit(
          legacyDbSchemaDeclarativeGenerate(flags({ local: Option.some(true) })),
        );
        if (saved === undefined) delete process.env[ENV];
        else process.env[ENV] = saved;
        expect(Exit.isFailure(exit)).toBe(true);
        expect(failError(exit)?.constructor.name).toBe("LegacyDeclarativeNotEnabledError");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "--local --linked with SUPABASE_EXPERIMENTAL set only in the project .env fails with the mutex error",
    () => {
      // Go's flags.LoadConfig runs loadNestedEnv (which os.Setenv's each project-.env key)
      // before dbDeclarativeCmd.PersistentPreRunE reads viper.GetBool("EXPERIMENTAL")
      // (apps/cli-go/cmd/db_schema_declarative.go:73-78, pkg/config/config.go:789), so a
      // SUPABASE_EXPERIMENTAL set only in supabase/.env opens the gate and lets the mutex
      // check fire, same as the shell-env case above.
      const saved = process.env["SUPABASE_EXPERIMENTAL"];
      delete process.env["SUPABASE_EXPERIMENTAL"];
      mkdirSync(join(tmp.current, "supabase"), { recursive: true });
      writeFileSync(join(tmp.current, "supabase", ".env"), "SUPABASE_EXPERIMENTAL=true\n");
      const { layer } = setup(tmp.current, { experimental: false });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacyDbSchemaDeclarativeGenerate(
            flags({ local: Option.some(true), linked: Option.some(true) }),
          ),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(failError(exit)).toMatchObject({
          _tag: "LegacyDeclarativeMutuallyExclusiveFlagsError",
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

  it.effect("explicit --local: provisions a raw shadow, exports, and writes files", () => {
    const s = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeGenerate(flags({ local: Option.some(true) }));
      // Only the optional legacy post-write warm remains seam-backed. The export
      // source is a workflow-owned native raw shadow.
      expect(s.seamCalls).toEqual(["declarative"]);
      expect(s.edgeCalls[0]!.env["SOURCE"]).toContain(
        "postgresql://postgres:postgres@127.0.0.1:54320",
      );
      expect(s.edgeCalls[0]!.env["TARGET"]).toContain(
        "postgresql://postgres:postgres@127.0.0.1:54322",
      );
      const written = yield* Effect.promise(async () =>
        (await import("node:fs")).readFileSync(
          join(tmp.current, "supabase", "database", "schemas", "public", "tables", "players.sql"),
          "utf8",
        ),
      );
      expect(written).toBe("create table players ();");
      // Go prints the relative `utils.GetDeclarativeDir()` verbatim
      // (`declarative.go:156`) — never the resolved absolute dir.
      expect(
        s.out.rawChunks.map((c) => ({ text: stripAnsi(c.text), stream: c.stream })),
      ).toContainEqual({
        text: `Declarative schema written to ${join("supabase", "database")}\n`,
        stream: "stderr",
      });
      expect(s.out.rawChunks.some((c) => c.text.includes(tmp.current))).toBe(false);
      // Go runs ensureLocalDatabaseStarted before generating from local.
      expect(s.ensureStartedCalls).toBe(1);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "--output writes a complete next export relative to the project without activating it",
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
      const s = setup(tmp.current, { experimental: true, engineImplementation: "next" });
      return Effect.gen(function* () {
        yield* legacyDbSchemaDeclarativeGenerate(
          flags({ local: Option.some(true), output: Option.some(destination) }),
        );

        expect(
          readFileSync(
            join(tmp.current, destination, "schemas", "public", "tables", "players.sql"),
            "utf8",
          ),
        ).toBe("create table players ();");
        expect(
          JSON.parse(readFileSync(join(tmp.current, destination, ".pgdelta-export.json"), "utf8")),
        ).toMatchObject({
          formatVersion: 1,
          profile: "supabase",
          files: ["schemas/public/tables/players.sql"],
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

  it.effect("--output protects a non-empty destination without --overwrite", () => {
    const destination = join(tmp.current, "staged-schema");
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, "keep.sql"), "select 'keep';");
    const s = setup(tmp.current, {
      experimental: true,
      engineImplementation: "next",
      promptConfirmResponses: [false],
    });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeGenerate(
        flags({ local: Option.some(true), output: Option.some(destination) }),
      );
      expect(readFileSync(join(destination, "keep.sql"), "utf8")).toBe("select 'keep';");
      expect(existsSync(join(destination, ".pgdelta-export.json"))).toBe(false);
      expect(s.out.rawChunks.some((chunk) => chunk.text.includes("Skipped writing"))).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("rejects output paths that could overwrite the project directory", () => {
    const sentinel = join(tmp.current, "project-sentinel.txt");
    writeFileSync(sentinel, "keep");
    const s = setup(tmp.current, { experimental: true, engineImplementation: "next" });
    return Effect.gen(function* () {
      for (const output of ["", "."]) {
        const exit = yield* legacyDbSchemaDeclarativeGenerate(
          flags({ local: Option.some(true), output: Option.some(output), overwrite: true }),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(failError(exit)).toMatchObject({
          _tag: "LegacyDeclarativeWriteError",
          message:
            "declarative output directory must not be empty or resolve to the project directory",
        });
        expect(readFileSync(sentinel, "utf8")).toBe("keep");
      }
      expect(s.localPostgresImageChecks).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("--output does not warm the configured legacy declarative tree", () => {
    const s = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeGenerate(
        flags({ local: Option.some(true), output: Option.some("staged-schema") }),
      );
      expect(s.seamCalls).toEqual([]);
      expect(
        existsSync(
          join(tmp.current, "staged-schema", "schemas", "public", "tables", "players.sql"),
        ),
      ).toBe(true);
      expect(existsSync(join(tmp.current, "supabase", "database"))).toBe(false);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("--overwrite replaces only the absolute --output destination", () => {
    const destination = mkdtempSync(join(tmpdir(), "legacy-decl-output-"));
    mkdirSync(join(tmp.current, "supabase", "database"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "database", "configured.sql"), "select 1;");
    writeFileSync(join(destination, "stale.sql"), "select 'stale';");
    const s = setup(tmp.current, { experimental: true, engineImplementation: "next" });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeGenerate(
        flags({
          local: Option.some(true),
          output: Option.some(destination),
          overwrite: true,
        }),
      );
      expect(existsSync(join(destination, "stale.sql"))).toBe(false);
      expect(existsSync(join(destination, ".pgdelta-export.json"))).toBe(true);
      expect(
        readFileSync(join(tmp.current, "supabase", "database", "configured.sql"), "utf8"),
      ).toBe("select 1;");
      expect(
        s.out.rawChunks.map((chunk) => ({ text: stripAnsi(chunk.text), stream: chunk.stream })),
      ).toContainEqual({
        text: `Declarative schema written to ${destination}\n`,
        stream: "stderr",
      });
      rmSync(destination, { recursive: true, force: true });
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("explicit --local checks the local Postgres image before generating", () => {
    const s = setup(tmp.current, { experimental: true, staleLocalImage: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyDbSchemaDeclarativeGenerate(flags({ local: Option.some(true) })),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failError(exit)).toMatchObject({
        _tag: "LegacyDeclarativeShadowDbError",
        message: "local Postgres container image is stale",
      });
      expect(s.localPostgresImageChecks).toHaveLength(1);
      expect(s.ensureStartedCalls).toBe(0);
      expect(s.edgeCalls).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("honors --yes to overwrite existing declarative files without prompting", () => {
    // Pre-seed the declarative dir so the overwrite branch is reached. With --yes,
    // Go's confirmOverwrite returns true immediately (Console.PromptYesNo); the
    // handler must skip the prompt and overwrite. No promptConfirmResponses are
    // queued, so reaching the prompt would error — success proves --yes bypassed it.
    mkdirSync(join(tmp.current, "supabase", "database"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "database", "existing.sql"), "create table x ();");
    const s = setup(tmp.current, { experimental: true, yes: true });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeGenerate(flags({ local: Option.some(true) }));
      const written = yield* Effect.promise(async () =>
        (await import("node:fs")).readFileSync(
          join(tmp.current, "supabase", "database", "schemas", "public", "tables", "players.sql"),
          "utf8",
        ),
      );
      expect(written).toBe("create table players ();");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("aborts (does not overwrite) when the declarative dir cannot be read", () => {
    // Go's confirmOverwrite returns the ReadDir error and Generate aborts on it
    // (declarative.go:123-127, 226-229), rather than treating an unreadable existing
    // dir as empty and letting WriteDeclarativeSchemas wipe/recreate the path.
    // Seeding supabase/database as a FILE makes readDirectory fail with ENOTDIR (a
    // non-NotFound PlatformError), so the command must fail without writing.
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "database"), "not a directory");
    const s = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyDbSchemaDeclarativeGenerate(flags({ local: Option.some(true) })),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      // The declarative path is untouched — still our seeded file, never wiped and
      // rewritten as a directory of schema files.
      expect(readFileSync(join(tmp.current, "supabase", "database"), "utf8")).toBe(
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
      yield* legacyDbSchemaDeclarativeGenerate(
        flags({ dbUrl: Option.some("postgres://remote/db") }),
      );
      expect(s.resolverCalls.length).toBe(1);
      expect(s.edgeCalls[0]!.env["TARGET"]).toContain("@db.remote:5432");
      // Remote target → the local stack is never started.
      expect(s.ensureStartedCalls).toBe(0);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("writes to an absolute declarative_schema_path as-is (no workdir prefix)", () => {
    // Go's config resolver leaves an absolute declarative_schema_path unchanged; path.join
    // would mangle /repo + /abs into /repo/abs.
    const absSchema = mkdtempSync(join(tmpdir(), "legacy-decl-abs-"));
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
      yield* legacyDbSchemaDeclarativeGenerate(flags({ local: Option.some(true) }));
      // File lands under the absolute path, NOT tmp.current/<absSchema>.
      expect(existsSync(join(absSchema, "schemas", "public", "tables", "players.sql"))).toBe(true);
      expect(
        readFileSync(join(absSchema, "schemas", "public", "tables", "players.sql"), "utf8"),
      ).toBe("create table players ();");
      // Go prints the configured value verbatim — absolute here, never workdir-prefixed.
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
    // Go re-loads config with the linked ref (root ParseDatabaseConfig), so a matching
    // [remotes.<ref>] block overrides experimental.pgdelta.declarative_schema_path —
    // the declarative files must land under the remote-overridden path.
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
      yield* legacyDbSchemaDeclarativeGenerate(flags({ linked: Option.some(true) }));
      const written = yield* Effect.promise(async () =>
        (await import("node:fs")).readFileSync(
          join(
            tmp.current,
            "supabase",
            "remote_schema",
            "schemas",
            "public",
            "tables",
            "players.sql",
          ),
          "utf8",
        ),
      );
      expect(written).toBe("create table players ();");
      // The post-write cache warm now RUNS and is threaded the resolved ref as
      // SUPABASE_PROJECT_ID, so the __catalog subprocess loads the [remotes.<ref>]-merged
      // config and resolves the remote-overridden declarative dir — matching Go's
      // in-process merged warm (declarative.go:138-154) rather than skipping.
      const declWarm = s.seamExportCalls.find((c) => c.mode === "declarative");
      expect(declWarm?.projectRef).toBe(ref);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("--linked=false is an explicit linked target (Go gates on flag.Changed)", () => {
    // pflag marks `--linked=false` as Changed, so Go takes the explicit linked path
    // rather than smart mode. Non-interactive (no TTY, no --yes) so a smart-mode
    // fall-through would fail with "specify a target" — assert it does NOT.
    const s = setup(tmp.current, { experimental: true, stdinIsTty: false });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyDbSchemaDeclarativeGenerate(flags({ linked: Option.some(false) })),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      // Took the explicit linked path: the resolver was called with connType "linked".
      expect(s.resolverCalls).toContainEqual(expect.objectContaining({ connType: "linked" }));
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("explicit --linked does not route the export source through the Go seam", () => {
    const ref = "abcdefghijklmnopqrst";
    const s = setup(tmp.current, { experimental: true, projectId: Option.some(ref) });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeGenerate(flags({ linked: Option.some(true) }));
      expect(s.seamExportCalls.some((call) => call.mode === "baseline")).toBe(false);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("explicit --local keeps raw-shadow export independent of linked state", () => {
    const s = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeGenerate(flags({ local: Option.some(true) }));
      expect(s.seamExportCalls.some((call) => call.mode === "baseline")).toBe(false);
      // No linked ref resolved → no linked-project cache write (Go gates on ProjectRef).
      expect(s.cache.cached).toBe(false);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("caches the linked project after generate --linked (Go PersistentPostRun)", () => {
    const ref = "abcdefghijklmnopqrst";
    const s = setup(tmp.current, { experimental: true, projectId: Option.some(ref) });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeGenerate(flags({ linked: Option.some(true) }));
      expect(s.cache.cached).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("--local=false selects the local target but does NOT auto-start the stack", () => {
    // Go selects local on flag.Changed but gates ensureLocalDatabaseStarted on the
    // bool value (declarativeLocal), so `--local=false` must not start a stopped stack.
    const s = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeGenerate(flags({ local: Option.some(false) }));
      // Took the explicit local target and completed the optional legacy warm ...
      expect(s.seamCalls).toContain("declarative");
      // ... but did NOT auto-start (value is false).
      expect(s.ensureStartedCalls).toBe(0);
      expect(s.localPostgresImageChecks).toHaveLength(1);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "explicit --linked gates pg-delta on base config, not a remote enabled override",
    () => {
      // Go gates pg-delta on the base LoadConfig (declarative PersistentPreRunE) before the
      // root ParseDatabaseConfig reloads the remote block, so a remote enabled=true must NOT
      // enable a base-disabled command without --experimental.
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
          legacyDbSchemaDeclarativeGenerate(flags({ linked: Option.some(true) })),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(failError(exit)?.constructor.name).toBe("LegacyDeclarativeNotEnabledError");
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("smart mode: non-TTY without --yes fails with the target hint", () => {
    const s = setup(tmp.current, { experimental: true, stdinIsTty: false, yes: false });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDbSchemaDeclarativeGenerate(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      expect((failError(exit) as { message: string }).message).toContain(
        "in non-interactive mode, specify a target",
      );
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("smart mode: existing files + decline regenerate → skips", () => {
    const declDir = join(tmp.current, "supabase", "database");
    mkdirSync(declDir, { recursive: true });
    writeFileSync(join(declDir, "existing.sql"), "-- existing");
    const s = setup(tmp.current, {
      experimental: true,
      stdinIsTty: true,
      promptConfirmResponses: [false],
    });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeGenerate(flags());
      expect(s.seamCalls).toEqual([]);
      expect(
        s.out.rawChunks.some((c) => c.text.includes("Skipped generating declarative schema")),
      ).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("smart mode: --yes regenerates over existing files without prompting", () => {
    // Go's overwrite question goes through Console.PromptYesNo, which auto-accepts
    // under --yes, so existing declarative files are regenerated (not skipped) and
    // no prompt is shown. No migrations → the smart target resolves to local without
    // a further prompt. No promptConfirmResponses are queued, so a prompt would throw.
    const declDir = join(tmp.current, "supabase", "database");
    mkdirSync(declDir, { recursive: true });
    writeFileSync(join(declDir, "existing.sql"), "-- existing");
    const s = setup(tmp.current, { experimental: true, stdinIsTty: false, yes: true });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeGenerate(flags());
      expect(s.seamCalls).toEqual(["declarative"]);
      // Go's PromptYesNo echoes the auto-accepted question to stderr under the
      // global YES flag (`console.go:70-72`) — the echo must not be skipped, and
      // the prompt renders the relative dir (`db_schema_declarative.go:268`).
      expect(stripAnsi(s.out.stderrText)).toContain(
        `Declarative schema already exists at ${join("supabase", "database")}. Regenerate from database? This will overwrite existing files. [y/N] y\n`,
      );
      expect(
        s.out.rawChunks.some((c) => c.text.includes("Skipped generating declarative schema")),
      ).toBe(false);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("smart mode: SUPABASE_YES=1 regenerates over existing files like --yes", () => {
    // Go reads `viper.GetBool("YES")`, which `AutomaticEnv` also binds to the
    // SUPABASE_YES env var — the flag alone is not the whole surface (CLI-1974).
    const declDir = join(tmp.current, "supabase", "database");
    mkdirSync(declDir, { recursive: true });
    writeFileSync(join(declDir, "existing.sql"), "-- existing");
    const prev = process.env["SUPABASE_YES"];
    process.env["SUPABASE_YES"] = "1";
    const s = setup(tmp.current, { experimental: true, stdinIsTty: false, yes: false });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeGenerate(flags());
      expect(s.seamCalls).toEqual(["declarative"]);
      expect(stripAnsi(s.out.stderrText)).toContain(
        `Declarative schema already exists at ${join("supabase", "database")}. Regenerate from database? This will overwrite existing files. [y/N] y\n`,
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

  it.effect("warms the declarative catalog cache after writing (skipped with --no-cache)", () => {
    const s = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeGenerate(flags({ local: Option.some(true), noCache: true }));
      // --no-cache skips the post-write warm; the raw source never uses the seam.
      expect(s.seamCalls).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("fails generate when the post-write catalog warm cannot apply to the shadow", () => {
    // Go returns the warm error from Generate (declarative.go:144-153), so a schema that
    // can't apply to the shadow DB fails generate rather than reporting success.
    const s = setup(tmp.current, { experimental: true, exportFailsForMode: "declarative" });
    return Effect.gen(function* () {
      const exit = yield* legacyDbSchemaDeclarativeGenerate(
        flags({ local: Option.some(true) }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(s.out.rawChunks.some((c) => c.text.includes("Declarative schema written to"))).toBe(
        false,
      );
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("smart mode: propagates a reset failure instead of exiting the process", () => {
    // Go runs reset in-process and returns the error; `legacyResetLocalDatabase` now
    // runs the same way (CLI-2062), so its real failure must fail the effect (so
    // telemetry flush / error handling run) rather than process.exit via LegacyGoProxy.
    mkdirSync(join(tmp.current, "supabase", "migrations"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "migrations", "0001_init.sql"), "select 1;");
    const s = setup(tmp.current, {
      experimental: true,
      stdinIsTty: true,
      promptSelectResponses: ["local"],
      resetShouldFail: true,
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDbSchemaDeclarativeGenerate(flags({ reset: true })));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failError(exit)).toMatchObject({
        message: "database reset failed: supabase start is not running.",
      });
      // Failed before any destructive container work.
      expect(legacyLocalResetRemovedContainers(s.child.spawned)).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("smart mode: offers and resolves the linked project when the workdir is linked", () => {
    // Go's runDeclarativeGenerate adds a "Linked project" choice when LoadProjectRef
    // succeeds; selecting it builds the URL via NewDbConfigWithPassword (the --linked
    // path). Use a valid 20-char ref so the choice is shown.
    mkdirSync(join(tmp.current, "supabase", "migrations"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "migrations", "0001_init.sql"), "select 1;");
    const s = setup(tmp.current, {
      experimental: true,
      stdinIsTty: true,
      projectId: Option.some("abcdefghijklmnopqrst"),
      promptSelectResponses: ["linked"],
    });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeGenerate(flags());
      // The prompt offered the linked choice, and selecting it routed through the
      // resolver's --linked branch.
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
      const exit = yield* Effect.exit(legacyDbSchemaDeclarativeGenerate(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failError(exit)).toMatchObject({
        _tag: "LegacyDeclarativeShadowDbError",
        message: "local Postgres container image is stale",
      });
      expect(s.localPostgresImageChecks).toHaveLength(1);
      expect(s.edgeCalls).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "smart mode: caches the linked project even when the user picks local (Go PostRun)",
    () => {
      // Go's runDeclarativeGenerate calls LoadProjectRef inside the hasMigrationFiles
      // branch to offer the linked choice, which sets the global flags.ProjectRef; root
      // ensureProjectGroupsCached then writes the linked-project cache regardless of
      // which target the user picks (cmd/root.go:176,214-218). So a linked workdir +
      // smart mode + "Local database" choice must still cache.
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
        yield* legacyDbSchemaDeclarativeGenerate(flags());
        expect(s.cache.cached).toBe(true);
        // This scenario also runs a real in-process local reset
        // (`legacyResetLocalDatabase`, CLI-2062) — its own body never touches the
        // linked-project cache or telemetry, so the outer command's single
        // `Effect.ensuring` finalizer must still fire EXACTLY once each, not
        // twice, matching Go's single-process `reset.Run` (no second
        // `PersistentPostRun` from a separate child process).
        expect(s.cache.cacheCount).toBe(1);
        expect(s.telemetry.flushCount).toBe(1);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("smart mode: does not cache when no migrations exist (Go skips LoadProjectRef)", () => {
    // With no migrations, Go never enters the hasMigrationFiles branch, so it never
    // calls LoadProjectRef and flags.ProjectRef stays empty — no cache, even though
    // the workdir has a project_id.
    const s = setup(tmp.current, {
      experimental: true,
      yes: true,
      projectId: Option.some("abcdefghijklmnopqrst"),
    });
    return Effect.gen(function* () {
      // No migrations dir → smart target resolves to local without offering linked
      // (--yes satisfies the non-interactive gate).
      yield* legacyDbSchemaDeclarativeGenerate(flags());
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
      yield* legacyDbSchemaDeclarativeGenerate(flags());
      const options = s.out.promptSelectCalls[0]?.options ?? [];
      expect(options.map((o) => o.value)).toEqual(["local", "custom"]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("smart mode: an unreadable migrations path is treated as no migrations", () => {
    // Go's cmd.hasMigrationFiles returns false on ANY ListLocalMigrations error
    // (db_schema_declarative.go:164-169), flowing into the no-migrations local generate.
    // Seeding supabase/migrations as a FILE makes the list fail with ENOTDIR — the smart
    // probe must swallow it and proceed, not abort.
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "migrations"), "not a directory");
    const s = setup(tmp.current, { experimental: true, yes: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDbSchemaDeclarativeGenerate(flags()));
      expect(Exit.isSuccess(exit)).toBe(true);
      // No migrations → local generate path started the stack (not aborted on the read).
      expect(s.ensureStartedCalls).toBe(1);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("smart mode: an unreadable ref file just omits the linked choice", () => {
    // Go guards the smart-prompt LoadProjectRef with `if err == nil`
    // (db_schema_declarative.go:222-224): a broken .temp/project-ref omits the linked
    // choice and local/custom generation proceeds. Seeding project-ref as a DIRECTORY
    // makes the read fail; the smart read must swallow it, not abort.
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
      const exit = yield* Effect.exit(legacyDbSchemaDeclarativeGenerate(flags()));
      expect(Exit.isSuccess(exit)).toBe(true);
      // Linked choice omitted (ref unreadable), and nothing cached as linked.
      expect((s.out.promptSelectCalls[0]?.options ?? []).map((o) => o.value)).toEqual([
        "local",
        "custom",
      ]);
      expect(s.cache.cached).toBe(false);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("smart mode: --yes auto-resets the local database without prompting", () => {
    // Go's Console.PromptYesNo auto-returns true under the global --yes flag, so the
    // "Reset local database to match migrations first?" prompt must be skipped and the
    // reset must run. No promptConfirmResponses are supplied, so a prompt would throw.
    mkdirSync(join(tmp.current, "supabase", "migrations"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "migrations", "0001_init.sql"), "select 1;");
    // `legacyResetLocalDatabase`'s container-recreate resolves its own project id from
    // `@supabase/config` (config.toml / real env), independently of the mocked
    // `LegacyCliConfig.projectId` — pin it to "test" so the recreated container name
    // matches the spawner route's assumption.
    writeFileSync(join(tmp.current, "supabase", "config.toml"), 'project_id = "test"\n');
    const s = setup(tmp.current, {
      experimental: true,
      stdinIsTty: true,
      yes: true,
      promptSelectResponses: ["local"],
    });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeGenerate(flags());
      // The reset actually ran — recreated the local `db` container in-process
      // (CLI-2062: no `supabase-go` child) — proving it's a real effect.
      expect(legacyLocalResetRemovedContainers(s.child.spawned)).toContain("supabase_db_test");
      expect(legacyLocalResetCreateArgs(s.child.spawned)).not.toBeUndefined();
      expect(s.out.rawChunks.some((c) => c.text.includes("Resetting local database"))).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("smart mode: forwards --network-id to the local reset", () => {
    // `legacyResetLocalDatabase` resolves `LegacyNetworkIdFlag` itself from the
    // shared context (CLI-2062) — no argv-forwarding needed — so the recreated
    // container must land on the custom network directly.
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
      yield* legacyDbSchemaDeclarativeGenerate(flags());
      const createArgs = legacyLocalResetCreateArgs(s.child.spawned);
      const networkIndex = createArgs?.indexOf("--network") ?? -1;
      expect(networkIndex).toBeGreaterThanOrEqual(0);
      expect(createArgs?.[networkIndex + 1]).toBe("my-net");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("smart mode: rejects a malformed custom database URL", () => {
    // Go parses the custom URL with pgconn.ParseConfig and fails with
    // "failed to parse connection string: ..." rather than passing it to pg-delta.
    mkdirSync(join(tmp.current, "supabase", "migrations"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "migrations", "0001_init.sql"), "select 1;");
    const s = setup(tmp.current, {
      experimental: true,
      stdinIsTty: true,
      promptSelectResponses: ["custom"],
      promptTextResponses: ["not a url"],
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDbSchemaDeclarativeGenerate(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failError(exit)).toMatchObject({
        _tag: "LegacyDeclarativeInvalidDbUrlError",
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
      yield* legacyDbSchemaDeclarativeGenerate(flags());
      // Normalized via ToPostgresURL → connect_timeout appended, like Go.
      expect(s.edgeCalls[0]!.env["TARGET"]).toContain("@db.example.com:5432/app?connect_timeout=");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("next engine writes its manifest and skips legacy catalog warming", () => {
    const s = setup(tmp.current, { experimental: true, engineImplementation: "next" });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeGenerate(flags({ local: Option.some(true) }));
      const manifest = JSON.parse(
        readFileSync(join(tmp.current, "supabase", "database", ".pgdelta-export.json"), "utf8"),
      );
      expect(manifest).toMatchObject({
        formatVersion: 1,
        redactSecrets: true,
        scope: "database",
        files: ["schemas/public/tables/players.sql"],
      });
      expect(s.seamCalls).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });
});
