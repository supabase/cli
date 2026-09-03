import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import type {
  V1CreateLoginRoleOutput,
  V1GetABranchConfigOutput,
  V1GetPoolerConfigOutput,
  V1GetProjectOutput,
} from "@supabase/api/effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { Deferred, Effect, Exit, Layer, Option, PlatformError, Sink, Stdio, Stream } from "effect";
import {
  LegacyDebugFlag,
  LegacyDnsResolverFlag,
  LegacyOutputFlag,
} from "../../../../shared/legacy/global-flags.ts";
import { LegacyPlatformApiFactory } from "../../../auth/legacy-platform-api-factory.service.ts";
import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { mockOutput, mockProcessControl } from "../../../../../tests/helpers/mocks.ts";
import {
  buildLegacyTestRuntime,
  LEGACY_VALID_REF,
  mockLegacyCliSettings,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApiService,
  mockLegacyTelemetryStateTracked,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { mockChildProcessSpawner } from "../../../../../../../packages/process-compose/tests/helpers/mocks.ts";
import type { LegacyPgConnInput } from "../../../shared/legacy-db-connection.service.ts";
import { LegacyDbConnectError } from "../../../shared/legacy-db-connection.errors.ts";
import type { LegacyDbConfigError } from "../../../shared/legacy-db-config.service.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import { LegacyDbConfigLoadError } from "../../../shared/legacy-db-config.errors.ts";
import type {
  LegacyDbConfigFlags,
  LegacyResolvedDbConfig,
} from "../../../shared/legacy-db-config.types.ts";
import type { LegacyGenTypesFlags } from "./types.command.ts";
import { LegacyGenTypesMetadataError } from "./types.errors.ts";
import type { LegacyGenTypesGenerateInput } from "./types.generator.ts";
import { LegacyGenTypesGenerator } from "./types.generator.ts";
import { legacyGenTypes } from "./types.handler.ts";
import { localDbContainerId } from "./types.shared.ts";

function writeConfig(workdir: string, contents: string) {
  const supabaseDir = join(workdir, "supabase");
  mkdirSync(supabaseDir, { recursive: true });
  writeFileSync(join(supabaseDir, "config.toml"), contents);
}

function writeTempFile(workdir: string, name: string, contents: string) {
  const tempDir = join(workdir, "supabase", ".temp");
  mkdirSync(tempDir, { recursive: true });
  writeFileSync(join(tempDir, name), contents);
}

function ensureDefaultConfig(workdir: string) {
  const configPath = join(workdir, "supabase", "config.toml");
  if (existsSync(configPath)) {
    return;
  }
  writeConfig(workdir, ['project_id = "demo"', "", "[api]", "schemas = []"].join("\n"));
}

function defaultFlags(overrides: Partial<LegacyGenTypesFlags> = {}): LegacyGenTypesFlags {
  return {
    local: false,
    linked: false,
    dbUrl: Option.none(),
    projectId: Option.none(),
    lang: "typescript" as const,
    schema: [],
    swiftAccessControl: "internal" as const,
    postgrestV9Compat: false,
    queryTimeout: "15s",
    ...overrides,
  };
}

function statusApiError(status: number, body: string) {
  const request = HttpClientRequest.get("https://api.supabase.test/v1/projects/ref");
  const response = HttpClientResponse.fromWeb(
    request,
    new Response(body, {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
  return new HttpClientError.HttpClientError({
    reason: new HttpClientError.StatusCodeError({ request, response }),
  });
}

function remoteResolvedConfig(
  conn: LegacyPgConnInput,
  ref = LEGACY_VALID_REF,
): LegacyResolvedDbConfig {
  return { conn, isLocal: false, ref: Option.some(ref) };
}

function mockDbConfigResolver(
  opts: {
    readonly resolve?: (
      flags: LegacyDbConfigFlags,
    ) => Effect.Effect<LegacyResolvedDbConfig, LegacyDbConfigError>;
    readonly poolerFallback?: Option.Option<LegacyPgConnInput>;
    readonly poolerFallbackFails?: boolean;
  } = {},
) {
  const resolves: Array<LegacyDbConfigFlags> = [];
  const poolerFallbacks: Array<LegacyDbConfigFlags> = [];
  const layer = Layer.succeed(LegacyDbConfigResolver, {
    resolve: (flags) =>
      Effect.gen(function* () {
        resolves.push(flags);
        return yield* (
          opts.resolve?.(flags) ??
            Effect.succeed(
              remoteResolvedConfig({
                host: "127.0.0.1",
                port: 5432,
                user: "postgres",
                password: "postgres",
                database: "postgres",
              }),
            )
        );
      }),
    resolvePoolerFallback: (flags) =>
      opts.poolerFallbackFails === true
        ? Effect.fail(new LegacyDbConfigLoadError({ message: "pooler fallback failed" }))
        : Effect.sync(() => {
            poolerFallbacks.push(flags);
            return opts.poolerFallback ?? Option.none<LegacyPgConnInput>();
          }),
  });
  return { layer, resolves, poolerFallbacks };
}

/**
 * Recording fake for the native typegen seam. Each `generate` call is captured;
 * the nth call resolves with the nth entry of `results` (falling back to a
 * plain `"generated"` success when the list is exhausted or absent).
 */
function mockLegacyGenTypesGenerator(
  opts: {
    readonly output?: string;
    readonly results?: ReadonlyArray<
      Effect.Effect<string, LegacyDbConnectError | LegacyGenTypesMetadataError>
    >;
  } = {},
) {
  const calls: Array<LegacyGenTypesGenerateInput> = [];
  const layer = Layer.succeed(LegacyGenTypesGenerator, {
    generate: (input) =>
      Effect.suspend(() => {
        calls.push(input);
        return opts.results?.[calls.length - 1] ?? Effect.succeed(opts.output ?? "generated");
      }),
  });
  return { layer, calls };
}

type BranchConfig = typeof V1GetABranchConfigOutput.Type;
type LoginRole = typeof V1CreateLoginRoleOutput.Type;
type PoolerConfig = typeof V1GetPoolerConfigOutput.Type;
type Project = typeof V1GetProjectOutput.Type;

function setup(
  opts: {
    readonly workdir?: string;
    readonly skipConfig?: boolean;
    readonly projectId?: Option.Option<string>;
    readonly format?: "text" | "json" | "stream-json";
    readonly goOutput?: Option.Option<"env" | "pretty" | "json" | "toml" | "yaml">;
    readonly projectTypes?: string;
    readonly childStderr?: ReadonlyArray<string>;
    readonly childExitCode?: number;
    readonly childLayer?: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
    readonly debug?: boolean;
    readonly onSpawn?: (record: {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
    }) => void;
    readonly args?: ReadonlyArray<string>;
    readonly generatorOutput?: string;
    readonly generatorResults?: ReadonlyArray<
      Effect.Effect<string, LegacyDbConnectError | LegacyGenTypesMetadataError>
    >;
    readonly generateTypescriptTypes?: (input: {
      readonly ref: string;
      readonly included_schemas?: string;
    }) => Effect.Effect<{ readonly types: string }, unknown>;
    readonly getABranchConfig?: (input: {
      readonly branch_id_or_ref: string;
    }) => Effect.Effect<BranchConfig, unknown>;
    readonly getPoolerConfig?: (input: {
      readonly ref: string;
    }) => Effect.Effect<PoolerConfig, unknown>;
    readonly getProject?: (input: { readonly ref: string }) => Effect.Effect<Project, unknown>;
    readonly createLoginRole?: (input: {
      readonly ref: string;
      readonly read_only: boolean;
    }) => Effect.Effect<LoginRole, unknown>;
    readonly dbConfigResolve?: (
      flags: LegacyDbConfigFlags,
    ) => Effect.Effect<LegacyResolvedDbConfig, LegacyDbConfigError>;
    readonly poolerFallback?: Option.Option<LegacyPgConnInput>;
    readonly poolerFallbackFails?: boolean;
  } = {},
) {
  const workdir = opts.workdir ?? mkdtempSync(join(tmpdir(), "supabase-gen-types-"));
  if (!opts.skipConfig) {
    ensureDefaultConfig(workdir);
  }
  const out = mockOutput({
    format: opts.format ?? "text",
    interactive: (opts.format ?? "text") === "text",
  });
  const telemetry = mockLegacyTelemetryStateTracked();
  const linkedProjectCache = mockLegacyLinkedProjectCacheTracked();
  const dbConfig = mockDbConfigResolver({
    resolve: opts.dbConfigResolve,
    poolerFallback: opts.poolerFallback,
    poolerFallbackFails: opts.poolerFallbackFails,
  });
  const generator = mockLegacyGenTypesGenerator({
    output: opts.generatorOutput,
    results: opts.generatorResults,
  });
  const processControl = mockProcessControl();
  const child = mockChildProcessSpawner({
    stdout: [],
    stderr: [...(opts.childStderr ?? [])],
    exitCode: opts.childExitCode ?? 0,
    onSpawn: opts.onSpawn,
  });
  const api = mockLegacyPlatformApiService({
    v1: {
      getABranchConfig:
        opts.getABranchConfig ??
        (({ branch_id_or_ref }) =>
          Effect.succeed({
            ref: branch_id_or_ref,
            postgres_version: "15.1",
            postgres_engine: "15",
            release_channel: "ga",
            status: "ACTIVE_HEALTHY",
            db_host: "127.0.0.1",
            db_port: 5432,
            db_user: "postgres",
            db_pass: "postgres",
            jwt_secret: "secret",
          })),
      getProject:
        opts.getProject ??
        (({ ref }) =>
          Effect.succeed({
            id: ref,
            ref,
            organization_id: "org-id",
            organization_slug: "org",
            name: "demo",
            region: "us-east-1",
            created_at: "2025-01-01T00:00:00Z",
            status: "ACTIVE_HEALTHY",
            database: {
              host: `db.${ref}.supabase.co`,
              version: "15.1",
              postgres_engine: "15",
              release_channel: "ga",
            },
          })),
      getPoolerConfig:
        opts.getPoolerConfig ??
        (() =>
          Effect.succeed([
            {
              identifier: "primary",
              database_type: "PRIMARY",
              is_using_scram_auth: true,
              db_user: "postgres",
              db_host: "db.example",
              db_port: 5432,
              db_name: "postgres",
              connection_string: "postgres://postgres:[YOUR-PASSWORD]@127.0.0.1:6543/postgres",
              connectionString: "postgres://postgres:[YOUR-PASSWORD]@127.0.0.1:6543/postgres",
              default_pool_size: null,
              max_client_conn: null,
              pool_mode: "transaction",
            },
          ])),
      createLoginRole:
        opts.createLoginRole ??
        (() =>
          Effect.succeed({
            role: "postgres",
            password: "postgres",
            ttl_seconds: 3600,
          })),
      generateTypescriptTypes:
        opts.generateTypescriptTypes ??
        (({ included_schemas }) =>
          Effect.succeed({
            types: opts.projectTypes ?? `// ${included_schemas ?? "public"}`,
          })),
    },
  });

  const runtime = buildLegacyTestRuntime({
    out,
    api,
    cliSettings: mockLegacyCliSettings({
      workdir,
      projectId: opts.projectId ?? Option.none(),
    }),
    telemetry: telemetry.layer,
    linkedProjectCache: linkedProjectCache.layer,
  });

  const layer = Layer.mergeAll(
    runtime,
    BunServices.layer,
    opts.childLayer ?? child.layer,
    processControl.layer,
    Stdio.layerTest({ args: Effect.succeed(opts.args ?? ["gen", "types"]) }),
    Layer.succeed(LegacyOutputFlag, opts.goOutput ?? Option.none()),
    Layer.succeed(LegacyDebugFlag, opts.debug ?? false),
    Layer.succeed(LegacyDnsResolverFlag, "native" as const),
    Layer.succeed(LegacyPlatformApiFactory, {
      make: LegacyPlatformApi.pipe(Effect.provide(api.layer)),
    }),
    dbConfig.layer,
    generator.layer,
  );

  return {
    workdir,
    out,
    telemetry,
    linkedProjectCache,
    dbConfig,
    generator,
    processControl,
    child,
    api,
    layer,
  };
}

function mockDockerMissingChildProcessSpawner(
  steps: ReadonlyArray<{
    readonly exitCode?: number;
    readonly stdout?: ReadonlyArray<string>;
    readonly stderr?: ReadonlyArray<string>;
  }>,
) {
  const encoder = new TextEncoder();
  const spawned: Array<{ command: string; args: ReadonlyArray<string> }> = [];
  let stepIndex = 0;

  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        const cmd = command._tag === "StandardCommand" ? command.command : "";
        const args = command._tag === "StandardCommand" ? command.args : [];
        spawned.push({ command: cmd, args });

        if (cmd === "docker") {
          return yield* Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "ChildProcess",
              method: "spawn",
              description: "docker not found",
            }),
          );
        }

        const step = steps[Math.min(stepIndex, steps.length - 1)];
        stepIndex += 1;
        const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();

        yield* Effect.forkDetach(
          Effect.gen(function* () {
            yield* Effect.sleep("10 millis");
            yield* Deferred.succeed(
              exitDeferred,
              ChildProcessSpawner.ExitCode(step?.exitCode ?? 0),
            );
          }),
        );

        const stdoutBytes = (step?.stdout ?? []).map((line) => encoder.encode(`${line}\n`));
        const stderrBytes = (step?.stderr ?? []).map((line) => encoder.encode(`${line}\n`));

        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(3000 + spawned.length),
          stdout: Stream.fromIterable(stdoutBytes),
          stderr: Stream.fromIterable(stderrBytes),
          all: Stream.empty,
          exitCode: Deferred.await(exitDeferred),
          isRunning: Effect.succeed(false),
          stdin: Sink.drain,
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    ),
  );

  return {
    layer,
    get spawned() {
      return spawned;
    },
  };
}

const IPV6_CONNECT_FAILURE = new LegacyDbConnectError({
  message: `failed to connect to postgres: could not translate host name "db.${LEGACY_VALID_REF}.supabase.co" to address: No address associated with hostname`,
});

const NATIVE_ENOTFOUND_CONNECT_FAILURE = new LegacyDbConnectError({
  message: `failed to connect to postgres: failed to connect to \`host=db.${LEGACY_VALID_REF}.supabase.co user=postgres database=postgres\`: hostname resolving error (getaddrinfo ENOTFOUND)`,
});

const nonTypescriptProjectRefScenarios = [
  { lang: "go", output: "type PublicMovies struct {}" },
  { lang: "swift", output: "struct PublicMovies: Codable {}" },
  { lang: "python", output: "class PublicMovies(BaseModel):" },
] as const satisfies ReadonlyArray<{
  readonly lang: Exclude<LegacyGenTypesFlags["lang"], "typescript">;
  readonly output: string;
}>;

describe("legacy gen types", () => {
  it.live("generates typescript types from a project ref", () => {
    const { layer, out, api, linkedProjectCache, telemetry } = setup({
      projectId: Option.some(LEGACY_VALID_REF),
      projectTypes: "export type Database = {};",
    });

    return Effect.gen(function* () {
      yield* legacyGenTypes(defaultFlags()).pipe(Effect.provide(layer));

      expect(out.stdoutText).toBe("export type Database = {};");
      expect(api.requests).toEqual([
        {
          method: "generateTypescriptTypes",
          input: { ref: LEGACY_VALID_REF, included_schemas: "public" },
        },
      ]);
      expect(linkedProjectCache.cached).toBe(true);
      expect(telemetry.flushed).toBe(true);
    });
  });

  it.live("generates types from the explicit --linked flag", () => {
    const { layer, out, api, linkedProjectCache, telemetry } = setup({
      projectId: Option.some(LEGACY_VALID_REF),
      projectTypes: "export type Database = {};",
    });

    return Effect.gen(function* () {
      yield* legacyGenTypes(defaultFlags({ linked: true })).pipe(Effect.provide(layer));

      expect(out.stdoutText).toBe("export type Database = {};");
      expect(api.requests).toEqual([
        {
          method: "generateTypescriptTypes",
          input: { ref: LEGACY_VALID_REF, included_schemas: "public" },
        },
      ]);
      expect(linkedProjectCache.cached).toBe(true);
      expect(telemetry.flushed).toBe(true);
    });
  });

  it.live("uses explicit schemas for the management API path", () => {
    const { layer, api } = setup({
      projectTypes: "ok",
    });

    return Effect.gen(function* () {
      yield* legacyGenTypes(
        defaultFlags({
          projectId: Option.some(LEGACY_VALID_REF),
          schema: ["auth", "storage"],
        }),
      ).pipe(Effect.provide(layer));

      expect(api.requests[0]).toEqual({
        method: "generateTypescriptTypes",
        input: { ref: LEGACY_VALID_REF, included_schemas: "auth,storage" },
      });
    });
  });

  it.live(
    "uses configured api schemas for explicit project-id generation when --schema is unset",
    () => {
      const workdir = mkdtempSync(join(tmpdir(), "supabase-gen-types-project-id-"));
      writeConfig(
        workdir,
        ['project_id = "demo"', "", "[api]", 'schemas = ["auth", "storage"]'].join("\n"),
      );
      const { layer, api } = setup({
        workdir,
        projectTypes: "ok",
      });

      return Effect.gen(function* () {
        yield* legacyGenTypes(
          defaultFlags({
            projectId: Option.some(LEGACY_VALID_REF),
          }),
        ).pipe(Effect.provide(layer));

        expect(api.requests[0]).toEqual({
          method: "generateTypescriptTypes",
          input: { ref: LEGACY_VALID_REF, included_schemas: "public,auth,storage" },
        });
      });
    },
  );

  it.live(
    "uses configured api schemas for resolved linked generation when --schema is unset",
    () => {
      const workdir = mkdtempSync(join(tmpdir(), "supabase-gen-types-linked-"));
      writeConfig(
        workdir,
        ['project_id = "demo"', "", "[api]", 'schemas = ["auth", "storage"]'].join("\n"),
      );
      const { layer, api } = setup({
        workdir,
        projectId: Option.some(LEGACY_VALID_REF),
        projectTypes: "ok",
      });

      return Effect.gen(function* () {
        yield* legacyGenTypes(defaultFlags()).pipe(Effect.provide(layer));

        expect(api.requests[0]).toEqual({
          method: "generateTypescriptTypes",
          input: { ref: LEGACY_VALID_REF, included_schemas: "public,auth,storage" },
        });
      });
    },
  );

  it.live("fails when no target resolves", () => {
    const { layer } = setup();

    return Effect.gen(function* () {
      const exit = yield* legacyGenTypes(defaultFlags()).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain(
          "Must specify one of --local, --linked, --project-id, or --db-url",
        );
      }
    });
  });

  it.live("rejects combining --local and --linked", () => {
    const { layer, telemetry } = setup({ args: ["gen", "types", "--local", "--linked"] });

    return Effect.gen(function* () {
      const exit = yield* legacyGenTypes(defaultFlags({ local: true, linked: true })).pipe(
        Effect.provide(layer),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        // cobra sorts the violating-flag set alphabetically (sort.Strings) —
        // "linked" before "local" — regardless of check order.
        expect(String(exit.cause)).toContain(
          "if any flags in the group [local linked project-id db-url] are set none of the others can be; [linked local] were all set",
        );
      }
      // The root's `PersistentPreRunE` has already installed the telemetry
      // context by the time cobra validates flag groups (`cmd/root.go:93-163`,
      // `command.go:1000-1010`), so a mutex rejection still flushes telemetry.
      expect(telemetry.flushed).toBe(true);
    });
  });

  it.live("does not misdetect a mutex flag consumed as -s's value (pflag consumption)", () => {
    // `-s` is a pflag string-slice shorthand: a bare `-s` consumes the very
    // next argv token unconditionally, even a flag-shaped one — pflag hands
    // `-s` the (oddly named, but valid) value `"--linked"`, leaving only
    // `--local` Changed. Simulates what the real Effect parser produces for
    // this argv (both `local` and `linked` parse as independently true,
    // since its tokenizer is unaware of pflag's value consumption); only the
    // pflag-faithful scan can tell them apart.
    // `childExitCode: 1` fails the local target's `container inspect`, keeping
    // the downstream failure deterministic before any generation runs.
    const { layer } = setup({
      args: ["gen", "types", "-s", "--linked", "--local"],
      childExitCode: 1,
    });

    return Effect.gen(function* () {
      const exit = yield* legacyGenTypes(defaultFlags({ local: true, linked: true })).pipe(
        Effect.provide(layer),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain("failed to inspect service");
        expect(String(exit.cause)).not.toContain("if any flags in the group");
      }
    });
  });

  it.live("rejects --swift-access-control with --linked (cobra mutex group)", () => {
    const { layer } = setup({
      args: ["gen", "types", "--linked", "--swift-access-control", "public", "--lang", "swift"],
    });

    return Effect.gen(function* () {
      const exit = yield* legacyGenTypes(
        defaultFlags({ linked: true, lang: "swift", swiftAccessControl: "public" }),
      ).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain(
          "if any flags in the group [linked project-id swift-access-control] are set none of the others can be; [linked swift-access-control] were all set",
        );
      }
    });
  });

  it.live("rejects --swift-access-control with --project-id (cobra mutex group)", () => {
    const { layer } = setup({
      args: [
        "gen",
        "types",
        "--project-id",
        LEGACY_VALID_REF,
        "--swift-access-control",
        "public",
        "--lang",
        "swift",
      ],
    });

    return Effect.gen(function* () {
      const exit = yield* legacyGenTypes(
        defaultFlags({
          projectId: Option.some(LEGACY_VALID_REF),
          lang: "swift",
          swiftAccessControl: "public",
        }),
      ).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain(
          "if any flags in the group [linked project-id swift-access-control] are set none of the others can be; [project-id swift-access-control] were all set",
        );
      }
    });
  });

  it.live("rejects --postgrest-v9-compat without --db-url for project-id generation", () => {
    const { layer } = setup({
      args: ["gen", "types", "--project-id", LEGACY_VALID_REF, "--postgrest-v9-compat"],
    });

    return Effect.gen(function* () {
      const exit = yield* legacyGenTypes(
        defaultFlags({ projectId: Option.some(LEGACY_VALID_REF), postgrestV9Compat: true }),
      ).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        // Established guard, including its "must used" typo — do not "fix" the grammar.
        expect(String(exit.cause)).toContain(
          "--postgrest-v9-compat must used together with --db-url",
        );
      }
    });
  });

  it.live("rejects --postgrest-v9-compat without --db-url for local generation", () => {
    const { layer, telemetry } = setup({
      args: ["gen", "types", "--local", "--postgrest-v9-compat"],
    });

    return Effect.gen(function* () {
      const exit = yield* legacyGenTypes(
        defaultFlags({ local: true, postgrestV9Compat: true }),
      ).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain(
          "--postgrest-v9-compat must used together with --db-url",
        );
      }
      // The guard runs after the telemetry context is already installed, so
      // this restored guard must still flush telemetry on rejection.
      expect(telemetry.flushed).toBe(true);
    });
  });

  it.live("rejects --query-timeout with --project-id (cobra mutex group)", () => {
    const { layer } = setup({
      args: ["gen", "types", "--project-id", LEGACY_VALID_REF, "--query-timeout", "20s"],
    });

    return Effect.gen(function* () {
      const exit = yield* legacyGenTypes(
        defaultFlags({ projectId: Option.some(LEGACY_VALID_REF), queryTimeout: "20s" }),
      ).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain(
          "if any flags in the group [linked project-id query-timeout] are set none of the others can be; [project-id query-timeout] were all set",
        );
      }
    });
  });

  it.live("rejects --query-timeout with --linked (cobra mutex group)", () => {
    const { layer } = setup({
      args: ["gen", "types", "--linked", "--query-timeout", "20s"],
      projectId: Option.some(LEGACY_VALID_REF),
    });

    return Effect.gen(function* () {
      const exit = yield* legacyGenTypes(defaultFlags({ linked: true, queryTimeout: "20s" })).pipe(
        Effect.provide(layer),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain(
          "if any flags in the group [linked project-id query-timeout] are set none of the others can be; [linked query-timeout] were all set",
        );
      }
    });
  });

  it.live("counts explicitly negated booleans as set for mutex groups (pflag Changed)", () => {
    const { layer } = setup({
      args: ["gen", "types", "--linked=false", "--project-id", LEGACY_VALID_REF],
    });

    return Effect.gen(function* () {
      const exit = yield* legacyGenTypes(
        defaultFlags({ linked: false, projectId: Option.some(LEGACY_VALID_REF) }),
      ).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        // pflag's `Changed` is true once a flag is passed explicitly, even as
        // `--linked=false`, so cobra still trips the mutex group.
        expect(String(exit.cause)).toContain(
          "if any flags in the group [linked project-id postgrest-v9-compat] are set none of the others can be; [linked project-id] were all set",
        );
      }
    });
  });

  it.live("fails on an invalid --query-timeout before any flag guard runs", () => {
    const { layer, telemetry } = setup({
      args: ["gen", "types", "--linked", "--query-timeout", "bogus"],
    });

    return Effect.gen(function* () {
      const exit = yield* legacyGenTypes(
        defaultFlags({ linked: true, queryTimeout: "bogus" }),
      ).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        // Go rejects the duration at flag-parse time, before PreRunE and the
        // mutex groups, so the parse error wins over the linked/query-timeout
        // mutex violation.
        expect(String(exit.cause)).toContain('invalid duration "bogus"');
        expect(String(exit.cause)).not.toContain("if any flags in the group");
      }
      // pflag's `DurationVar` rejects this at flag-parse time, before the
      // root's `PersistentPreRunE` ever installs the telemetry context
      // (`cmd/root.go:93-163`) — unlike the guards below, this rejection must
      // NOT flush telemetry.
      expect(telemetry.flushed).toBe(false);
    });
  });

  it.live("rejects a sub-second --query-timeout that would disable the bound", () => {
    const { layer, telemetry } = setup({
      args: ["gen", "types", "--db-url", "postgresql://postgres@127.0.0.1:5432/postgres"],
    });

    return Effect.gen(function* () {
      const exit = yield* legacyGenTypes(
        defaultFlags({
          dbUrl: Option.some("postgresql://postgres@127.0.0.1:5432/postgres"),
          queryTimeout: "1ms",
        }),
      ).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain('invalid duration "1ms"');
        expect(String(exit.cause)).toContain("use 0 to disable, or at least 500ms");
      }
      expect(telemetry.flushed).toBe(false);
    });
  });

  it.live("silently ignores --query-timeout for implicit linked TypeScript generation", () => {
    const { layer, out, api } = setup({
      args: ["gen", "types", "--query-timeout", "20s"],
      projectId: Option.some(LEGACY_VALID_REF),
      projectTypes: "ok",
    });

    return Effect.gen(function* () {
      yield* legacyGenTypes(defaultFlags({ queryTimeout: "20s" })).pipe(Effect.provide(layer));

      // Go neither errors nor warns here — only one flag of the
      // linked/project-id/query-timeout mutex group is set, and the remote
      // TypeScript path simply never reads the timeout.
      expect(out.stderrText).not.toContain("--query-timeout");
      expect(api.requests).toContainEqual({
        method: "generateTypescriptTypes",
        input: { ref: LEGACY_VALID_REF, included_schemas: "public" },
      });
    });
  });

  it.live(
    "forwards --query-timeout and --swift-access-control to the generator for implicit linked non-TypeScript generation",
    () => {
      const { layer, dbConfig, generator } = setup({
        args: [
          "gen",
          "types",
          "--lang",
          "go",
          "--query-timeout",
          "20s",
          "--swift-access-control",
          "public",
        ],
        projectId: Option.some(LEGACY_VALID_REF),
        generatorOutput: "type PublicMovies struct {}",
      });

      return Effect.gen(function* () {
        yield* legacyGenTypes(
          defaultFlags({ lang: "go", queryTimeout: "20s", swiftAccessControl: "public" }),
        ).pipe(Effect.provide(layer));

        // Unlike an explicit --linked/--project-id, the implicit fallback never
        // sets the "linked"/"project-id" mutex keys, so --query-timeout and
        // --swift-access-control clear every guard here and reach the
        // generator — the SIDE_EFFECTS.md defaults-invariant note is scoped to
        // the explicit paths for exactly this reason.
        expect(dbConfig.resolves[0]?.adHocProjectRef).toBe(false);
        expect(generator.calls[0]?.queryTimeoutSeconds).toBe(20);
        expect(generator.calls[0]?.swiftAccessControl).toBe("public");
      });
    },
  );

  it.live("prefers the --postgrest-v9-compat guard over mutex group errors", () => {
    const { layer } = setup({
      args: ["gen", "types", "--local", "--linked", "--postgrest-v9-compat"],
    });

    return Effect.gen(function* () {
      const exit = yield* legacyGenTypes(
        defaultFlags({ local: true, linked: true, postgrestV9Compat: true }),
      ).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        // Go runs the command's PreRunE before cobra's flag-group validation
        // (spf13/cobra command.go:1000-1010), so the PreRunE error wins.
        expect(String(exit.cause)).toContain(
          "--postgrest-v9-compat must used together with --db-url",
        );
      }
    });
  });

  it.live("prefers the positional language guard over mutex group errors", () => {
    const { layer } = setup({
      args: ["gen", "types", "go", "--local", "--linked"],
    });

    return Effect.gen(function* () {
      const exit = yield* legacyGenTypes(defaultFlags({ local: true, linked: true })).pipe(
        Effect.provide(layer),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain("use --lang flag to specify the typegen language");
      }
    });
  });

  it.live("reports mutex groups in cobra's sorted group-key order", () => {
    const dbUrl = "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
    const { layer } = setup({
      args: [
        "gen",
        "types",
        "--db-url",
        dbUrl,
        "--postgrest-v9-compat",
        "--project-id",
        LEGACY_VALID_REF,
      ],
    });

    return Effect.gen(function* () {
      const exit = yield* legacyGenTypes(
        defaultFlags({
          dbUrl: Option.some(dbUrl),
          projectId: Option.some(LEGACY_VALID_REF),
          postgrestV9Compat: true,
        }),
      ).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        // Cobra validates the groups in lexicographically sorted key order, so
        // the linked/project-id/postgrest-v9-compat group reports before the
        // local/linked/project-id/db-url group even though both are violated.
        expect(String(exit.cause)).toContain(
          "if any flags in the group [linked project-id postgrest-v9-compat] are set none of the others can be; [postgrest-v9-compat project-id] were all set",
        );
      }
    });
  });

  it.live("allows --swift-access-control for local non-Swift generation", () => {
    const workdir = mkdtempSync(join(tmpdir(), "supabase-gen-types-local-swift-flag-"));
    writeConfig(
      workdir,
      ['project_id = "demo"', "", "[api]", 'schemas = ["public"]', "", "[db]", "port = 54321"].join(
        "\n",
      ),
    );

    const { layer, generator } = setup({
      workdir,
      args: ["gen", "types", "--local", "--lang", "python", "--swift-access-control", "public"],
    });

    // Go has no "--swift-access-control requires --lang swift" guard —
    // the value is always forwarded to the generator regardless of language.
    return Effect.gen(function* () {
      yield* legacyGenTypes(
        defaultFlags({ local: true, lang: "python", swiftAccessControl: "public" }),
      ).pipe(Effect.provide(layer));

      expect(generator.calls[0]?.lang).toBe("python");
      expect(generator.calls[0]?.swiftAccessControl).toBe("public");
    });
  });

  it.live("allows --postgrest-v9-compat together with --db-url", () => {
    const dbUrl = "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
    const { layer, generator } = setup({
      args: ["gen", "types", "--db-url", dbUrl, "--postgrest-v9-compat"],
    });

    return Effect.gen(function* () {
      yield* legacyGenTypes(
        defaultFlags({
          dbUrl: Option.some(dbUrl),
          postgrestV9Compat: true,
        }),
      ).pipe(Effect.provide(layer));

      expect(generator.calls[0]?.postgrestV9Compat).toBe(true);
    });
  });

  it.live("warns that --network-id is unused and still generates", () => {
    const dbUrl = "postgresql://postgres:postgres@db:5432/postgres";
    const { layer, generator, out } = setup({
      args: ["gen", "types", "--db-url", dbUrl, "--network-id", "mycompose_default"],
    });

    return Effect.gen(function* () {
      yield* legacyGenTypes(defaultFlags({ dbUrl: Option.some(dbUrl) })).pipe(
        Effect.provide(layer),
      );

      expect(generator.calls).toHaveLength(1);
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "warn",
          message: expect.stringContaining("docker run --rm --network mycompose_default"),
        }),
      );
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "warn",
          message: expect.stringContaining("npx --yes supabase gen types"),
        }),
      );
    });
  });

  it.live("does not warn about --network-id when the flag is omitted", () => {
    const dbUrl = "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
    const { layer, out } = setup({
      args: ["gen", "types", "--db-url", dbUrl],
    });

    return Effect.gen(function* () {
      yield* legacyGenTypes(defaultFlags({ dbUrl: Option.some(dbUrl) })).pipe(
        Effect.provide(layer),
      );

      expect(out.messages.filter((message) => message.type === "warn")).toEqual([]);
    });
  });

  it.live("warns that a pre-path --network-id is unused and still generates", () => {
    const dbUrl = "postgresql://postgres:postgres@db:5432/postgres";
    const { layer, generator, out } = setup({
      args: ["--network-id", "mycompose_default", "gen", "types", "--db-url", dbUrl],
    });

    return Effect.gen(function* () {
      yield* legacyGenTypes(defaultFlags({ dbUrl: Option.some(dbUrl) })).pipe(
        Effect.provide(layer),
      );

      expect(generator.calls).toHaveLength(1);
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "warn",
          message: expect.stringContaining("docker run --rm --network mycompose_default"),
        }),
      );
    });
  });

  for (const scenario of nonTypescriptProjectRefScenarios) {
    it.live(`generates ${scenario.lang} types from a project ref through the DB resolver`, () => {
      const { layer, out, api, linkedProjectCache, dbConfig, generator } = setup({
        args: ["gen", "types", "--lang", scenario.lang, "--project-id", LEGACY_VALID_REF],
        generatorOutput: scenario.output,
        dbConfigResolve: (input) =>
          Effect.succeed(
            remoteResolvedConfig(
              {
                host: "127.0.0.1",
                port: 5432,
                user: `cli_login_${LEGACY_VALID_REF}`,
                password: "temporary-password",
                database: "postgres",
              },
              (input.linkedProjectRef !== undefined
                ? Option.getOrUndefined(input.linkedProjectRef)
                : undefined) ?? LEGACY_VALID_REF,
            ),
          ),
        getABranchConfig: ({ branch_id_or_ref }) =>
          Effect.fail(new Error(`unexpected preview branch lookup for ${branch_id_or_ref}`)),
        createLoginRole: ({ ref }) =>
          Effect.fail(new Error(`unexpected login role creation for ${ref}`)),
      });

      return Effect.gen(function* () {
        yield* legacyGenTypes(
          defaultFlags({
            projectId: Option.some(LEGACY_VALID_REF),
            lang: scenario.lang,
          }),
        ).pipe(Effect.provide(layer));

        expect(api.requests).toContainEqual({
          method: "getProject",
          input: { ref: LEGACY_VALID_REF },
        });
        expect(api.requests).not.toContainEqual(
          expect.objectContaining({ method: "createLoginRole" }),
        );
        expect(api.requests).not.toContainEqual(
          expect.objectContaining({ method: "getABranchConfig" }),
        );
        expect(api.requests).not.toContainEqual(
          expect.objectContaining({ method: "generateTypescriptTypes" }),
        );
        expect(out.stderrText).toContain("Connecting to 127.0.0.1 5432");
        expect(dbConfig.resolves).toHaveLength(1);
        expect(dbConfig.resolves[0]?.connType).toBe("linked");
        // --project-id is an ad-hoc remote ref: the resolver must not inherit
        // the workdir's ambient password / saved pooler URL.
        expect(dbConfig.resolves[0]?.adHocProjectRef).toBe(true);
        const linkedProjectRef = dbConfig.resolves[0]?.linkedProjectRef;
        expect(
          linkedProjectRef !== undefined ? Option.getOrUndefined(linkedProjectRef) : undefined,
        ).toBe(LEGACY_VALID_REF);
        expect(generator.calls).toHaveLength(1);
        expect(generator.calls[0]?.conn).toEqual({
          host: "127.0.0.1",
          port: 5432,
          user: `cli_login_${LEGACY_VALID_REF}`,
          password: "temporary-password",
          database: "postgres",
        });
        expect(generator.calls[0]?.isLocal).toBe(false);
        expect(generator.calls[0]?.lang).toBe(scenario.lang);
        expect(generator.calls[0]?.includedSchemas).toEqual(["public"]);
        expect(out.stdoutText).toBe(`${scenario.output}\n`);
        expect(linkedProjectCache.cached).toBe(true);
      });
    });
  }

  it.live("resolves the linked workdir DB without ad-hoc project-ref semantics", () => {
    const { layer, dbConfig } = setup({
      args: ["gen", "types", "--lang", "go", "--linked"],
      projectId: Option.some(LEGACY_VALID_REF),
      generatorOutput: "type PublicMovies struct {}",
    });

    return Effect.gen(function* () {
      yield* legacyGenTypes(defaultFlags({ linked: true, lang: "go" })).pipe(Effect.provide(layer));

      expect(dbConfig.resolves).toHaveLength(1);
      expect(dbConfig.resolves[0]?.connType).toBe("linked");
      // --linked is the workdir's own project: keep workdir-scoped credentials.
      expect(dbConfig.resolves[0]?.adHocProjectRef).toBe(false);
    });
  });

  it.live("preserves resolver URL options for remote non-TypeScript typegen", () => {
    const { layer, generator } = setup({
      args: ["gen", "types", "--lang", "go", "--project-id", LEGACY_VALID_REF],
      generatorOutput: "type PublicMovies struct {}",
      dbConfigResolve: () =>
        Effect.succeed(
          remoteResolvedConfig({
            host: "127.0.0.1",
            port: 5432,
            user: `postgres.${LEGACY_VALID_REF}`,
            password: "pooler-password",
            database: "postgres",
            options: `reference=${LEGACY_VALID_REF}`,
          }),
        ),
    });

    return Effect.gen(function* () {
      yield* legacyGenTypes(
        defaultFlags({
          projectId: Option.some(LEGACY_VALID_REF),
          lang: "go",
        }),
      ).pipe(Effect.provide(layer));

      // Supavisor pooler URLs carry the tenant in `options=reference=<ref>`;
      // the resolved connection must reach the driver intact.
      expect(generator.calls[0]?.conn.options).toBe(`reference=${LEGACY_VALID_REF}`);
      expect(generator.calls[0]?.conn.user).toBe(`postgres.${LEGACY_VALID_REF}`);
    });
  });

  it.live("retries remote generation through the IPv4 pooler on an IPv6 connect failure", () => {
    const poolerConn: LegacyPgConnInput = {
      host: "127.0.0.1",
      port: 6543,
      user: `postgres.${LEGACY_VALID_REF}`,
      password: "pooler-password",
      database: "postgres",
    };
    const { layer, out, dbConfig, generator } = setup({
      args: ["gen", "types", "--lang", "go", "--project-id", LEGACY_VALID_REF],
      generatorResults: [
        Effect.fail(IPV6_CONNECT_FAILURE),
        Effect.succeed("type RetriedViaPooler struct {}"),
      ],
      dbConfigResolve: () =>
        Effect.succeed(
          remoteResolvedConfig({
            host: `db.${LEGACY_VALID_REF}.supabase.co`,
            port: 5432,
            user: "postgres",
            password: "direct-password",
            database: "postgres",
          }),
        ),
      poolerFallback: Option.some(poolerConn),
    });

    return Effect.gen(function* () {
      yield* legacyGenTypes(
        defaultFlags({
          projectId: Option.some(LEGACY_VALID_REF),
          lang: "go",
        }),
      ).pipe(Effect.provide(layer));

      expect(out.stdoutText).toContain("type RetriedViaPooler struct {}");
      expect(out.stderrText).toContain("does not support IPv6");
      expect(out.stderrText).toContain("Retrying via the IPv4 connection pooler.");
      expect(generator.calls).toHaveLength(2);
      expect(generator.calls[0]?.conn.host).toBe(`db.${LEGACY_VALID_REF}.supabase.co`);
      expect(generator.calls[1]?.conn).toEqual(poolerConn);
      expect(generator.calls[1]?.isLocal).toBe(false);
      expect(dbConfig.poolerFallbacks).toHaveLength(1);
      expect(dbConfig.poolerFallbacks[0]?.connType).toBe("linked");
      expect(dbConfig.poolerFallbacks[0]?.adHocProjectRef).toBe(true);
    });
  });

  it.live("retries remote generation through the IPv4 pooler on a Node ENETUNREACH failure", () => {
    const poolerConn: LegacyPgConnInput = {
      host: "127.0.0.1",
      port: 6543,
      user: `postgres.${LEGACY_VALID_REF}`,
      password: "pooler-password",
      database: "postgres",
    };
    const { layer, out, dbConfig, generator } = setup({
      args: ["gen", "types", "--lang", "go", "--project-id", LEGACY_VALID_REF],
      generatorResults: [
        Effect.fail(
          new LegacyDbConnectError({
            message:
              "failed to connect to postgres: connect ENETUNREACH 2600:1f18::1:5432 - Local (:::0)",
          }),
        ),
        Effect.succeed("type RetriedViaPooler struct {}"),
      ],
      dbConfigResolve: () =>
        Effect.succeed(
          remoteResolvedConfig({
            host: `db.${LEGACY_VALID_REF}.supabase.co`,
            port: 5432,
            user: "postgres",
            password: "direct-password",
            database: "postgres",
          }),
        ),
      poolerFallback: Option.some(poolerConn),
    });

    return Effect.gen(function* () {
      yield* legacyGenTypes(
        defaultFlags({
          projectId: Option.some(LEGACY_VALID_REF),
          lang: "go",
        }),
      ).pipe(Effect.provide(layer));

      expect(out.stdoutText).toContain("type RetriedViaPooler struct {}");
      expect(generator.calls).toHaveLength(2);
      expect(dbConfig.poolerFallbacks).toHaveLength(1);
    });
  });

  it.live(
    "retries remote generation through the IPv4 pooler on a native ENOTFOUND connect error",
    () => {
      const poolerConn: LegacyPgConnInput = {
        host: "127.0.0.1",
        port: 6543,
        user: `postgres.${LEGACY_VALID_REF}`,
        password: "pooler-password",
        database: "postgres",
      };
      const { layer, out, dbConfig, generator } = setup({
        args: ["gen", "types", "--lang", "go", "--project-id", LEGACY_VALID_REF],
        generatorResults: [
          Effect.fail(NATIVE_ENOTFOUND_CONNECT_FAILURE),
          Effect.succeed("type RetriedViaPooler struct {}"),
        ],
        dbConfigResolve: () =>
          Effect.succeed(
            remoteResolvedConfig({
              host: `db.${LEGACY_VALID_REF}.supabase.co`,
              port: 5432,
              user: "postgres",
              password: "direct-password",
              database: "postgres",
            }),
          ),
        poolerFallback: Option.some(poolerConn),
      });

      return Effect.gen(function* () {
        yield* legacyGenTypes(
          defaultFlags({
            projectId: Option.some(LEGACY_VALID_REF),
            lang: "go",
          }),
        ).pipe(Effect.provide(layer));

        expect(out.stdoutText).toContain("type RetriedViaPooler struct {}");
        expect(generator.calls).toHaveLength(2);
        expect(dbConfig.poolerFallbacks).toHaveLength(1);
      });
    },
  );

  it.live("does not retry remote generation when the failure is not IPv6", () => {
    const { layer, dbConfig, generator } = setup({
      args: ["gen", "types", "--lang", "go", "--project-id", LEGACY_VALID_REF],
      generatorResults: [
        Effect.fail(
          new LegacyGenTypesMetadataError({
            message: "failed to introspect database: permission denied for schema public",
          }),
        ),
      ],
      dbConfigResolve: () =>
        Effect.succeed(
          remoteResolvedConfig({
            host: `db.${LEGACY_VALID_REF}.supabase.co`,
            port: 5432,
            user: "postgres",
            password: "direct-password",
            database: "postgres",
          }),
        ),
      poolerFallback: Option.some({
        host: "127.0.0.1",
        port: 6543,
        user: `postgres.${LEGACY_VALID_REF}`,
        password: "pooler-password",
        database: "postgres",
      }),
    });

    return Effect.gen(function* () {
      const exit = yield* legacyGenTypes(
        defaultFlags({
          projectId: Option.some(LEGACY_VALID_REF),
          lang: "go",
        }),
      ).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(generator.calls).toHaveLength(1);
      expect(dbConfig.poolerFallbacks).toHaveLength(0);
    });
  });

  it.live("does not run pooler fallback a second time when the retry also fails with IPv6", () => {
    const { layer, dbConfig, generator } = setup({
      args: ["gen", "types", "--lang", "go", "--project-id", LEGACY_VALID_REF],
      generatorResults: [Effect.fail(IPV6_CONNECT_FAILURE), Effect.fail(IPV6_CONNECT_FAILURE)],
      dbConfigResolve: () =>
        Effect.succeed(
          remoteResolvedConfig({
            host: `db.${LEGACY_VALID_REF}.supabase.co`,
            port: 5432,
            user: "postgres",
            password: "direct-password",
            database: "postgres",
          }),
        ),
      poolerFallback: Option.some({
        host: "127.0.0.1",
        port: 6543,
        user: `postgres.${LEGACY_VALID_REF}`,
        password: "pooler-password",
        database: "postgres",
      }),
    });

    return Effect.gen(function* () {
      const exit = yield* legacyGenTypes(
        defaultFlags({
          projectId: Option.some(LEGACY_VALID_REF),
          lang: "go",
        }),
      ).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(generator.calls).toHaveLength(2);
      expect(dbConfig.poolerFallbacks).toHaveLength(1);
    });
  });

  it.live(
    "does not retry remote generation when the resolved connection is already a pooler host",
    () => {
      const { layer, out, dbConfig, generator } = setup({
        args: ["gen", "types", "--lang", "go", "--project-id", LEGACY_VALID_REF],
        generatorResults: [Effect.fail(IPV6_CONNECT_FAILURE)],
        dbConfigResolve: () =>
          Effect.succeed(
            remoteResolvedConfig({
              host: "aws-0-us-east-1.pooler.supabase.com",
              port: 5432,
              user: `postgres.${LEGACY_VALID_REF}`,
              password: "pooler-password",
              database: "postgres",
            }),
          ),
        poolerFallback: Option.some({
          host: "aws-0-us-east-1.pooler.supabase.com",
          port: 5432,
          user: `postgres.${LEGACY_VALID_REF}`,
          password: "pooler-password",
          database: "postgres",
        }),
      });

      return Effect.gen(function* () {
        const exit = yield* legacyGenTypes(
          defaultFlags({
            projectId: Option.some(LEGACY_VALID_REF),
            lang: "go",
          }),
        ).pipe(Effect.provide(layer), Effect.exit);

        expect(Exit.isFailure(exit)).toBe(true);
        expect(generator.calls).toHaveLength(1);
        expect(dbConfig.poolerFallbacks).toHaveLength(0);
        expect(out.stderrText).not.toContain("Retrying via the IPv4 connection pooler.");
      });
    },
  );

  it.live("preserves the original generation error when pooler fallback resolution fails", () => {
    const { layer, generator } = setup({
      args: ["gen", "types", "--lang", "go", "--project-id", LEGACY_VALID_REF],
      generatorResults: [Effect.fail(IPV6_CONNECT_FAILURE)],
      dbConfigResolve: () =>
        Effect.succeed(
          remoteResolvedConfig({
            host: `db.${LEGACY_VALID_REF}.supabase.co`,
            port: 5432,
            user: "postgres",
            password: "direct-password",
            database: "postgres",
          }),
        ),
      poolerFallbackFails: true,
    });

    return Effect.gen(function* () {
      const exit = yield* legacyGenTypes(
        defaultFlags({
          projectId: Option.some(LEGACY_VALID_REF),
          lang: "go",
        }),
      ).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain("could not translate host name");
        expect(String(exit.cause)).not.toContain("pooler fallback failed");
      }
      expect(generator.calls).toHaveLength(1);
    });
  });

  it.live("uses remote config schemas for explicit project-ref typegen", () => {
    const workdir = mkdtempSync(join(tmpdir(), "supabase-gen-types-remote-config-"));
    writeConfig(
      workdir,
      [
        'project_id = "base"',
        "",
        "[api]",
        'schemas = ["public"]',
        "",
        "[remotes.staging]",
        `project_id = "${LEGACY_VALID_REF}"`,
        "",
        "[remotes.staging.api]",
        'schemas = ["private"]',
        "",
      ].join("\n"),
    );
    const { layer, generator } = setup({
      workdir,
      args: ["gen", "types", "--lang", "go", "--project-id", LEGACY_VALID_REF],
      generatorOutput: "type PrivateMovies struct {}",
    });

    return Effect.gen(function* () {
      try {
        yield* legacyGenTypes(
          defaultFlags({
            projectId: Option.some(LEGACY_VALID_REF),
            lang: "go",
          }),
        ).pipe(Effect.provide(layer));
      } finally {
        rmSync(workdir, { recursive: true, force: true });
      }

      expect(generator.calls[0]?.includedSchemas).toEqual(["public", "private"]);
    });
  });

  it.live("uses remote config schemas for linked typegen", () => {
    const workdir = mkdtempSync(join(tmpdir(), "supabase-gen-types-linked-config-"));
    writeConfig(
      workdir,
      [
        'project_id = "base"',
        "",
        "[api]",
        'schemas = ["public"]',
        "",
        "[remotes.staging]",
        `project_id = "${LEGACY_VALID_REF}"`,
        "",
        "[remotes.staging.api]",
        'schemas = ["private"]',
        "",
      ].join("\n"),
    );
    const { layer, generator } = setup({
      workdir,
      projectId: Option.some(LEGACY_VALID_REF),
      args: ["gen", "types", "--lang", "go", "--linked"],
      generatorOutput: "type PrivateMovies struct {}",
    });

    return Effect.gen(function* () {
      try {
        yield* legacyGenTypes(
          defaultFlags({
            linked: true,
            lang: "go",
          }),
        ).pipe(Effect.provide(layer));
      } finally {
        rmSync(workdir, { recursive: true, force: true });
      }

      expect(generator.calls[0]?.includedSchemas).toEqual(["public", "private"]);
    });
  });

  it.live("falls back to preview branch config for non-TypeScript project refs", () => {
    const { layer, api, dbConfig, generator } = setup({
      args: ["gen", "types", "--lang", "python", "--project-id", LEGACY_VALID_REF],
      generatorOutput: "class PublicMovies(BaseModel):",
      getProject: () => Effect.fail(statusApiError(404, `{"message":"Preview branch not found"}`)),
      getABranchConfig: ({ branch_id_or_ref }) =>
        Effect.succeed({
          ref: branch_id_or_ref,
          postgres_version: "15.1",
          postgres_engine: "15",
          release_channel: "ga",
          status: "ACTIVE_HEALTHY",
          db_host: "127.0.0.1",
          db_port: 5432,
          db_user: "branch_user",
          db_pass: "branch-password",
          jwt_secret: "secret",
        }),
      createLoginRole: ({ ref }) =>
        Effect.fail(new Error(`unexpected login role creation for ${ref}`)),
    });

    return Effect.gen(function* () {
      yield* legacyGenTypes(
        defaultFlags({
          projectId: Option.some(LEGACY_VALID_REF),
          lang: "python",
        }),
      ).pipe(Effect.provide(layer));

      expect(api.requests).toContainEqual({
        method: "getProject",
        input: { ref: LEGACY_VALID_REF },
      });
      expect(api.requests).toContainEqual({
        method: "getABranchConfig",
        input: { branch_id_or_ref: LEGACY_VALID_REF },
      });
      expect(api.requests).not.toContainEqual(
        expect.objectContaining({ method: "createLoginRole" }),
      );
      expect(dbConfig.resolves).toHaveLength(0);
      expect(generator.calls[0]?.conn).toEqual({
        host: "127.0.0.1",
        port: 5432,
        user: "branch_user",
        password: "branch-password",
        database: "postgres",
      });
      expect(generator.calls[0]?.isLocal).toBe(false);
    });
  });

  it.live("retries preview branch generation through the branch IPv4 pooler", () => {
    const poolerHost = "aws-0-us-east-1.pooler.supabase.com";
    const { layer, api, generator } = setup({
      args: ["gen", "types", "--lang", "python", "--project-id", LEGACY_VALID_REF],
      generatorResults: [
        Effect.fail(IPV6_CONNECT_FAILURE),
        Effect.succeed("class RetriedViaBranchPooler(BaseModel):"),
      ],
      getProject: () => Effect.fail(statusApiError(404, `{"message":"Not found"}`)),
      getABranchConfig: ({ branch_id_or_ref }) =>
        Effect.succeed({
          ref: branch_id_or_ref,
          postgres_version: "15.1",
          postgres_engine: "15",
          release_channel: "ga",
          status: "ACTIVE_HEALTHY",
          db_host: `db.${branch_id_or_ref}.supabase.co`,
          db_port: 5432,
          db_user: "branch_user",
          db_pass: "branch-password",
          jwt_secret: "secret",
        }),
      getPoolerConfig: ({ ref }) =>
        Effect.succeed([
          {
            identifier: "primary",
            database_type: "PRIMARY",
            is_using_scram_auth: true,
            db_user: "postgres",
            db_host: "db.example",
            db_port: 5432,
            db_name: "postgres",
            connection_string: `postgres://postgres.${ref}:[YOUR-PASSWORD]@${poolerHost}:6543/postgres`,
            connectionString: `postgres://postgres.${ref}:[YOUR-PASSWORD]@${poolerHost}:6543/postgres`,
            default_pool_size: null,
            max_client_conn: null,
            pool_mode: "transaction",
          },
        ]),
    });

    return Effect.gen(function* () {
      yield* legacyGenTypes(
        defaultFlags({
          projectId: Option.some(LEGACY_VALID_REF),
          lang: "python",
        }),
      ).pipe(Effect.provide(layer));

      expect(api.requests).toContainEqual({
        method: "getPoolerConfig",
        input: { ref: LEGACY_VALID_REF },
      });
      expect(generator.calls).toHaveLength(2);
      expect(generator.calls[1]?.conn.host).toBe(poolerHost);
      expect(generator.calls[1]?.conn.user).toBe(`postgres.${LEGACY_VALID_REF}`);
      // The branch credentials replace the pooler URL's placeholder password.
      expect(generator.calls[1]?.conn.password).toBe("branch-password");
    });
  });

  it.live("skips preview branch pooler fallback when the pooler URL fails validation", () => {
    const { layer, api, generator } = setup({
      args: ["gen", "types", "--lang", "python", "--project-id", LEGACY_VALID_REF],
      generatorResults: [Effect.fail(IPV6_CONNECT_FAILURE)],
      getProject: () => Effect.fail(statusApiError(404, `{"message":"Not found"}`)),
      getABranchConfig: ({ branch_id_or_ref }) =>
        Effect.succeed({
          ref: branch_id_or_ref,
          postgres_version: "15.1",
          postgres_engine: "15",
          release_channel: "ga",
          status: "ACTIVE_HEALTHY",
          db_host: `db.${branch_id_or_ref}.supabase.co`,
          db_port: 5432,
          db_user: "branch_user",
          db_pass: "branch-password",
          jwt_secret: "secret",
        }),
      getPoolerConfig: ({ ref }) =>
        Effect.succeed([
          {
            identifier: "primary",
            database_type: "PRIMARY",
            is_using_scram_auth: true,
            db_user: "postgres",
            db_host: "db.example",
            db_port: 5432,
            db_name: "postgres",
            connection_string: `postgres://postgres.${ref}:[YOUR-PASSWORD]@pooler.example.com:6543/postgres`,
            connectionString: `postgres://postgres.${ref}:[YOUR-PASSWORD]@pooler.example.com:6543/postgres`,
            default_pool_size: null,
            max_client_conn: null,
            pool_mode: "transaction",
          },
        ]),
    });

    return Effect.gen(function* () {
      const exit = yield* legacyGenTypes(
        defaultFlags({
          projectId: Option.some(LEGACY_VALID_REF),
          lang: "python",
        }),
      ).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(api.requests).toContainEqual({
        method: "getPoolerConfig",
        input: { ref: LEGACY_VALID_REF },
      });
      expect(generator.calls).toHaveLength(1);
    });
  });

  it.live("falls back to preview branch config for any project 404 body", () => {
    const { layer, api, dbConfig, generator } = setup({
      args: ["gen", "types", "--lang", "python", "--project-id", LEGACY_VALID_REF],
      generatorOutput: "class PublicMovies(BaseModel):",
      // The Management API's 404 wording is not guaranteed; a generic body
      // must still route to the branch config endpoint.
      getProject: () => Effect.fail(statusApiError(404, `{"message":"Not found"}`)),
      getABranchConfig: ({ branch_id_or_ref }) =>
        Effect.succeed({
          ref: branch_id_or_ref,
          postgres_version: "15.1",
          postgres_engine: "15",
          release_channel: "ga",
          status: "ACTIVE_HEALTHY",
          db_host: "127.0.0.1",
          db_port: 5432,
          db_user: "branch_user",
          db_pass: "branch-password",
          jwt_secret: "secret",
        }),
    });

    return Effect.gen(function* () {
      yield* legacyGenTypes(
        defaultFlags({
          projectId: Option.some(LEGACY_VALID_REF),
          lang: "python",
        }),
      ).pipe(Effect.provide(layer));

      expect(api.requests).toContainEqual({
        method: "getABranchConfig",
        input: { branch_id_or_ref: LEGACY_VALID_REF },
      });
      expect(dbConfig.resolves).toHaveLength(0);
      expect(generator.calls[0]?.conn.user).toBe("branch_user");
      expect(generator.calls[0]?.conn.password).toBe("branch-password");
    });
  });

  it.live("fails clearly when preview branch config does not include DB credentials", () => {
    const { layer } = setup({
      args: ["gen", "types", "--lang", "python", "--project-id", LEGACY_VALID_REF],
      getProject: () => Effect.fail(statusApiError(404, `{"message":"Preview branch not found"}`)),
      getABranchConfig: ({ branch_id_or_ref }) =>
        Effect.succeed({
          ref: branch_id_or_ref,
          postgres_version: "15.1",
          postgres_engine: "15",
          release_channel: "ga",
          status: "ACTIVE_HEALTHY",
          db_host: "127.0.0.1",
          db_port: 5432,
          jwt_secret: "secret",
        }),
    });

    return Effect.gen(function* () {
      const exit = yield* legacyGenTypes(
        defaultFlags({
          projectId: Option.some(LEGACY_VALID_REF),
          lang: "python",
        }),
      ).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain("Preview branch database credentials are unavailable");
      }
    });
  });

  it.live("surfaces a non-404 project lookup failure for non-TypeScript generation", () => {
    const { layer, dbConfig, generator } = setup({
      args: ["gen", "types", "--lang", "go", "--project-id", LEGACY_VALID_REF],
      getProject: () => Effect.fail(statusApiError(500, `{"message":"boom"}`)),
    });

    return Effect.gen(function* () {
      const exit = yield* legacyGenTypes(
        defaultFlags({
          projectId: Option.some(LEGACY_VALID_REF),
          lang: "go",
        }),
      ).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        // Only a 404 routes to the preview-branch fallback; any other status
        // surfaces as the mapped project database config error.
        expect(String(exit.cause)).toContain("unexpected project database config status 500");
      }
      expect(dbConfig.resolves).toHaveLength(0);
      expect(generator.calls).toHaveLength(0);
    });
  });

  it.live("maps project lookup network failures for non-TypeScript generation", () => {
    const { layer } = setup({
      args: ["gen", "types", "--lang", "go", "--project-id", LEGACY_VALID_REF],
      getProject: () => Effect.fail(new Error("network error")),
    });

    return Effect.gen(function* () {
      const exit = yield* legacyGenTypes(
        defaultFlags({
          projectId: Option.some(LEGACY_VALID_REF),
          lang: "go",
        }),
      ).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain("failed to get project database config");
      }
    });
  });

  it.live("maps preview branch config network failures after the project 404", () => {
    const { layer } = setup({
      args: ["gen", "types", "--lang", "python", "--project-id", LEGACY_VALID_REF],
      getProject: () => Effect.fail(statusApiError(404, `{"message":"Not found"}`)),
      getABranchConfig: () => Effect.fail(new Error("network error")),
    });

    return Effect.gen(function* () {
      const exit = yield* legacyGenTypes(
        defaultFlags({
          projectId: Option.some(LEGACY_VALID_REF),
          lang: "python",
        }),
      ).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain("failed to get preview branch database config");
      }
    });
  });

  it.live("maps preview branch config status failures after the project 404", () => {
    const { layer, generator } = setup({
      args: ["gen", "types", "--lang", "python", "--project-id", LEGACY_VALID_REF],
      getProject: () => Effect.fail(statusApiError(404, `{"message":"Not found"}`)),
      getABranchConfig: () => Effect.fail(statusApiError(500, `{"message":"boom"}`)),
    });

    return Effect.gen(function* () {
      const exit = yield* legacyGenTypes(
        defaultFlags({
          projectId: Option.some(LEGACY_VALID_REF),
          lang: "python",
        }),
      ).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain(
          "unexpected preview branch database config status 500",
        );
      }
      expect(generator.calls).toHaveLength(0);
    });
  });

  it.live("skips preview branch pooler fallback when no primary pooler is configured", () => {
    const { layer, generator } = setup({
      args: ["gen", "types", "--lang", "python", "--project-id", LEGACY_VALID_REF],
      generatorResults: [Effect.fail(IPV6_CONNECT_FAILURE)],
      getProject: () => Effect.fail(statusApiError(404, `{"message":"Not found"}`)),
      getABranchConfig: ({ branch_id_or_ref }) =>
        Effect.succeed({
          ref: branch_id_or_ref,
          postgres_version: "15.1",
          postgres_engine: "15",
          release_channel: "ga",
          status: "ACTIVE_HEALTHY",
          db_host: `db.${branch_id_or_ref}.supabase.co`,
          db_port: 5432,
          db_user: "branch_user",
          db_pass: "branch-password",
          jwt_secret: "secret",
        }),
      getPoolerConfig: () => Effect.succeed([]),
    });

    return Effect.gen(function* () {
      const exit = yield* legacyGenTypes(
        defaultFlags({
          projectId: Option.some(LEGACY_VALID_REF),
          lang: "python",
        }),
      ).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(generator.calls).toHaveLength(1);
    });
  });

  it.live("maps project type generation status failures", () => {
    const { layer } = setup({
      generateTypescriptTypes: () => Effect.fail(statusApiError(500, "generation broke")),
    });

    return Effect.gen(function* () {
      const exit = yield* legacyGenTypes(
        defaultFlags({
          projectId: Option.some(LEGACY_VALID_REF),
        }),
      ).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain("failed to retrieve generated types");
      }
    });
  });

  it.live("maps project type generation network failures", () => {
    const { layer } = setup({
      generateTypescriptTypes: () => Effect.fail(new Error("network error")),
    });

    return Effect.gen(function* () {
      const exit = yield* legacyGenTypes(
        defaultFlags({
          projectId: Option.some(LEGACY_VALID_REF),
        }),
      ).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain(
          "failed to get typescript types: Error: network error",
        );
      }
    });
  });

  it.live("generates locally through the native generator", () => {
    const workdir = mkdtempSync(join(tmpdir(), "supabase-gen-types-local-"));
    writeConfig(
      workdir,
      [
        'project_id = "demo"',
        "",
        "[api]",
        "port = 54321",
        'schemas = ["public", "custom"]',
        "",
        "[db]",
        "port = 54322",
      ].join("\n"),
    );

    const { layer, out, child, linkedProjectCache, generator, dbConfig } = setup({
      workdir,
      generatorOutput: "export type Database = {};",
    });

    return Effect.gen(function* () {
      yield* legacyGenTypes(defaultFlags({ local: true })).pipe(Effect.provide(layer));

      expect(out.stderrText).toContain("Connecting to 127.0.0.1 54322");
      expect(out.stdoutText).toBe("export type Database = {};\n");
      // The only remaining subprocess is the local-stack `container inspect`;
      // generation itself is in-process.
      expect(child.spawned).toEqual([
        { command: "docker", args: ["container", "inspect", "supabase_db_demo"] },
      ]);
      expect(generator.calls).toHaveLength(1);
      expect(generator.calls[0]?.conn).toEqual({
        host: "127.0.0.1",
        port: 54322,
        user: "postgres",
        password: "postgres",
        database: "postgres",
      });
      expect(generator.calls[0]?.isLocal).toBe(true);
      expect(generator.calls[0]?.includedSchemas).toEqual(["public", "custom"]);
      // The local path never consults the DB config resolver.
      expect(dbConfig.resolves).toHaveLength(0);
      // The local/db-url paths have no project ref, so they must not
      // populate the linked-project cache.
      expect(linkedProjectCache.cached).toBe(false);
    });
  });

  it.live("prints already-terminated native output with exactly one trailing newline", () => {
    const workdir = mkdtempSync(join(tmpdir(), "supabase-gen-types-newline-"));
    writeConfig(
      workdir,
      ['project_id = "demo"', "", "[api]", 'schemas = ["public"]', "", "[db]", "port = 54322"].join(
        "\n",
      ),
    );

    const { layer, out } = setup({
      workdir,
      generatorOutput: "export type Database = {};\n\n",
    });

    return Effect.gen(function* () {
      yield* legacyGenTypes(defaultFlags({ local: true })).pipe(Effect.provide(layer));

      expect(out.stdoutText).toBe("export type Database = {};\n");
    });
  });

  it.live("falls back to podman when the docker executable is missing for local generation", () => {
    const workdir = mkdtempSync(join(tmpdir(), "supabase-gen-types-local-podman-"));
    writeConfig(
      workdir,
      ['project_id = "demo"', "", "[api]", 'schemas = ["public"]', "", "[db]", "port = 54322"].join(
        "\n",
      ),
    );
    const child = mockDockerMissingChildProcessSpawner([{ exitCode: 0 }]);
    const { layer, out } = setup({
      workdir,
      childLayer: child.layer,
      generatorOutput: "export type Database = {};",
    });

    return Effect.gen(function* () {
      yield* legacyGenTypes(defaultFlags({ local: true })).pipe(Effect.provide(layer));

      expect(out.stdoutText).toContain("export type Database = {};");
      expect(child.spawned).toEqual([
        { command: "docker", args: ["container", "inspect", "supabase_db_demo"] },
        { command: "podman", args: ["container", "inspect", "supabase_db_demo"] },
      ]);
    });
  });

  it.live("uses sanitized local docker ids and env-backed local db passwords", () => {
    const workdir = mkdtempSync(join(tmpdir(), "supabase-gen-types-local-sanitized-"));
    writeConfig(
      workdir,
      [
        'project_id = "..demo project with spaces"',
        "",
        "[api]",
        'schemas = ["public"]',
        "",
        "[db]",
        "port = 54322",
      ].join("\n"),
    );

    const previousPassword = process.env["SUPABASE_DB_PASSWORD"];
    process.env["SUPABASE_DB_PASSWORD"] = "secret-password";
    const { layer, child, generator } = setup({ workdir });

    return Effect.gen(function* () {
      try {
        yield* legacyGenTypes(defaultFlags({ local: true })).pipe(Effect.provide(layer));

        expect(child.spawned[0]).toEqual({
          command: "docker",
          args: ["container", "inspect", "supabase_db_demo_project_with_spaces"],
        });
        expect(generator.calls[0]?.conn.password).toBe("secret-password");
      } finally {
        if (previousPassword === undefined) {
          delete process.env["SUPABASE_DB_PASSWORD"];
        } else {
          process.env["SUPABASE_DB_PASSWORD"] = previousPassword;
        }
      }
    });
  });

  it.live("forces v9 compat when rest-version reports v9 on a modern database", () => {
    const workdir = mkdtempSync(join(tmpdir(), "supabase-gen-types-local-v9-"));
    writeConfig(
      workdir,
      [
        'project_id = "demo"',
        "",
        "[api]",
        'schemas = ["public"]',
        "",
        "[db]",
        "major_version = 15",
        "port = 54322",
      ].join("\n"),
    );
    writeTempFile(workdir, "rest-version", "v9.0.1\n");

    const { layer, generator } = setup({ workdir });

    return Effect.gen(function* () {
      yield* legacyGenTypes(defaultFlags({ local: true })).pipe(Effect.provide(layer));

      expect(generator.calls[0]?.postgrestV9Compat).toBe(true);
    });
  });

  it.live("ignores rest-version v9 marker on databases older than 15", () => {
    const workdir = mkdtempSync(join(tmpdir(), "supabase-gen-types-local-pg14-"));
    writeConfig(
      workdir,
      [
        'project_id = "demo"',
        "",
        "[api]",
        'schemas = ["public"]',
        "",
        "[db]",
        "major_version = 14",
        "port = 54322",
      ].join("\n"),
    );
    writeTempFile(workdir, "rest-version", "v9.0.1\n");

    const { layer, generator } = setup({ workdir });

    return Effect.gen(function* () {
      yield* legacyGenTypes(defaultFlags({ local: true })).pipe(Effect.provide(layer));

      expect(generator.calls[0]?.postgrestV9Compat).toBe(false);
    });
  });

  it.live("prefers explicit --schema over config schemas for local generation", () => {
    const workdir = mkdtempSync(join(tmpdir(), "supabase-gen-types-local-schema-"));
    writeConfig(
      workdir,
      [
        'project_id = "demo"',
        "",
        "[api]",
        'schemas = ["public", "custom"]',
        "",
        "[db]",
        "port = 54322",
      ].join("\n"),
    );
    const { layer, generator } = setup({ workdir });

    return Effect.gen(function* () {
      yield* legacyGenTypes(defaultFlags({ local: true, schema: ["auth", "storage"] })).pipe(
        Effect.provide(layer),
      );

      expect(generator.calls[0]?.includedSchemas).toEqual(["auth", "storage"]);
    });
  });

  it.live("falls back to the workdir basename when config has no project_id", () => {
    const workdir = mkdtempSync(join(tmpdir(), "supabase-gen-types-local-noid-"));
    writeConfig(workdir, ["[api]", 'schemas = ["public"]', "", "[db]", "port = 54322"].join("\n"));
    const { layer, child } = setup({ workdir });

    return Effect.gen(function* () {
      yield* legacyGenTypes(defaultFlags({ local: true })).pipe(Effect.provide(layer));

      const inspectId = child.spawned[0]?.args[2] ?? "";
      expect(inspectId.startsWith("supabase_db_")).toBe(true);
      expect(inspectId).not.toBe("supabase_db_demo");
    });
  });

  it.live("generates from --project-id without a local project config", () => {
    const workdir = mkdtempSync(join(tmpdir(), "supabase-gen-types-pid-no-config-"));
    const { layer, api } = setup({ workdir, skipConfig: true, projectTypes: "ok" });

    return Effect.gen(function* () {
      yield* legacyGenTypes(defaultFlags({ projectId: Option.some(LEGACY_VALID_REF) })).pipe(
        Effect.provide(layer),
      );

      expect(api.requests[0]).toEqual({
        method: "generateTypescriptTypes",
        input: { ref: LEGACY_VALID_REF, included_schemas: "public" },
      });
    });
  });

  it.live("resolves the linked fallback without a local project config", () => {
    const workdir = mkdtempSync(join(tmpdir(), "supabase-gen-types-fallback-no-config-"));
    const { layer, api } = setup({
      workdir,
      skipConfig: true,
      projectId: Option.some(LEGACY_VALID_REF),
      projectTypes: "ok",
    });

    return Effect.gen(function* () {
      yield* legacyGenTypes(defaultFlags()).pipe(Effect.provide(layer));

      expect(api.requests[0]).toEqual({
        method: "generateTypescriptTypes",
        input: { ref: LEGACY_VALID_REF, included_schemas: "public" },
      });
    });
  });

  it.live("rejects a non-typescript language passed after a -- separator", () => {
    const { layer } = setup({ args: ["gen", "types", "--", "go"] });

    return Effect.gen(function* () {
      const exit = yield* legacyGenTypes(defaultFlags()).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain("use --lang flag to specify the typegen language");
      }
    });
  });

  it.live("treats a trailing -- with no operand as no positional language", () => {
    const { layer, api } = setup({
      args: ["gen", "types", "--"],
      projectId: Option.some(LEGACY_VALID_REF),
      projectTypes: "ok",
    });

    return Effect.gen(function* () {
      yield* legacyGenTypes(defaultFlags()).pipe(Effect.provide(layer));
      expect(api.requests).toHaveLength(1);
    });
  });

  it.live("treats a positional after a valueless long flag as the language", () => {
    const { layer } = setup({ args: ["gen", "types", "--local", "go"] });

    return Effect.gen(function* () {
      const exit = yield* legacyGenTypes(defaultFlags()).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain("use --lang flag to specify the typegen language");
      }
    });
  });

  it.live("prefers explicit --schema on the linked path", () => {
    const { layer, api } = setup({
      projectId: Option.some(LEGACY_VALID_REF),
      projectTypes: "ok",
    });

    return Effect.gen(function* () {
      yield* legacyGenTypes(defaultFlags({ linked: true, schema: ["auth"] })).pipe(
        Effect.provide(layer),
      );
      expect(api.requests[0]).toEqual({
        method: "generateTypescriptTypes",
        input: { ref: LEGACY_VALID_REF, included_schemas: "auth" },
      });
    });
  });

  it.live("prefers explicit --schema on the linked fallback path", () => {
    const { layer, api } = setup({
      projectId: Option.some(LEGACY_VALID_REF),
      projectTypes: "ok",
    });

    return Effect.gen(function* () {
      yield* legacyGenTypes(defaultFlags({ schema: ["auth"] })).pipe(Effect.provide(layer));
      expect(api.requests[0]).toEqual({
        method: "generateTypescriptTypes",
        input: { ref: LEGACY_VALID_REF, included_schemas: "auth" },
      });
    });
  });

  it.live("fails with not-running parity when the local db container is missing", () => {
    const workdir = mkdtempSync(join(tmpdir(), "supabase-gen-types-local-missing-"));
    writeConfig(
      workdir,
      ['project_id = "demo"', "", "[api]", 'schemas = ["public"]', "", "[db]", "port = 54321"].join(
        "\n",
      ),
    );
    const { layer } = setup({
      workdir,
      childExitCode: 1,
      childStderr: ["Error: No such container: supabase_db_demo"],
    });

    return Effect.gen(function* () {
      const exit = yield* legacyGenTypes(defaultFlags({ local: true })).pipe(
        Effect.provide(layer),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain("supabase start is not running.");
      }
    });
  });

  it.live("keeps not-running parity when podman reports the local db container is missing", () => {
    const workdir = mkdtempSync(join(tmpdir(), "supabase-gen-types-local-podman-missing-"));
    writeConfig(
      workdir,
      ['project_id = "demo"', "", "[api]", 'schemas = ["public"]', "", "[db]", "port = 54321"].join(
        "\n",
      ),
    );
    const child = mockDockerMissingChildProcessSpawner([
      {
        exitCode: 1,
        stderr: ['Error: inspecting object: no such container "supabase_db_demo"'],
      },
    ]);
    const { layer } = setup({
      workdir,
      childLayer: child.layer,
    });

    return Effect.gen(function* () {
      const exit = yield* legacyGenTypes(defaultFlags({ local: true })).pipe(
        Effect.provide(layer),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain("supabase start is not running.");
      }
      expect(child.spawned).toEqual([
        { command: "docker", args: ["container", "inspect", "supabase_db_demo"] },
        { command: "podman", args: ["container", "inspect", "supabase_db_demo"] },
      ]);
    });
  });

  it.live(
    "preserves inspect failure details when local db inspection fails for other reasons",
    () => {
      const workdir = mkdtempSync(join(tmpdir(), "supabase-gen-types-local-inspect-error-"));
      writeConfig(
        workdir,
        [
          'project_id = "demo"',
          "",
          "[api]",
          'schemas = ["public"]',
          "",
          "[db]",
          "port = 54321",
        ].join("\n"),
      );
      const { layer } = setup({
        workdir,
        childExitCode: 1,
        childStderr: ["Cannot connect to the Docker daemon"],
      });

      return Effect.gen(function* () {
        const exit = yield* legacyGenTypes(defaultFlags({ local: true })).pipe(
          Effect.provide(layer),
          Effect.exit,
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(String(exit.cause)).toContain(
            "failed to inspect service: Cannot connect to the Docker daemon",
          );
        }
      });
    },
  );

  it.live("generates locally with Go defaults when supabase/config.toml is missing", () => {
    const workdir = mkdtempSync(join(tmpdir(), "supabase-gen-types-local-no-config-"));
    const { layer, out, child, generator } = setup({
      workdir,
      skipConfig: true,
      generatorOutput: "generated",
    });

    return Effect.gen(function* () {
      yield* legacyGenTypes(defaultFlags({ local: true })).pipe(Effect.provide(layer));

      const projectId = basename(workdir);
      expect(child.spawned[0]).toEqual({
        command: "docker",
        args: ["container", "inspect", localDbContainerId(projectId)],
      });
      expect(generator.calls[0]?.conn.host).toBe("127.0.0.1");
      expect(generator.calls[0]?.conn.port).toBe(54322);
      expect(generator.calls[0]?.includedSchemas).toEqual(["public", "graphql_public"]);
      expect(out.stdoutText).toContain("generated");
    });
  });

  it.live("honors local dotenv overrides when supabase/config.toml is missing", () => {
    const workdir = mkdtempSync(join(tmpdir(), "supabase-gen-types-local-no-config-env-"));
    const supabaseDir = join(workdir, "supabase");
    mkdirSync(supabaseDir, { recursive: true });
    writeFileSync(
      join(supabaseDir, ".env"),
      [
        "SUPABASE_PROJECT_ID=configless-env-project",
        "SUPABASE_DB_PORT=55432",
        "SUPABASE_DB_PASSWORD=remote-password",
        "SUPABASE_API_SCHEMAS=private,graphql_public",
        "SUPABASE_SERVICES_HOSTNAME=host.docker.internal",
        "",
      ].join("\n"),
    );
    const { layer, out, child, generator } = setup({
      workdir,
      skipConfig: true,
      generatorOutput: "generated",
    });

    return Effect.gen(function* () {
      yield* legacyGenTypes(defaultFlags({ local: true })).pipe(Effect.provide(layer));

      expect(child.spawned[0]).toEqual({
        command: "docker",
        args: ["container", "inspect", localDbContainerId("configless-env-project")],
      });
      expect(generator.calls[0]?.conn.host).toBe("host.docker.internal");
      expect(generator.calls[0]?.conn.port).toBe(55432);
      // SUPABASE_DB_PASSWORD is deliberately excluded when applying project
      // env, so the local connection keeps the default password.
      expect(generator.calls[0]?.conn.password).toBe("postgres");
      expect(generator.calls[0]?.includedSchemas).toEqual(["public", "private", "graphql_public"]);
      expect(out.stdoutText).toContain("generated");
    });
  });

  it.live("reports a generic inspect failure when docker emits no stderr", () => {
    const workdir = mkdtempSync(join(tmpdir(), "supabase-gen-types-local-empty-stderr-"));
    writeConfig(
      workdir,
      ['project_id = "demo"', "", "[api]", 'schemas = ["public"]', "", "[db]", "port = 54321"].join(
        "\n",
      ),
    );
    const { layer } = setup({ workdir, childExitCode: 1 });

    return Effect.gen(function* () {
      const exit = yield* legacyGenTypes(defaultFlags({ local: true })).pipe(
        Effect.provide(layer),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain("failed to inspect service");
        expect(String(exit.cause)).not.toContain("failed to inspect service:");
      }
    });
  });

  it.live("defaults schemas to public for a db-url run without a project config", () => {
    const workdir = mkdtempSync(join(tmpdir(), "supabase-gen-types-dburl-no-config-"));
    const dbUrl = "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
    const { layer, dbConfig, generator } = setup({
      workdir,
      skipConfig: true,
    });

    return Effect.gen(function* () {
      yield* legacyGenTypes(defaultFlags({ dbUrl: Option.some(dbUrl) })).pipe(
        Effect.provide(layer),
      );

      expect(dbConfig.resolves).toHaveLength(1);
      expect(dbConfig.resolves[0]?.connType).toBe("db-url");
      expect(
        dbConfig.resolves[0] !== undefined
          ? Option.getOrUndefined(dbConfig.resolves[0].dbUrl)
          : undefined,
      ).toBe(dbUrl);
      expect(generator.calls[0]?.includedSchemas).toEqual(["public"]);
    });
  });

  it.live("surfaces generation failures after local db inspection succeeds", () => {
    const workdir = mkdtempSync(join(tmpdir(), "supabase-gen-types-local-run-error-"));
    writeConfig(
      workdir,
      ['project_id = "demo"', "", "[api]", 'schemas = ["public"]', "", "[db]", "port = 54322"].join(
        "\n",
      ),
    );
    const { layer, child } = setup({
      workdir,
      generatorResults: [
        Effect.fail(
          new LegacyGenTypesMetadataError({
            message: "failed to introspect database: relation does not exist",
          }),
        ),
      ],
    });

    return Effect.gen(function* () {
      const exit = yield* legacyGenTypes(defaultFlags({ local: true })).pipe(
        Effect.provide(layer),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain(
          "failed to introspect database: relation does not exist",
        );
      }
      expect(child.spawned).toHaveLength(1);
    });
  });

  it.live("runs the native generator for db-url generation", () => {
    const dbUrl = "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
    const { layer, out, dbConfig, generator, linkedProjectCache } = setup({
      generatorOutput: "generated",
    });

    return Effect.gen(function* () {
      yield* legacyGenTypes(
        defaultFlags({
          dbUrl: Option.some(dbUrl),
          lang: "swift",
          schema: ["public"],
          swiftAccessControl: "public",
          postgrestV9Compat: true,
          queryTimeout: "20s",
        }),
      ).pipe(Effect.provide(layer));

      expect(out.stderrText).toContain("Connecting to 127.0.0.1 5432");
      expect(dbConfig.resolves).toHaveLength(1);
      expect(dbConfig.resolves[0]?.connType).toBe("db-url");
      expect(generator.calls[0]?.lang).toBe("swift");
      expect(generator.calls[0]?.swiftAccessControl).toBe("public");
      expect(generator.calls[0]?.postgrestV9Compat).toBe(true);
      expect(generator.calls[0]?.queryTimeoutSeconds).toBe(20);
      expect(generator.calls[0]?.isLocal).toBe(false);
      expect(out.stdoutText).toBe("generated\n");
      expect(linkedProjectCache.cached).toBe(false);
    });
  });

  it.live("passes the resolver's local detection through for a local db-url", () => {
    const dbUrl = "postgresql://postgres@127.0.0.1:54322/postgres";
    const { layer, generator } = setup({
      dbConfigResolve: () =>
        Effect.succeed({
          conn: {
            host: "127.0.0.1",
            port: 54322,
            user: "postgres",
            password: "postgres",
            database: "postgres",
          },
          isLocal: true,
        }),
    });

    return Effect.gen(function* () {
      yield* legacyGenTypes(defaultFlags({ dbUrl: Option.some(dbUrl) })).pipe(
        Effect.provide(layer),
      );

      expect(generator.calls[0]?.isLocal).toBe(true);
    });
  });

  it.live("rejects legacy positional non-typescript without an explicit lang flag", () => {
    const { layer } = setup({
      args: ["gen", "types", "go"],
    });

    return Effect.gen(function* () {
      const exit = yield* legacyGenTypes(defaultFlags()).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain("use --lang flag to specify the typegen language");
      }
    });
  });

  it.live(
    "rejects legacy positional non-typescript after consuming short flags with values",
    () => {
      const { layer } = setup({
        args: ["gen", "types", "-o", "json", "go"],
        goOutput: Option.some("json"),
      });

      return Effect.gen(function* () {
        const exit = yield* legacyGenTypes(defaultFlags()).pipe(Effect.provide(layer), Effect.exit);

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(String(exit.cause)).toContain("use --lang flag to specify the typegen language");
        }
      });
    },
  );

  it.live("allows legacy positional non-typescript when --lang is explicitly set", () => {
    const dbUrl = "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
    const { layer, generator } = setup({
      args: ["gen", "types", "go", "--lang", "go"],
    });

    return Effect.gen(function* () {
      yield* legacyGenTypes(
        defaultFlags({
          dbUrl: Option.some(dbUrl),
          lang: "go",
          schema: ["public"],
        }),
      ).pipe(Effect.provide(layer));

      expect(generator.calls[0]?.lang).toBe("go");
    });
  });
});
