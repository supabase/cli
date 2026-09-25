import { tmpdir } from "node:os";
import { describe, expect, it } from "@effect/vitest";
import { BunPath, BunServices } from "@effect/platform-bun";
import type {
  V1CreateLoginRoleOutput,
  V1GetABranchConfigOutput,
  V1GetPoolerConfigOutput,
  V1GetProjectOutput,
} from "@supabase/api/effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import {
  Cause,
  ConfigProvider,
  Data,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  PlatformError,
  Predicate,
  Sink,
  Stdio,
  Stream,
} from "effect";
import { DnsResolverFlag, OutputFlag } from "../../../command-internal/global-flags.ts";
import { CommandPlatformApiFactory } from "../../../auth/command-platform-api-factory.service.ts";
import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { mockOutput } from "../../../../tests/helpers/mocks.ts";
import {
  buildTestRuntime,
  VALID_REF,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockCommandPlatformApiService,
  mockTelemetryStateTracked,
} from "../../../../tests/helpers/command-mocks.ts";
import type { PgConnInput } from "../../../command-internal/db-connection.service.ts";
import type { DbConnectError } from "../../../command-internal/db-connection.errors.ts";
import { toConnectError } from "../../../command-internal/db-connection.sql-pg.layer.ts";
import type { DbConfigError } from "../../../command-internal/db-config.service.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import { DbConfigLoadError } from "../../../command-internal/db-config.errors.ts";
import type { DbConfigFlags, ResolvedDbConfig } from "../../../command-internal/db-config.types.ts";
import type { GenTypesFlags } from "./types.command.ts";
import { GenTypesLocalDbInspectError } from "./types.errors.ts";
import { genTypes } from "./types.handler.ts";
import { localDbContainerId, parseQueryTimeoutMillis, rootCaBundle } from "./types.shared.ts";
import { stackBackendLayer } from "../../../command-internal/stack-backend.ts";
import {
  GenTypesGenerationError,
  GenTypesGenerator,
  type GenTypesGenerateInput,
} from "./types.generator.service.ts";

const path = Effect.runSync(Effect.provide(Path.Path, BunPath.layer));

const makeWorkdir = Effect.fnUntraced(function* (prefix: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix });
});

const writeConfig = Effect.fnUntraced(function* (workdir: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const supabaseDir = path.join(workdir, "supabase");
  yield* fs.makeDirectory(supabaseDir, { recursive: true });
  yield* fs.writeFileString(path.join(supabaseDir, "config.toml"), contents);
});

const writeTempFile = Effect.fnUntraced(function* (
  workdir: string,
  name: string,
  contents: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const tempDir = path.join(workdir, "supabase", ".temp");
  yield* fs.makeDirectory(tempDir, { recursive: true });
  yield* fs.writeFileString(path.join(tempDir, name), contents);
});

const makeDirectory = Effect.fnUntraced(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(dir, { recursive: true });
});

const writeFile = Effect.fnUntraced(function* (file: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(file, contents);
});

const ensureDefaultConfig = Effect.fnUntraced(function* (workdir: string) {
  const fs = yield* FileSystem.FileSystem;
  if (yield* fs.exists(path.join(workdir, "supabase", "config.toml"))) {
    return;
  }
  yield* writeConfig(workdir, ['project_id = "demo"', "", "[api]", "schemas = []"].join("\n"));
});

/** A stubbed Management API call that the scenario under test must not reach, or a canned failure. */
class ApiCallFailure extends Data.TaggedError("ApiCallFailure")<{
  readonly message: string;
}> {}

function defaultFlags(overrides: Partial<GenTypesFlags> = {}): GenTypesFlags {
  return {
    local: false,
    linked: false,
    dbUrl: Option.none(),
    projectId: Option.none(),
    lang: "typescript" as const,
    schema: [],
    "swift-access-control": "internal" as const,
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

function remoteResolvedConfig(conn: PgConnInput, ref = VALID_REF): ResolvedDbConfig {
  return { conn, isLocal: false, ref: Option.some(ref) };
}

function localResolvedConfig(conn: PgConnInput): ResolvedDbConfig {
  return { conn, isLocal: true, ref: Option.none() };
}

function mockDbConfigResolver(
  opts: {
    readonly resolve?: (flags: DbConfigFlags) => Effect.Effect<ResolvedDbConfig, DbConfigError>;
    readonly poolerFallback?: Option.Option<PgConnInput>;
    readonly poolerFallbackFails?: boolean;
  } = {},
) {
  const resolves: Array<DbConfigFlags> = [];
  const poolerFallbacks: Array<DbConfigFlags> = [];
  const layer = Layer.succeed(DbConfigResolver, {
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
        ? Effect.fail(new DbConfigLoadError({ message: "pooler fallback failed" }))
        : Effect.sync(() => {
            poolerFallbacks.push(flags);
            return opts.poolerFallback ?? Option.none<PgConnInput>();
          }),
  });
  return { layer, resolves, poolerFallbacks };
}

/** Records `GenTypesGenerator.generate` invocations and answers each with a canned output. */
function mockGenTypesGenerator(
  opts: {
    readonly generate?: (
      input: GenTypesGenerateInput,
      callIndex: number,
    ) => Effect.Effect<string, GenTypesGenerationError | DbConnectError>;
    readonly output?: string;
  } = {},
) {
  const calls: Array<GenTypesGenerateInput> = [];
  const layer = Layer.succeed(GenTypesGenerator, {
    generate: (input) =>
      Effect.suspend(() => {
        calls.push(input);
        return (
          opts.generate?.(input, calls.length - 1) ?? Effect.succeed(opts.output ?? "generated")
        );
      }),
  });
  return {
    layer,
    get calls() {
      return calls;
    },
  };
}

/** One `GenTypesGenerator.generate` outcome per attempt — models a failing then a retried call. */
function sequentialGenerator(
  steps: ReadonlyArray<() => Effect.Effect<string, GenTypesGenerationError | DbConnectError>>,
) {
  return mockGenTypesGenerator({
    generate: (_input, index) =>
      (steps[Math.min(index, steps.length - 1)] ?? (() => Effect.succeed("generated")))(),
  });
}

const DIAL_FAILURE_CONN: PgConnInput = {
  host: "db.example.supabase.co",
  port: 5432,
  user: "postgres",
  password: "pw",
  database: "postgres",
};

/**
 * A `DbConnectError` shaped exactly as `toConnectError` builds one from a real ENETUNREACH dial
 * failure against an IPv6 literal — the connection layer no longer forwards the raw driver cause,
 * so the pooler-fallback classifier must key off `DbConnectError.ipv6Unreachable` instead.
 */
function ipv6Failure(): DbConnectError {
  return toConnectError(
    DIAL_FAILURE_CONN,
    false,
    Object.assign(new Error("connect ENETUNREACH 2600:1f18::1:5432"), {
      code: "ENETUNREACH",
      address: "2600:1f18::1",
      port: 5432,
    }),
  );
}

/**
 * A `DbConnectError` for an ENOTFOUND (DNS miss) dial failure — carries no IPv6 literal in its
 * rendered message, so only the structured `code` classification `toConnectError` performs at the
 * connection boundary (not a message-text fallback) can mark it IPv6-pooler-retryable.
 */
function enotfoundFailure(): DbConnectError {
  return toConnectError(
    DIAL_FAILURE_CONN,
    false,
    Object.assign(new Error("getaddrinfo ENOTFOUND db.example.supabase.co"), {
      code: "ENOTFOUND",
    }),
  );
}

function nonIpv6Failure(lang = "go") {
  return new GenTypesGenerationError({
    message: `failed to generate ${lang} types: permission denied for schema public`,
  });
}

/**
 * A single `container inspect` spawn — the only subprocess `gen types --local` still shells out
 * to (via `assertLocalDbRunning`) now that generation itself runs in-process. `dockerMissing`
 * fails the `docker` attempt with a not-found error so the fallback `podman` attempt is exercised.
 */
function mockInspectSpawner(
  opts: {
    readonly exitCode?: number;
    readonly stderr?: ReadonlyArray<string>;
    readonly dockerMissing?: boolean;
  } = {},
) {
  const calls: Array<{
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly env: Readonly<Record<string, string | undefined>> | undefined;
    readonly extendEnv: boolean | undefined;
  }> = [];
  const encoder = new TextEncoder();

  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        const isStandard = ChildProcess.isStandardCommand(command);
        const cmd = isStandard ? command.command : "";
        const args = isStandard ? command.args : [];
        const options = isStandard ? command.options : undefined;
        calls.push({ command: cmd, args, env: options?.env, extendEnv: options?.extendEnv });

        if (opts.dockerMissing === true && cmd === "docker") {
          return yield* PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            description: "docker not found",
          });
        }

        const stderrBytes = (opts.stderr ?? []).map((line) => encoder.encode(`${line}\n`));

        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(4000 + calls.length),
          stdout: Stream.empty,
          stderr: Stream.fromIterable(stderrBytes),
          all: Stream.empty,
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(opts.exitCode ?? 0)),
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
    get calls() {
      return calls;
    },
  };
}

type BranchConfig = typeof V1GetABranchConfigOutput.Type;
type LoginRole = typeof V1CreateLoginRoleOutput.Type;
type PoolerConfig = typeof V1GetPoolerConfigOutput.Type;
type Project = typeof V1GetProjectOutput.Type;

const setup = Effect.fnUntraced(function* (
  opts: {
    readonly workdir?: string;
    readonly skipConfig?: boolean;
    readonly explicitWorkdir?: boolean;
    readonly projectId?: Option.Option<string>;
    readonly format?: "text" | "json" | "stream-json";
    readonly goOutput?: Option.Option<"env" | "pretty" | "json" | "toml" | "yaml">;
    readonly projectTypes?: string;
    readonly childExitCode?: number;
    readonly childStderr?: ReadonlyArray<string>;
    readonly childDockerMissing?: boolean;
    readonly args?: ReadonlyArray<string>;
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
      flags: DbConfigFlags,
    ) => Effect.Effect<ResolvedDbConfig, DbConfigError>;
    readonly poolerFallback?: Option.Option<PgConnInput>;
    readonly poolerFallbackFails?: boolean;
    readonly generator?: ReturnType<typeof mockGenTypesGenerator>;
    readonly generatorOutput?: string;
  } = {},
) {
  const workdir = opts.workdir ?? (yield* makeWorkdir("supabase-gen-types-"));
  if (!opts.skipConfig) {
    yield* ensureDefaultConfig(workdir);
  }
  const out = mockOutput({
    format: opts.format ?? "text",
    interactive: (opts.format ?? "text") === "text",
  });
  const telemetry = mockTelemetryStateTracked();
  const linkedProjectCache = mockLinkedProjectCacheTracked();
  const dbConfig = mockDbConfigResolver({
    resolve: opts.dbConfigResolve,
    poolerFallback: opts.poolerFallback,
    poolerFallbackFails: opts.poolerFallbackFails,
  });
  const child = mockInspectSpawner({
    exitCode: opts.childExitCode ?? 0,
    stderr: opts.childStderr,
    dockerMissing: opts.childDockerMissing,
  });
  const generator = opts.generator ?? mockGenTypesGenerator({ output: opts.generatorOutput });
  const api = mockCommandPlatformApiService({
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

  const runtime = buildTestRuntime({
    out,
    api,
    cliSettings: mockCommandSettings({
      workdir,
      explicitWorkdir: opts.explicitWorkdir ?? false,
      projectId: opts.projectId ?? Option.none(),
    }),
    telemetry: telemetry.layer,
    linkedProjectCache: linkedProjectCache.layer,
  });

  const layer = Layer.mergeAll(
    runtime,
    BunServices.layer,
    child.layer,
    Stdio.layerTest({ args: Effect.succeed(opts.args ?? ["gen", "types"]) }),
    Layer.succeed(OutputFlag, opts.goOutput ?? Option.none()),
    Layer.succeed(DnsResolverFlag, "native" as const),
    Layer.succeed(CommandPlatformApiFactory, {
      make: CommandPlatformApi.pipe(Effect.provide(api.layer)),
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
    child,
    api,
    generator,
    layer,
  };
});

const nonTypescriptProjectRefScenarios = [
  { lang: "go", stdout: "type PublicMovies struct {}" },
  { lang: "swift", stdout: "struct PublicMovies: Codable {}" },
  { lang: "python", stdout: "class PublicMovies(BaseModel):" },
] as const satisfies ReadonlyArray<{
  readonly lang: Exclude<GenTypesFlags["lang"], "typescript">;
  readonly stdout: string;
}>;

describe("gen types", () => {
  it.effect("accepts Go-style microsecond duration aliases", () =>
    Effect.gen(function* () {
      expect(yield* parseQueryTimeoutMillis(`15${"µ"}s`)).toBe(0.015);
      expect(yield* parseQueryTimeoutMillis(`15${"μ"}s`)).toBe(0.015);
    }),
  );

  it.live("generates typescript types from a project ref", () =>
    Effect.gen(function* () {
      const { layer, out, api, linkedProjectCache, telemetry } = yield* setup({
        projectId: Option.some(VALID_REF),
        projectTypes: "export type Database = {};",
      });
      yield* genTypes(defaultFlags()).pipe(Effect.provide(layer));

      expect(out.stdoutText).toBe("export type Database = {};");
      expect(api.requests).toEqual([
        {
          method: "generateTypescriptTypes",
          input: { ref: VALID_REF, included_schemas: "public" },
        },
      ]);
      expect(linkedProjectCache.cached).toBe(true);
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("generates types from the explicit --linked flag", () =>
    Effect.gen(function* () {
      const { layer, out, api, linkedProjectCache, telemetry } = yield* setup({
        projectId: Option.some(VALID_REF),
        projectTypes: "export type Database = {};",
      });
      yield* genTypes(defaultFlags({ linked: true })).pipe(Effect.provide(layer));

      expect(out.stdoutText).toBe("export type Database = {};");
      expect(api.requests).toEqual([
        {
          method: "generateTypescriptTypes",
          input: { ref: VALID_REF, included_schemas: "public" },
        },
      ]);
      expect(linkedProjectCache.cached).toBe(true);
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("uses explicit schemas for the management API path", () =>
    Effect.gen(function* () {
      const { layer, api } = yield* setup({
        projectTypes: "ok",
      });
      yield* genTypes(
        defaultFlags({
          projectId: Option.some(VALID_REF),
          schema: ["auth", "storage"],
        }),
      ).pipe(Effect.provide(layer));

      expect(api.requests[0]).toEqual({
        method: "generateTypescriptTypes",
        input: { ref: VALID_REF, included_schemas: "auth,storage" },
      });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live(
    "uses configured api schemas for explicit project-id generation when --schema is unset",
    () =>
      Effect.gen(function* () {
        const workdir = yield* makeWorkdir("supabase-gen-types-project-id-");
        yield* writeConfig(
          workdir,
          ['project_id = "demo"', "", "[api]", 'schemas = ["auth", "storage"]'].join("\n"),
        );
        const { layer, api } = yield* setup({
          workdir,
          projectTypes: "ok",
        });
        yield* genTypes(
          defaultFlags({
            projectId: Option.some(VALID_REF),
          }),
        ).pipe(Effect.provide(layer));

        expect(api.requests[0]).toEqual({
          method: "generateTypescriptTypes",
          input: { ref: VALID_REF, included_schemas: "public,auth,storage" },
        });
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("uses configured api schemas for resolved linked generation when --schema is unset", () =>
    Effect.gen(function* () {
      const workdir = yield* makeWorkdir("supabase-gen-types-linked-");
      yield* writeConfig(
        workdir,
        ['project_id = "demo"', "", "[api]", 'schemas = ["auth", "storage"]'].join("\n"),
      );
      const { layer, api } = yield* setup({
        workdir,
        projectId: Option.some(VALID_REF),
        projectTypes: "ok",
      });
      yield* genTypes(defaultFlags()).pipe(Effect.provide(layer));

      expect(api.requests[0]).toEqual({
        method: "generateTypescriptTypes",
        input: { ref: VALID_REF, included_schemas: "public,auth,storage" },
      });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live(
    "fails instead of picking up an ancestor project's configured api schemas when --workdir names a subdirectory with no config of its own",
    () =>
      Effect.gen(function* () {
        const root = yield* makeWorkdir("supabase-gen-types-ancestor-");
        yield* writeConfig(
          root,
          ['project_id = "demo"', "", "[api]", 'schemas = ["ancestor_only"]'].join("\n"),
        );
        const sub = path.join(root, "nested", "dir");
        yield* makeDirectory(sub);
        const { layer, api } = yield* setup({
          workdir: sub,
          skipConfig: true,
          explicitWorkdir: true,
          projectId: Option.some(VALID_REF),
          projectTypes: "ok",
        });
        const exit = yield* genTypes(defaultFlags({ projectId: Option.some(VALID_REF) })).pipe(
          Effect.provide(layer),
          Effect.exit,
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(String(exit.cause)).toContain(
            "--workdir/SUPABASE_WORKDIR is used exactly as given and no ancestor directory is searched",
          );
        }
        expect(api.requests).toHaveLength(0);
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live(
    "a defaulted workdir still picks up an ancestor project's configured api schemas from a subdirectory",
    () =>
      Effect.gen(function* () {
        const root = yield* makeWorkdir("supabase-gen-types-ancestor-");
        yield* writeConfig(
          root,
          ['project_id = "demo"', "", "[api]", 'schemas = ["ancestor_only"]'].join("\n"),
        );
        const sub = path.join(root, "nested", "dir");
        yield* makeDirectory(sub);
        const { layer, api } = yield* setup({
          workdir: sub,
          skipConfig: true,
          explicitWorkdir: false,
          projectId: Option.some(VALID_REF),
          projectTypes: "ok",
        });
        yield* genTypes(defaultFlags({ projectId: Option.some(VALID_REF) })).pipe(
          Effect.provide(layer),
        );

        expect(api.requests[0]).toEqual({
          method: "generateTypescriptTypes",
          input: { ref: VALID_REF, included_schemas: "public,ancestor_only" },
        });
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live(
    "an explicit --workdir naming a directory that does not exist at all fails before any config load",
    () =>
      Effect.gen(function* () {
        const missing = path.join(tmpdir(), "supabase-gen-types-does-not-exist", "nonexistent");
        const { layer, api } = yield* setup({
          workdir: missing,
          skipConfig: true,
          explicitWorkdir: true,
          projectId: Option.some(VALID_REF),
        });
        const exit = yield* genTypes(defaultFlags({ projectId: Option.some(VALID_REF) })).pipe(
          Effect.provide(layer),
          Effect.exit,
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(String(exit.cause)).toContain("GenTypesWorkdirError");
          expect(String(exit.cause)).toContain("failed to change workdir: chdir");
        }
        expect(api.requests).toHaveLength(0);
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live(
    "surfaces a real error message when supabase/config.toml is malformed, not the raw CliConfigParseError tag",
    () =>
      Effect.gen(function* () {
        const workdir = yield* makeWorkdir("supabase-gen-types-malformed-");
        yield* writeConfig(workdir, 'project_id = "unterminated\n');
        const { layer, api } = yield* setup({
          workdir,
          skipConfig: true,
          projectId: Option.some(VALID_REF),
        });
        const exit = yield* genTypes(defaultFlags({ projectId: Option.some(VALID_REF) })).pipe(
          Effect.provide(layer),
          Effect.exit,
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const rendered = String(exit.cause);
          expect(rendered).toContain("GenTypesParseConfigError");
          expect(rendered).toContain("failed to parse");
          expect(rendered).toContain(path.join("supabase", "config.toml"));
          expect(rendered).not.toContain("CliConfigParseError");
        }
        expect(api.requests).toHaveLength(0);
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("fails when no target resolves", () =>
    Effect.gen(function* () {
      const { layer } = yield* setup();
      const exit = yield* genTypes(defaultFlags()).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain(
          "Must specify one of --local, --linked, --project-id, or --db-url",
        );
        expect(
          Option.exists(
            Cause.findErrorOption(exit.cause),
            Predicate.isTagged("GenTypesFlagUsageError"),
          ),
        ).toBe(true);
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("generates from --project-id without a local project config", () =>
    Effect.gen(function* () {
      const workdir = yield* makeWorkdir("supabase-gen-types-pid-no-config-");
      const { layer, out, api } = yield* setup({ workdir, skipConfig: true, projectTypes: "ok" });
      yield* genTypes(defaultFlags({ projectId: Option.some(VALID_REF) })).pipe(
        Effect.provide(layer),
      );

      expect(api.requests[0]).toEqual({
        method: "generateTypescriptTypes",
        input: { ref: VALID_REF, included_schemas: "public" },
      });
      expect(out.stderrText).not.toContain("unformatted");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("resolves the linked fallback without a local project config", () =>
    Effect.gen(function* () {
      const workdir = yield* makeWorkdir("supabase-gen-types-fallback-no-config-");
      const { layer, api } = yield* setup({
        workdir,
        skipConfig: true,
        projectId: Option.some(VALID_REF),
        projectTypes: "ok",
      });
      yield* genTypes(defaultFlags()).pipe(Effect.provide(layer));

      expect(api.requests[0]).toEqual({
        method: "generateTypescriptTypes",
        input: { ref: VALID_REF, included_schemas: "public" },
      });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("ignores positional language scanning when argv lacks the gen types context", () =>
    Effect.gen(function* () {
      const { layer, api } = yield* setup({
        args: ["unrelated", "argv"],
        projectId: Option.some(VALID_REF),
        projectTypes: "ok",
      });
      yield* genTypes(defaultFlags({ projectId: Option.some(VALID_REF) })).pipe(
        Effect.provide(layer),
      );

      expect(api.requests).toHaveLength(1);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("prefers explicit --schema on the linked path", () =>
    Effect.gen(function* () {
      const { layer, api } = yield* setup({
        projectId: Option.some(VALID_REF),
        projectTypes: "ok",
      });
      yield* genTypes(defaultFlags({ linked: true, schema: ["auth"] })).pipe(Effect.provide(layer));
      expect(api.requests[0]).toEqual({
        method: "generateTypescriptTypes",
        input: { ref: VALID_REF, included_schemas: "auth" },
      });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("prefers explicit --schema on the linked fallback path", () =>
    Effect.gen(function* () {
      const { layer, api } = yield* setup({
        projectId: Option.some(VALID_REF),
        projectTypes: "ok",
      });
      yield* genTypes(defaultFlags({ schema: ["auth"] })).pipe(Effect.provide(layer));
      expect(api.requests[0]).toEqual({
        method: "generateTypescriptTypes",
        input: { ref: VALID_REF, included_schemas: "auth" },
      });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("silently ignores --query-timeout for implicit linked TypeScript generation", () =>
    Effect.gen(function* () {
      const { layer, out, api } = yield* setup({
        args: ["gen", "types", "--query-timeout", "20s"],
        projectId: Option.some(VALID_REF),
        projectTypes: "ok",
      });
      yield* genTypes(defaultFlags({ queryTimeout: "20s" })).pipe(Effect.provide(layer));

      expect(out.stderrText).not.toContain("--query-timeout");
      expect(api.requests).toContainEqual({
        method: "generateTypescriptTypes",
        input: { ref: VALID_REF, included_schemas: "public" },
      });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("maps project type generation network failures", () =>
    Effect.gen(function* () {
      const { layer } = yield* setup({
        generateTypescriptTypes: () =>
          Effect.fail(new ApiCallFailure({ message: "network error" })),
      });
      const exit = yield* genTypes(
        defaultFlags({
          projectId: Option.some(VALID_REF),
        }),
      ).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain(
          "failed to get typescript types: ApiCallFailure: network error",
        );
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("accepts legacy positional typescript without changing behavior", () =>
    Effect.gen(function* () {
      const { layer } = yield* setup({
        args: ["gen", "types", "typescript"],
        projectId: Option.some(VALID_REF),
        projectTypes: "ok",
      });
      yield* genTypes(defaultFlags()).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(BunServices.layer)),
  );

  describe("Flag mutex groups and argv-scan precedence", () => {
    it.live("rejects combining --local and --linked", () =>
      Effect.gen(function* () {
        const { layer, telemetry } = yield* setup({
          args: ["gen", "types", "--local", "--linked"],
        });
        const exit = yield* genTypes(defaultFlags({ local: true, linked: true })).pipe(
          Effect.provide(layer),
          Effect.exit,
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(String(exit.cause)).toContain(
            "if any flags in the group [local linked project-id db-url] are set none of the others can be; [linked local] were all set",
          );
          expect(
            Option.exists(
              Cause.findErrorOption(exit.cause),
              Predicate.isTagged("GenTypesFlagUsageError"),
            ),
          ).toBe(true);
        }
        expect(telemetry.flushed).toBe(true);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("does not misdetect a mutex flag consumed as -s's value (pflag consumption)", () =>
      Effect.gen(function* () {
        // `childExitCode: 1` fails the local target's `container inspect`, keeping the
        // downstream failure deterministic once `--linked` is consumed as `-s`'s value.
        const { layer } = yield* setup({
          args: ["gen", "types", "-s", "--linked", "--local"],
          childExitCode: 1,
        });
        const exit = yield* genTypes(defaultFlags({ local: true, linked: true })).pipe(
          Effect.provide(layer),
          Effect.exit,
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(String(exit.cause)).toContain("failed to inspect service");
          expect(String(exit.cause)).not.toContain("if any flags in the group");
        }
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("rejects --swift-access-control with --linked (cobra mutex group)", () =>
      Effect.gen(function* () {
        const { layer } = yield* setup({
          args: ["gen", "types", "--linked", "--swift-access-control", "public", "--lang", "swift"],
        });
        const exit = yield* genTypes(
          defaultFlags({ linked: true, lang: "swift", "swift-access-control": "public" }),
        ).pipe(Effect.provide(layer), Effect.exit);

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(String(exit.cause)).toContain(
            "if any flags in the group [linked project-id swift-access-control] are set none of the others can be; [linked swift-access-control] were all set",
          );
        }
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("rejects --swift-access-control with --project-id (cobra mutex group)", () =>
      Effect.gen(function* () {
        const { layer } = yield* setup({
          args: [
            "gen",
            "types",
            "--project-id",
            VALID_REF,
            "--swift-access-control",
            "public",
            "--lang",
            "swift",
          ],
        });
        const exit = yield* genTypes(
          defaultFlags({
            projectId: Option.some(VALID_REF),
            lang: "swift",
            "swift-access-control": "public",
          }),
        ).pipe(Effect.provide(layer), Effect.exit);

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(String(exit.cause)).toContain(
            "if any flags in the group [linked project-id swift-access-control] are set none of the others can be; [project-id swift-access-control] were all set",
          );
        }
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("rejects --postgrest-v9-compat without --db-url for project-id generation", () =>
      Effect.gen(function* () {
        const { layer } = yield* setup({
          args: ["gen", "types", "--project-id", VALID_REF, "--postgrest-v9-compat"],
        });
        const exit = yield* genTypes(
          defaultFlags({ projectId: Option.some(VALID_REF), postgrestV9Compat: true }),
        ).pipe(Effect.provide(layer), Effect.exit);

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          // Established guard, including its "must used" typo — do not "fix" the grammar.
          expect(String(exit.cause)).toContain(
            "--postgrest-v9-compat must used together with --db-url",
          );
          expect(
            Option.exists(
              Cause.findErrorOption(exit.cause),
              Predicate.isTagged("GenTypesFlagUsageError"),
            ),
          ).toBe(true);
        }
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("rejects --postgrest-v9-compat without --db-url for local generation", () =>
      Effect.gen(function* () {
        const { layer, telemetry } = yield* setup({
          args: ["gen", "types", "--local", "--postgrest-v9-compat"],
        });
        const exit = yield* genTypes(defaultFlags({ local: true, postgrestV9Compat: true })).pipe(
          Effect.provide(layer),
          Effect.exit,
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(String(exit.cause)).toContain(
            "--postgrest-v9-compat must used together with --db-url",
          );
        }
        expect(telemetry.flushed).toBe(true);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("rejects --query-timeout with --project-id (cobra mutex group)", () =>
      Effect.gen(function* () {
        const { layer } = yield* setup({
          args: ["gen", "types", "--project-id", VALID_REF, "--query-timeout", "20s"],
        });
        const exit = yield* genTypes(
          defaultFlags({ projectId: Option.some(VALID_REF), queryTimeout: "20s" }),
        ).pipe(Effect.provide(layer), Effect.exit);

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(String(exit.cause)).toContain(
            "if any flags in the group [linked project-id query-timeout] are set none of the others can be; [project-id query-timeout] were all set",
          );
        }
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("rejects --query-timeout with --linked (cobra mutex group)", () =>
      Effect.gen(function* () {
        const { layer } = yield* setup({
          args: ["gen", "types", "--linked", "--query-timeout", "20s"],
          projectId: Option.some(VALID_REF),
        });
        const exit = yield* genTypes(defaultFlags({ linked: true, queryTimeout: "20s" })).pipe(
          Effect.provide(layer),
          Effect.exit,
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(String(exit.cause)).toContain(
            "if any flags in the group [linked project-id query-timeout] are set none of the others can be; [linked query-timeout] were all set",
          );
        }
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("counts explicitly negated booleans as set for mutex groups (pflag Changed)", () =>
      Effect.gen(function* () {
        const { layer } = yield* setup({
          args: ["gen", "types", "--linked=false", "--project-id", VALID_REF],
        });
        const exit = yield* genTypes(
          defaultFlags({ linked: false, projectId: Option.some(VALID_REF) }),
        ).pipe(Effect.provide(layer), Effect.exit);

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(String(exit.cause)).toContain(
            "if any flags in the group [linked project-id postgrest-v9-compat] are set none of the others can be; [linked project-id] were all set",
          );
        }
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("fails on an invalid --query-timeout before any flag guard runs", () =>
      Effect.gen(function* () {
        const { layer, telemetry } = yield* setup({
          args: ["gen", "types", "--linked", "--query-timeout", "bogus"],
        });
        const exit = yield* genTypes(defaultFlags({ linked: true, queryTimeout: "bogus" })).pipe(
          Effect.provide(layer),
          Effect.exit,
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(String(exit.cause)).toContain('invalid duration "bogus"');
          expect(String(exit.cause)).not.toContain("if any flags in the group");
        }
        expect(telemetry.flushed).toBe(false);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("prefers the --postgrest-v9-compat guard over mutex group errors", () =>
      Effect.gen(function* () {
        const { layer } = yield* setup({
          args: ["gen", "types", "--local", "--linked", "--postgrest-v9-compat"],
        });
        const exit = yield* genTypes(
          defaultFlags({ local: true, linked: true, postgrestV9Compat: true }),
        ).pipe(Effect.provide(layer), Effect.exit);

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(String(exit.cause)).toContain(
            "--postgrest-v9-compat must used together with --db-url",
          );
        }
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("prefers the positional language guard over mutex group errors", () =>
      Effect.gen(function* () {
        const { layer } = yield* setup({
          args: ["gen", "types", "go", "--local", "--linked"],
        });
        const exit = yield* genTypes(defaultFlags({ local: true, linked: true })).pipe(
          Effect.provide(layer),
          Effect.exit,
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(String(exit.cause)).toContain("use --lang flag to specify the typegen language");
          expect(
            Option.exists(
              Cause.findErrorOption(exit.cause),
              Predicate.isTagged("GenTypesFlagUsageError"),
            ),
          ).toBe(true);
        }
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("reports mutex groups in cobra's sorted group-key order", () =>
      Effect.gen(function* () {
        const dbUrl = "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
        const { layer } = yield* setup({
          args: [
            "gen",
            "types",
            "--db-url",
            dbUrl,
            "--postgrest-v9-compat",
            "--project-id",
            VALID_REF,
          ],
        });
        const exit = yield* genTypes(
          defaultFlags({
            dbUrl: Option.some(dbUrl),
            projectId: Option.some(VALID_REF),
            postgrestV9Compat: true,
          }),
        ).pipe(Effect.provide(layer), Effect.exit);

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(String(exit.cause)).toContain(
            "if any flags in the group [linked project-id postgrest-v9-compat] are set none of the others can be; [postgrest-v9-compat project-id] were all set",
          );
        }
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("rejects a non-typescript language passed after a -- separator", () =>
      Effect.gen(function* () {
        const { layer } = yield* setup({ args: ["gen", "types", "--", "go"] });
        const exit = yield* genTypes(defaultFlags()).pipe(Effect.provide(layer), Effect.exit);

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(String(exit.cause)).toContain("use --lang flag to specify the typegen language");
        }
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("treats a trailing -- with no operand as no positional language", () =>
      Effect.gen(function* () {
        const { layer, api } = yield* setup({
          args: ["gen", "types", "--"],
          projectId: Option.some(VALID_REF),
          projectTypes: "ok",
        });
        yield* genTypes(defaultFlags()).pipe(Effect.provide(layer));
        expect(api.requests).toHaveLength(1);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("treats a positional after a valueless long flag as the language", () =>
      Effect.gen(function* () {
        const { layer } = yield* setup({ args: ["gen", "types", "--local", "go"] });
        const exit = yield* genTypes(defaultFlags()).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(String(exit.cause)).toContain("use --lang flag to specify the typegen language");
        }
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("treats a positional after a valueless short flag as the language", () =>
      Effect.gen(function* () {
        const { layer } = yield* setup({ args: ["gen", "types", "-x", "go"] });
        const exit = yield* genTypes(defaultFlags()).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(String(exit.cause)).toContain("use --lang flag to specify the typegen language");
        }
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("rejects legacy positional non-typescript without an explicit lang flag", () =>
      Effect.gen(function* () {
        const { layer } = yield* setup({
          args: ["gen", "types", "go"],
        });
        const exit = yield* genTypes(defaultFlags()).pipe(Effect.provide(layer), Effect.exit);

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(String(exit.cause)).toContain("use --lang flag to specify the typegen language");
        }
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "rejects legacy positional non-typescript after consuming short flags with values",
      () =>
        Effect.gen(function* () {
          const { layer } = yield* setup({
            args: ["gen", "types", "-o", "json", "go"],
            goOutput: Option.some("json"),
          });
          const exit = yield* genTypes(defaultFlags()).pipe(Effect.provide(layer), Effect.exit);

          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(String(exit.cause)).toContain("use --lang flag to specify the typegen language");
          }
        }).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("--network-id is a hard error on every natively-generated path", () => {
    it.live("rejects --network-id after the gen types command path", () =>
      Effect.gen(function* () {
        const { layer, generator, child } = yield* setup({
          args: ["gen", "types", "--local", "--network-id", "net"],
        });
        const exit = yield* genTypes(defaultFlags({ local: true })).pipe(
          Effect.provide(layer),
          Effect.exit,
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(String(exit.cause)).toContain("GenTypesNetworkIdUnsupportedError");
          expect(String(exit.cause)).toContain("cannot join a Docker network via --network-id");
        }
        expect(generator.calls).toHaveLength(0);
        expect(child.calls).toHaveLength(0);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "rejects a persistent --network-id set before the command path (supabase --network-id net gen types --local)",
      () =>
        Effect.gen(function* () {
          const { layer, generator, child } = yield* setup({
            args: ["--network-id", "net", "gen", "types", "--local"],
          });
          const exit = yield* genTypes(defaultFlags({ local: true })).pipe(
            Effect.provide(layer),
            Effect.exit,
          );

          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(String(exit.cause)).toContain("GenTypesNetworkIdUnsupportedError");
            expect(String(exit.cause)).toContain("cannot join a Docker network via --network-id");
          }
          expect(generator.calls).toHaveLength(0);
          expect(child.calls).toHaveLength(0);
        }).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("Non-TypeScript generation through the DB resolver + native generator", () => {
    for (const scenario of nonTypescriptProjectRefScenarios) {
      it.live(`generates ${scenario.lang} types from a project ref through the DB resolver`, () =>
        Effect.gen(function* () {
          const { layer, out, api, linkedProjectCache, dbConfig, generator } = yield* setup({
            args: ["gen", "types", "--lang", scenario.lang, "--project-id", VALID_REF],
            generatorOutput: scenario.stdout,
            dbConfigResolve: (input) =>
              Effect.succeed(
                remoteResolvedConfig(
                  {
                    host: "127.0.0.1",
                    port: 5432,
                    user: `cli_login_${VALID_REF}`,
                    password: "temporary-password",
                    database: "postgres",
                  },
                  (input.linkedProjectRef !== undefined
                    ? Option.getOrUndefined(input.linkedProjectRef)
                    : undefined) ?? VALID_REF,
                ),
              ),
            getABranchConfig: ({ branch_id_or_ref }) =>
              Effect.fail(
                new ApiCallFailure({
                  message: `unexpected preview branch lookup for ${branch_id_or_ref}`,
                }),
              ),
            createLoginRole: ({ ref }) =>
              Effect.fail(
                new ApiCallFailure({ message: `unexpected login role creation for ${ref}` }),
              ),
          });
          yield* genTypes(
            defaultFlags({
              projectId: Option.some(VALID_REF),
              lang: scenario.lang,
            }),
          ).pipe(Effect.provide(layer));

          expect(api.requests).toContainEqual({ method: "getProject", input: { ref: VALID_REF } });
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
          expect(out.stderrText).not.toContain("unformatted");
          expect(out.stdoutText).toContain(scenario.stdout);
          expect(dbConfig.resolves).toHaveLength(1);
          expect(dbConfig.resolves[0]?.connType).toBe("linked");
          expect(dbConfig.resolves[0]?.adHocProjectRef).toBe(true);
          const linkedProjectRef = dbConfig.resolves[0]?.linkedProjectRef;
          expect(
            linkedProjectRef !== undefined ? Option.getOrUndefined(linkedProjectRef) : undefined,
          ).toBe(VALID_REF);
          expect(generator.calls).toHaveLength(1);
          const call = generator.calls[0];
          expect(call?.lang).toBe(scenario.lang);
          expect(call?.includedSchemas).toEqual(["public"]);
          expect(call?.isLocal).toBe(false);
          // project-ref generation always pins the Supabase CA, promoting sslmode to verify-ca.
          expect(call?.conn.sslmode).toBe("require");
          expect(call?.conn.sslrootcertInline).toBe(rootCaBundle());
          expect(linkedProjectCache.cached).toBe(true);
        }).pipe(Effect.provide(BunServices.layer)),
      );
    }

    it.live("resolves the linked workdir DB without ad-hoc project-ref semantics", () =>
      Effect.gen(function* () {
        const { layer, dbConfig } = yield* setup({
          args: ["gen", "types", "--lang", "go", "--linked"],
          projectId: Option.some(VALID_REF),
          dbConfigResolve: () =>
            Effect.succeed(
              remoteResolvedConfig({
                host: "127.0.0.1",
                port: 5432,
                user: "postgres",
                password: "workdir-password",
                database: "postgres",
              }),
            ),
        });
        yield* genTypes(defaultFlags({ linked: true, lang: "go" })).pipe(Effect.provide(layer));

        expect(dbConfig.resolves).toHaveLength(1);
        expect(dbConfig.resolves[0]?.connType).toBe("linked");
        expect(dbConfig.resolves[0]?.adHocProjectRef).toBe(false);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("preserves resolver connection options for remote non-TypeScript typegen", () =>
      Effect.gen(function* () {
        const { layer, generator } = yield* setup({
          args: ["gen", "types", "--lang", "go", "--project-id", VALID_REF],
          dbConfigResolve: () =>
            Effect.succeed(
              remoteResolvedConfig({
                host: "127.0.0.1",
                port: 5432,
                user: `postgres.${VALID_REF}`,
                password: "pooler-password",
                database: "postgres",
                options: `reference=${VALID_REF}`,
              }),
            ),
        });
        yield* genTypes(
          defaultFlags({
            projectId: Option.some(VALID_REF),
            lang: "go",
          }),
        ).pipe(Effect.provide(layer));

        expect(generator.calls[0]?.conn.options).toBe(`reference=${VALID_REF}`);
        expect(generator.calls[0]?.conn.user).toBe(`postgres.${VALID_REF}`);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "forwards --query-timeout and --swift-access-control to the generator for implicit linked non-TypeScript generation",
      () =>
        Effect.gen(function* () {
          const { layer, dbConfig, generator } = yield* setup({
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
            projectId: Option.some(VALID_REF),
          });
          yield* genTypes(
            defaultFlags({ lang: "go", queryTimeout: "20s", "swift-access-control": "public" }),
          ).pipe(Effect.provide(layer));

          expect(dbConfig.resolves[0]?.adHocProjectRef).toBe(false);
          const call = generator.calls[0];
          expect(call?.options["swift-access-control"]).toBe("public");
          expect(call?.conn.runtimeParams?.["statement_timeout"]).toBe("20000");
          expect(call?.conn.connectTimeoutSeconds).toBe(20);
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("uses remote config schemas for explicit project-ref typegen", () =>
      Effect.gen(function* () {
        const workdir = yield* makeWorkdir("supabase-gen-types-remote-config-");
        yield* writeConfig(
          workdir,
          [
            'project_id = "base"',
            "",
            "[api]",
            'schemas = ["public"]',
            "",
            "[remotes.staging]",
            `project_id = "${VALID_REF}"`,
            "",
            "[remotes.staging.api]",
            'schemas = ["private"]',
            "",
          ].join("\n"),
        );
        const { layer, generator } = yield* setup({
          workdir,
          args: ["gen", "types", "--lang", "go", "--project-id", VALID_REF],
        });
        yield* genTypes(
          defaultFlags({
            projectId: Option.some(VALID_REF),
            lang: "go",
          }),
        ).pipe(Effect.provide(layer));

        expect(generator.calls[0]?.includedSchemas).toEqual(["public", "private"]);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("uses remote config schemas for linked typegen", () =>
      Effect.gen(function* () {
        const workdir = yield* makeWorkdir("supabase-gen-types-linked-config-");
        yield* writeConfig(
          workdir,
          [
            'project_id = "base"',
            "",
            "[api]",
            'schemas = ["public"]',
            "",
            "[remotes.staging]",
            `project_id = "${VALID_REF}"`,
            "",
            "[remotes.staging.api]",
            'schemas = ["private"]',
            "",
          ].join("\n"),
        );
        const { layer, generator } = yield* setup({
          workdir,
          projectId: Option.some(VALID_REF),
          args: ["gen", "types", "--lang", "go", "--linked"],
        });
        yield* genTypes(
          defaultFlags({
            linked: true,
            lang: "go",
          }),
        ).pipe(Effect.provide(layer));

        expect(generator.calls[0]?.includedSchemas).toEqual(["public", "private"]);
      }).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("Preview-branch fallback", () => {
    it.live("falls back to preview branch config for non-TypeScript project refs", () =>
      Effect.gen(function* () {
        const { layer, api, dbConfig, generator } = yield* setup({
          args: ["gen", "types", "--lang", "python", "--project-id", VALID_REF],
          generatorOutput: "class PublicMovies(BaseModel):",
          getProject: () =>
            Effect.fail(statusApiError(404, `{"message":"Preview branch not found"}`)),
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
            Effect.fail(
              new ApiCallFailure({ message: `unexpected login role creation for ${ref}` }),
            ),
        });
        yield* genTypes(
          defaultFlags({
            projectId: Option.some(VALID_REF),
            lang: "python",
          }),
        ).pipe(Effect.provide(layer));

        expect(api.requests).toContainEqual({ method: "getProject", input: { ref: VALID_REF } });
        expect(api.requests).toContainEqual({
          method: "getABranchConfig",
          input: { branch_id_or_ref: VALID_REF },
        });
        expect(api.requests).not.toContainEqual(
          expect.objectContaining({ method: "createLoginRole" }),
        );
        expect(dbConfig.resolves).toHaveLength(0);
        const call = generator.calls[0];
        expect(call?.conn.host).toBe("127.0.0.1");
        expect(call?.conn.user).toBe("branch_user");
        expect(call?.conn.password).toBe("branch-password");
        // Preview-branch generation pins the Supabase CA the same as any other remote target.
        expect(call?.conn.sslmode).toBe("require");
        expect(call?.conn.sslrootcertInline).toBe(rootCaBundle());
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("falls back to preview branch config for any project 404 body", () =>
      Effect.gen(function* () {
        const { layer, api, dbConfig, generator } = yield* setup({
          args: ["gen", "types", "--lang", "python", "--project-id", VALID_REF],
          generatorOutput: "class PublicMovies(BaseModel):",
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
        yield* genTypes(
          defaultFlags({
            projectId: Option.some(VALID_REF),
            lang: "python",
          }),
        ).pipe(Effect.provide(layer));

        expect(api.requests).toContainEqual({
          method: "getABranchConfig",
          input: { branch_id_or_ref: VALID_REF },
        });
        expect(dbConfig.resolves).toHaveLength(0);
        expect(generator.calls[0]?.conn.password).toBe("branch-password");
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("fails clearly when preview branch config does not include DB credentials", () =>
      Effect.gen(function* () {
        const { layer } = yield* setup({
          args: ["gen", "types", "--lang", "python", "--project-id", VALID_REF],
          getProject: () =>
            Effect.fail(statusApiError(404, `{"message":"Preview branch not found"}`)),
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
        const exit = yield* genTypes(
          defaultFlags({
            projectId: Option.some(VALID_REF),
            lang: "python",
          }),
        ).pipe(Effect.provide(layer), Effect.exit);

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(String(exit.cause)).toContain(
            "Preview branch database credentials are unavailable",
          );
          expect(
            Option.exists(
              Cause.findErrorOption(exit.cause),
              Predicate.isTagged("GenTypesBranchCredentialsUnavailableError"),
            ),
          ).toBe(true);
        }
      }).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("Pooler fallback on an IPv6-classified generation failure", () => {
    it.live("retries through the IPv4 pooler on an IPv6-classified generation failure", () =>
      Effect.gen(function* () {
        const poolerConn: PgConnInput = {
          host: "127.0.0.1",
          port: 5432,
          user: `postgres.${VALID_REF}`,
          password: "pooler-password",
          database: "postgres",
        };
        const generator = sequentialGenerator([
          () => Effect.fail(ipv6Failure()),
          () => Effect.succeed("type RetriedViaPooler struct {}"),
        ]);
        const { layer, out, dbConfig } = yield* setup({
          args: ["gen", "types", "--lang", "go", "--project-id", VALID_REF],
          generator,
          dbConfigResolve: () =>
            Effect.succeed(
              remoteResolvedConfig({
                host: `db.${VALID_REF}.supabase.co`,
                port: 5432,
                user: "postgres",
                password: "direct-password",
                database: "postgres",
              }),
            ),
          poolerFallback: Option.some(poolerConn),
        });
        yield* genTypes(
          defaultFlags({
            projectId: Option.some(VALID_REF),
            lang: "go",
          }),
        ).pipe(Effect.provide(layer));

        expect(out.stdoutText).toContain("type RetriedViaPooler struct {}");
        expect(out.stderrText).toContain("does not support IPv6");
        expect(out.stderrText).toContain("Retrying via the IPv4 connection pooler.");
        expect(generator.calls).toHaveLength(2);
        expect(generator.calls[0]?.conn.host).toBe(`db.${VALID_REF}.supabase.co`);
        expect(generator.calls[1]?.conn.host).toBe("127.0.0.1");
        expect(dbConfig.poolerFallbacks).toHaveLength(1);
        expect(dbConfig.poolerFallbacks[0]?.connType).toBe("linked");
        expect(dbConfig.poolerFallbacks[0]?.adHocProjectRef).toBe(true);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("retries through the IPv4 pooler on an ENOTFOUND direct-host dial failure", () =>
      Effect.gen(function* () {
        const poolerConn: PgConnInput = {
          host: "127.0.0.1",
          port: 5432,
          user: `postgres.${VALID_REF}`,
          password: "pooler-password",
          database: "postgres",
        };
        const generator = sequentialGenerator([
          () => Effect.fail(enotfoundFailure()),
          () => Effect.succeed("type RetriedViaPooler struct {}"),
        ]);
        const { layer, out, dbConfig } = yield* setup({
          args: ["gen", "types", "--lang", "go", "--project-id", VALID_REF],
          generator,
          dbConfigResolve: () =>
            Effect.succeed(
              remoteResolvedConfig({
                host: `db.${VALID_REF}.supabase.co`,
                port: 5432,
                user: "postgres",
                password: "direct-password",
                database: "postgres",
              }),
            ),
          poolerFallback: Option.some(poolerConn),
        });
        yield* genTypes(
          defaultFlags({
            projectId: Option.some(VALID_REF),
            lang: "go",
          }),
        ).pipe(Effect.provide(layer));

        expect(out.stdoutText).toContain("type RetriedViaPooler struct {}");
        expect(out.stderrText).toContain("Retrying via the IPv4 connection pooler.");
        expect(generator.calls).toHaveLength(2);
        expect(generator.calls[1]?.conn.host).toBe("127.0.0.1");
        expect(dbConfig.poolerFallbacks).toHaveLength(1);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("does not retry through the pooler when the failure is not IPv6-classified", () =>
      Effect.gen(function* () {
        const generator = sequentialGenerator([() => Effect.fail(nonIpv6Failure())]);
        const { layer, dbConfig } = yield* setup({
          args: ["gen", "types", "--lang", "go", "--project-id", VALID_REF],
          generator,
          dbConfigResolve: () =>
            Effect.succeed(
              remoteResolvedConfig({
                host: `db.${VALID_REF}.supabase.co`,
                port: 5432,
                user: "postgres",
                password: "direct-password",
                database: "postgres",
              }),
            ),
          poolerFallback: Option.some({
            host: "127.0.0.1",
            port: 5432,
            user: `postgres.${VALID_REF}`,
            password: "pooler-password",
            database: "postgres",
          }),
        });
        const exit = yield* genTypes(
          defaultFlags({ projectId: Option.some(VALID_REF), lang: "go" }),
        ).pipe(Effect.provide(layer), Effect.exit);

        expect(Exit.isFailure(exit)).toBe(true);
        expect(generator.calls).toHaveLength(1);
        expect(dbConfig.poolerFallbacks).toHaveLength(0);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("does not run pooler fallback a second time when the retry also fails IPv6-style", () =>
      Effect.gen(function* () {
        const generator = sequentialGenerator([
          () => Effect.fail(ipv6Failure()),
          () => Effect.fail(ipv6Failure()),
        ]);
        const { layer, dbConfig } = yield* setup({
          args: ["gen", "types", "--lang", "go", "--project-id", VALID_REF],
          generator,
          dbConfigResolve: () =>
            Effect.succeed(
              remoteResolvedConfig({
                host: `db.${VALID_REF}.supabase.co`,
                port: 5432,
                user: "postgres",
                password: "direct-password",
                database: "postgres",
              }),
            ),
          poolerFallback: Option.some({
            host: "127.0.0.1",
            port: 5432,
            user: `postgres.${VALID_REF}`,
            password: "pooler-password",
            database: "postgres",
          }),
        });
        const exit = yield* genTypes(
          defaultFlags({ projectId: Option.some(VALID_REF), lang: "go" }),
        ).pipe(Effect.provide(layer), Effect.exit);

        expect(Exit.isFailure(exit)).toBe(true);
        expect(generator.calls).toHaveLength(2);
        expect(dbConfig.poolerFallbacks).toHaveLength(1);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "does not retry through the pooler when the resolved connection is already a pooler host",
      () =>
        Effect.gen(function* () {
          const generator = sequentialGenerator([() => Effect.fail(ipv6Failure())]);
          const { layer, out, dbConfig } = yield* setup({
            args: ["gen", "types", "--lang", "go", "--project-id", VALID_REF],
            generator,
            dbConfigResolve: () =>
              Effect.succeed(
                remoteResolvedConfig({
                  host: "aws-0-us-east-1.pooler.supabase.com",
                  port: 5432,
                  user: `postgres.${VALID_REF}`,
                  password: "pooler-password",
                  database: "postgres",
                }),
              ),
            poolerFallback: Option.some({
              host: "aws-0-us-east-1.pooler.supabase.com",
              port: 5432,
              user: `postgres.${VALID_REF}`,
              password: "pooler-password",
              database: "postgres",
            }),
          });
          const exit = yield* genTypes(
            defaultFlags({ projectId: Option.some(VALID_REF), lang: "go" }),
          ).pipe(Effect.provide(layer), Effect.exit);

          expect(Exit.isFailure(exit)).toBe(true);
          expect(generator.calls).toHaveLength(1);
          expect(dbConfig.poolerFallbacks).toHaveLength(0);
          expect(out.stderrText).not.toContain("Retrying via the IPv4 connection pooler.");
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("preserves the original generation error when pooler fallback resolution fails", () =>
      Effect.gen(function* () {
        const generator = sequentialGenerator([() => Effect.fail(ipv6Failure())]);
        const { layer } = yield* setup({
          args: ["gen", "types", "--lang", "go", "--project-id", VALID_REF],
          generator,
          dbConfigResolve: () =>
            Effect.succeed(
              remoteResolvedConfig({
                host: `db.${VALID_REF}.supabase.co`,
                port: 5432,
                user: "postgres",
                password: "direct-password",
                database: "postgres",
              }),
            ),
          poolerFallbackFails: true,
        });
        const exit = yield* genTypes(
          defaultFlags({ projectId: Option.some(VALID_REF), lang: "go" }),
        ).pipe(Effect.provide(layer), Effect.exit);

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(String(exit.cause)).toContain("dial error (connect ENETUNREACH");
          expect(String(exit.cause)).not.toContain("pooler fallback failed");
        }
        expect(generator.calls).toHaveLength(1);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("retries preview branch generation through the branch IPv4 pooler", () =>
      Effect.gen(function* () {
        const poolerHost = "aws-0-us-east-1.pooler.supabase.com";
        const generator = sequentialGenerator([
          () => Effect.fail(ipv6Failure()),
          () => Effect.succeed("class RetriedViaBranchPooler(BaseModel):"),
        ]);
        const { layer, api } = yield* setup({
          args: ["gen", "types", "--lang", "python", "--project-id", VALID_REF],
          generator,
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
        yield* genTypes(
          defaultFlags({
            projectId: Option.some(VALID_REF),
            lang: "python",
          }),
        ).pipe(Effect.provide(layer));

        expect(api.requests).toContainEqual({
          method: "getPoolerConfig",
          input: { ref: VALID_REF },
        });
        expect(generator.calls).toHaveLength(2);
        expect(generator.calls[1]?.conn.host).toBe(poolerHost);
        expect(generator.calls[1]?.conn.password).toBe("branch-password");
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("skips preview branch pooler fallback when the pooler URL fails validation", () =>
      Effect.gen(function* () {
        const generator = sequentialGenerator([() => Effect.fail(ipv6Failure())]);
        const { layer, api } = yield* setup({
          args: ["gen", "types", "--lang", "python", "--project-id", VALID_REF],
          generator,
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
        const exit = yield* genTypes(
          defaultFlags({
            projectId: Option.some(VALID_REF),
            lang: "python",
          }),
        ).pipe(Effect.provide(layer), Effect.exit);

        expect(Exit.isFailure(exit)).toBe(true);
        expect(api.requests).toContainEqual({
          method: "getPoolerConfig",
          input: { ref: VALID_REF },
        });
        expect(generator.calls).toHaveLength(1);
      }).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("TLS: pin the Supabase CA only where the design calls for it", () => {
    it.live("pins the Supabase CA for a db-url pointing at a direct database host", () =>
      Effect.gen(function* () {
        const { layer, generator } = yield* setup({
          dbConfigResolve: () =>
            Effect.succeed(
              remoteResolvedConfig({
                host: `db.${VALID_REF}.supabase.co`,
                port: 5432,
                user: "postgres",
                password: "postgres",
                database: "postgres",
              }),
            ),
        });
        yield* genTypes(
          defaultFlags({
            dbUrl: Option.some(
              `postgresql://postgres:postgres@db.${VALID_REF}.supabase.co:5432/postgres`,
            ),
          }),
        ).pipe(Effect.provide(layer));

        expect(generator.calls[0]?.conn.sslmode).toBe("require");
        expect(generator.calls[0]?.conn.sslrootcertInline).toBe(rootCaBundle());
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("pins the Supabase CA for a db-url pointing at the pooler host", () =>
      Effect.gen(function* () {
        const { layer, generator } = yield* setup({
          dbConfigResolve: () =>
            Effect.succeed(
              remoteResolvedConfig({
                host: "aws-0-us-east-1.pooler.supabase.com",
                port: 6543,
                user: `postgres.${VALID_REF}`,
                password: "pooler-password",
                database: "postgres",
              }),
            ),
        });
        yield* genTypes(
          defaultFlags({
            dbUrl: Option.some(
              "postgresql://postgres.ref:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
            ),
          }),
        ).pipe(Effect.provide(layer));

        expect(generator.calls[0]?.conn.sslmode).toBe("require");
        expect(generator.calls[0]?.conn.sslrootcertInline).toBe(rootCaBundle());
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("honors an explicit sslmode from the db-url's DSN on a Supabase host", () =>
      Effect.gen(function* () {
        const { layer, generator } = yield* setup({
          dbConfigResolve: () =>
            Effect.succeed(
              remoteResolvedConfig({
                host: `db.${VALID_REF}.supabase.co`,
                port: 5432,
                user: "postgres",
                password: "postgres",
                database: "postgres",
                sslmode: "disable",
              }),
            ),
        });
        yield* genTypes(
          defaultFlags({
            dbUrl: Option.some(
              `postgresql://postgres:postgres@db.${VALID_REF}.supabase.co:5432/postgres?sslmode=disable`,
            ),
          }),
        ).pipe(Effect.provide(layer));

        expect(generator.calls[0]?.conn.sslmode).toBe("disable");
        expect(generator.calls[0]?.conn.sslrootcertInline).toBeUndefined();
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("leaves a non-Supabase db-url host unpinned", () =>
      Effect.gen(function* () {
        const { layer, generator } = yield* setup({
          dbConfigResolve: () =>
            Effect.succeed(
              remoteResolvedConfig({
                host: "db.example.net",
                port: 5432,
                user: "postgres",
                password: "postgres",
                database: "postgres",
              }),
            ),
        });
        yield* genTypes(
          defaultFlags({
            dbUrl: Option.some("postgresql://postgres:postgres@db.example.net:5432/postgres"),
          }),
        ).pipe(Effect.provide(layer));

        expect(generator.calls[0]?.conn.sslmode).toBeUndefined();
        expect(generator.calls[0]?.conn.sslrootcertInline).toBeUndefined();
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("never pins TLS for a local db-url target", () =>
      Effect.gen(function* () {
        const { layer, generator } = yield* setup({
          dbConfigResolve: () =>
            Effect.succeed(
              localResolvedConfig({
                host: `db.${VALID_REF}.supabase.co`,
                port: 5432,
                user: "postgres",
                password: "postgres",
                database: "postgres",
              }),
            ),
        });
        yield* genTypes(
          defaultFlags({
            dbUrl: Option.some("postgresql://postgres:postgres@127.0.0.1:5432/postgres"),
          }),
        ).pipe(Effect.provide(layer));

        expect(generator.calls[0]?.conn.sslmode).toBeUndefined();
        expect(generator.calls[0]?.conn.sslrootcertInline).toBeUndefined();
      }).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("Local generation: legacy backend (still inspects the Docker container)", () => {
    it.live(
      "generates locally via the legacy backend, connecting directly to the mapped port",
      () =>
        Effect.gen(function* () {
          const workdir = yield* makeWorkdir("supabase-gen-types-local-");
          yield* writeConfig(
            workdir,
            [
              'project_id = "demo"',
              "",
              "[api]",
              'schemas = ["public", "custom"]',
              "",
              "[db]",
              "port = 54321",
            ].join("\n"),
          );
          yield* writeFile(
            path.join(workdir, "supabase", ".env"),
            "DOCKER_HOST=project-daemon\nSUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io\nSUPABASE_USE_SLIM_IMAGES=1\nSUPABASE_DB_PASSWORD=dotenv-password\n",
          );
          const { layer, out, linkedProjectCache, child, generator } = yield* setup({ workdir });
          const configProvider = ConfigProvider.fromEnvRecord({}, { preserveEmptyStrings: true });
          yield* genTypes(defaultFlags({ local: true })).pipe(
            Effect.provide(layer),
            Effect.provideService(ConfigProvider.ConfigProvider, configProvider),
          );

          expect(out.stderrText).toContain("Connecting to 127.0.0.1 54321");
          expect(out.stderrText).toContain(
            "Generated TypeScript is unformatted. Format it with:\n  npx oxfmt <generated-file.ts>",
          );
          expect(out.stdoutText).toContain("generated");
          expect(child.calls).toHaveLength(1);
          expect(child.calls[0]).toMatchObject({
            command: "docker",
            args: ["container", "inspect", "supabase_db_demo"],
            extendEnv: true,
          });
          // Env forwarding from the config's `.env` excludes SUPABASE_DB_PASSWORD.
          expect(child.calls[0]?.env).toEqual({
            DOCKER_HOST: "project-daemon",
            SUPABASE_INTERNAL_IMAGE_REGISTRY: "docker.io",
            SUPABASE_USE_SLIM_IMAGES: "1",
          });
          expect(generator.calls).toHaveLength(1);
          const call = generator.calls[0];
          expect(call?.conn).toEqual({
            host: "127.0.0.1",
            port: 54321,
            user: "postgres",
            password: "postgres",
            database: "postgres",
            runtimeParams: { statement_timeout: "15000" },
            connectTimeoutSeconds: 15,
          });
          expect(call?.isLocal).toBe(true);
          expect(call?.includedSchemas).toEqual(["public", "custom"]);
          expect(call?.options["detect-one-to-one-relationships"]).toBe(true);
          expect(call?.conn.sslmode).toBeUndefined();
          expect(call?.conn.sslrootcertInline).toBeUndefined();
          expect(linkedProjectCache.cached).toBe(false);
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("falls back to podman when the docker executable is missing for local generation", () =>
      Effect.gen(function* () {
        const workdir = yield* makeWorkdir("supabase-gen-types-local-podman-");
        yield* writeConfig(
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
        const { layer, out, child, generator } = yield* setup({
          workdir,
          childDockerMissing: true,
        });
        yield* genTypes(defaultFlags({ local: true })).pipe(Effect.provide(layer));

        expect(out.stdoutText).toContain("generated");
        expect(child.calls.map((call) => call.command)).toEqual(["docker", "podman"]);
        expect(child.calls[1]?.args).toEqual(["container", "inspect", "supabase_db_demo"]);
        expect(generator.calls).toHaveLength(1);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("uses sanitized local docker ids and env-backed local db passwords", () =>
      Effect.gen(function* () {
        const workdir = yield* makeWorkdir("supabase-gen-types-local-sanitized-");
        yield* writeConfig(
          workdir,
          [
            'project_id = "..demo project with spaces"',
            "",
            "[api]",
            'schemas = ["public"]',
            "",
            "[db]",
            "port = 54321",
          ].join("\n"),
        );
        const { layer, child, generator } = yield* setup({ workdir });
        yield* genTypes(defaultFlags({ local: true })).pipe(
          Effect.provide(layer),
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnvRecord({ SUPABASE_DB_PASSWORD: "secret-password" }),
          ),
        );

        expect(child.calls[0]?.args).toEqual([
          "container",
          "inspect",
          "supabase_db_demo_project_with_spaces",
        ]);
        expect(generator.calls[0]?.conn.password).toBe("secret-password");
        expect(generator.calls[0]?.conn.host).toBe("127.0.0.1");
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("forces v9 compat when rest-version reports v9 on a modern database", () =>
      Effect.gen(function* () {
        const workdir = yield* makeWorkdir("supabase-gen-types-local-v9-");
        yield* writeConfig(
          workdir,
          [
            'project_id = "demo"',
            "",
            "[api]",
            'schemas = ["public"]',
            "",
            "[db]",
            "major_version = 15",
            "port = 54321",
          ].join("\n"),
        );
        yield* writeTempFile(workdir, "rest-version", "v9.0.1\n");
        const { layer, generator } = yield* setup({ workdir });
        yield* genTypes(defaultFlags({ local: true })).pipe(Effect.provide(layer));

        expect(generator.calls[0]?.options["detect-one-to-one-relationships"]).toBe(false);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("ignores rest-version v9 marker on databases older than 15", () =>
      Effect.gen(function* () {
        const workdir = yield* makeWorkdir("supabase-gen-types-local-pg14-");
        yield* writeConfig(
          workdir,
          [
            'project_id = "demo"',
            "",
            "[api]",
            'schemas = ["public"]',
            "",
            "[db]",
            "major_version = 14",
            "port = 54321",
          ].join("\n"),
        );
        yield* writeTempFile(workdir, "rest-version", "v9.0.1\n");
        const { layer, generator } = yield* setup({ workdir });
        yield* genTypes(defaultFlags({ local: true })).pipe(Effect.provide(layer));

        expect(generator.calls[0]?.options["detect-one-to-one-relationships"]).toBe(true);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("prefers explicit --schema over config schemas for local generation", () =>
      Effect.gen(function* () {
        const workdir = yield* makeWorkdir("supabase-gen-types-local-schema-");
        yield* writeConfig(
          workdir,
          [
            'project_id = "demo"',
            "",
            "[api]",
            'schemas = ["public", "custom"]',
            "",
            "[db]",
            "port = 54321",
          ].join("\n"),
        );
        const { layer, generator } = yield* setup({ workdir });
        yield* genTypes(defaultFlags({ local: true, schema: ["auth", "storage"] })).pipe(
          Effect.provide(layer),
        );

        expect(generator.calls[0]?.includedSchemas).toEqual(["auth", "storage"]);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("allows --swift-access-control for local non-Swift generation", () =>
      Effect.gen(function* () {
        const workdir = yield* makeWorkdir("supabase-gen-types-local-swift-flag-");
        yield* writeConfig(
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
        const { layer, generator } = yield* setup({
          workdir,
          args: ["gen", "types", "--local", "--lang", "python", "--swift-access-control", "public"],
        });
        yield* genTypes(
          defaultFlags({ local: true, lang: "python", "swift-access-control": "public" }),
        ).pipe(Effect.provide(layer));

        expect(generator.calls[0]?.lang).toBe("python");
        expect(generator.calls[0]?.options["swift-access-control"]).toBe("public");
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("falls back to the workdir basename when config has no project_id", () =>
      Effect.gen(function* () {
        const workdir = yield* makeWorkdir("supabase-gen-types-local-noid-");
        yield* writeConfig(
          workdir,
          ["[api]", 'schemas = ["public"]', "", "[db]", "port = 54321"].join("\n"),
        );
        const { layer, child } = yield* setup({ workdir });
        yield* genTypes(defaultFlags({ local: true })).pipe(Effect.provide(layer));

        const inspectId = child.calls[0]?.args[2] ?? "";
        expect(inspectId.startsWith("supabase_db_")).toBe(true);
        expect(inspectId).not.toBe("supabase_db_demo");
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("fails with not-running parity when the local db container is missing", () =>
      Effect.gen(function* () {
        const workdir = yield* makeWorkdir("supabase-gen-types-local-missing-");
        yield* writeConfig(
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
        const { layer } = yield* setup({
          workdir,
          childExitCode: 1,
          childStderr: ["Error: No such container: supabase_db_demo"],
        });
        const exit = yield* genTypes(defaultFlags({ local: true })).pipe(
          Effect.provide(layer),
          Effect.exit,
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(String(exit.cause)).toContain("supabase start is not running.");
          expect(
            Option.exists(
              Cause.findErrorOption(exit.cause),
              Predicate.isTagged("GenTypesLocalDbNotRunningError"),
            ),
          ).toBe(true);
        }
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("keeps not-running parity when podman reports the local db container is missing", () =>
      Effect.gen(function* () {
        const workdir = yield* makeWorkdir("supabase-gen-types-local-podman-missing-");
        yield* writeConfig(
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
        const { layer, child } = yield* setup({
          workdir,
          childDockerMissing: true,
          childExitCode: 1,
          childStderr: ['Error: inspecting object: no such container "supabase_db_demo"'],
        });
        const exit = yield* genTypes(defaultFlags({ local: true })).pipe(
          Effect.provide(layer),
          Effect.exit,
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(String(exit.cause)).toContain("supabase start is not running.");
        }
        expect(child.calls.map((call) => call.command)).toEqual(["docker", "podman"]);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "preserves inspect failure details when local db inspection fails for other reasons",
      () =>
        Effect.gen(function* () {
          const workdir = yield* makeWorkdir("supabase-gen-types-local-inspect-error-");
          yield* writeConfig(
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
          const { layer } = yield* setup({
            workdir,
            childExitCode: 1,
            childStderr: ["Cannot connect to the Docker daemon"],
          });
          const exit = yield* genTypes(defaultFlags({ local: true })).pipe(
            Effect.provide(layer),
            Effect.exit,
          );

          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(String(exit.cause)).toContain(
              "failed to inspect service: Cannot connect to the Docker daemon",
            );
            expect(
              Option.exists(
                Cause.findErrorOption(exit.cause),
                (error) => error instanceof GenTypesLocalDbInspectError && error.daemonDown,
              ),
            ).toBe(true);
          }
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("generates locally with Go defaults when supabase/config.toml is missing", () =>
      Effect.gen(function* () {
        const workdir = yield* makeWorkdir("supabase-gen-types-local-no-config-");
        const { layer, out, child, generator } = yield* setup({ workdir, skipConfig: true });
        yield* genTypes(defaultFlags({ local: true })).pipe(Effect.provide(layer));

        const projectId = path.basename(workdir);
        expect(child.calls[0]?.args).toEqual([
          "container",
          "inspect",
          localDbContainerId(projectId),
        ]);
        expect(generator.calls[0]?.conn).toEqual({
          host: "127.0.0.1",
          port: 54322,
          user: "postgres",
          password: "postgres",
          database: "postgres",
          runtimeParams: { statement_timeout: "15000" },
          connectTimeoutSeconds: 15,
        });
        expect(generator.calls[0]?.includedSchemas).toEqual(["public", "graphql_public"]);
        expect(out.stdoutText).toContain("generated");
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("honors local dotenv overrides when supabase/config.toml is missing", () =>
      Effect.gen(function* () {
        const workdir = yield* makeWorkdir("supabase-gen-types-local-no-config-env-");
        const supabaseDir = path.join(workdir, "supabase");
        yield* makeDirectory(supabaseDir);
        yield* writeFile(
          path.join(supabaseDir, ".env"),
          [
            "SUPABASE_PROJECT_ID=configless-env-project",
            "SUPABASE_DB_PORT=55432",
            "SUPABASE_API_SCHEMAS=private,graphql_public",
            "SUPABASE_SERVICES_HOSTNAME=host.docker.internal",
            "SUPABASE_INTERNAL_IMAGE_REGISTRY=mirror.example.com",
            "",
          ].join("\n"),
        );
        const { layer, out, child, generator } = yield* setup({ workdir, skipConfig: true });
        yield* genTypes(defaultFlags({ local: true })).pipe(Effect.provide(layer));

        expect(child.calls[0]?.args).toEqual([
          "container",
          "inspect",
          localDbContainerId("configless-env-project"),
        ]);
        expect(child.calls[0]?.env?.["SUPABASE_INTERNAL_IMAGE_REGISTRY"]).toBe(
          "mirror.example.com",
        );
        expect(generator.calls[0]?.conn.host).toBe("host.docker.internal");
        expect(generator.calls[0]?.conn.port).toBe(55432);
        expect(generator.calls[0]?.includedSchemas).toEqual([
          "public",
          "private",
          "graphql_public",
        ]);
        expect(out.stdoutText).toContain("generated");
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("reports a generic inspect failure when docker emits no stderr", () =>
      Effect.gen(function* () {
        const workdir = yield* makeWorkdir("supabase-gen-types-local-empty-stderr-");
        yield* writeConfig(
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
        const { layer } = yield* setup({ workdir, childExitCode: 1 });
        const exit = yield* genTypes(defaultFlags({ local: true })).pipe(
          Effect.provide(layer),
          Effect.exit,
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(String(exit.cause)).toContain("failed to inspect service");
          expect(String(exit.cause)).not.toContain("failed to inspect service:");
          expect(
            Option.exists(
              Cause.findErrorOption(exit.cause),
              (error) => error instanceof GenTypesLocalDbInspectError && !error.daemonDown,
            ),
          ).toBe(true);
        }
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("surfaces generation failures after local db inspection succeeds", () =>
      Effect.gen(function* () {
        const workdir = yield* makeWorkdir("supabase-gen-types-local-run-error-");
        yield* writeConfig(
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
        const generator = mockGenTypesGenerator({
          generate: () =>
            Effect.fail(
              new GenTypesGenerationError({ message: "failed to generate typescript types: boom" }),
            ),
        });
        const { layer, child } = yield* setup({ workdir, generator });
        const exit = yield* genTypes(defaultFlags({ local: true })).pipe(
          Effect.provide(layer),
          Effect.exit,
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(String(exit.cause)).toContain("failed to generate typescript types: boom");
        }
        expect(child.calls).toHaveLength(1);
        expect(generator.calls).toHaveLength(1);
      }).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("Local generation: stack backend (no Docker inspection at all)", () => {
    it.live("resolves the stack local database directly, without inspecting any container", () =>
      Effect.gen(function* () {
        const workdir = yield* makeWorkdir("supabase-gen-types-stack-local-");
        yield* writeConfig(
          workdir,
          [
            'project_id = "demo"',
            "",
            "[api]",
            'schemas = ["public", "custom"]',
            "",
            "[db]",
            "port = 54321",
          ].join("\n"),
        );
        const { layer, out, child, dbConfig, generator } = yield* setup({
          workdir,
          dbConfigResolve: () =>
            Effect.succeed(
              localResolvedConfig({
                host: "127.0.0.1",
                port: 54321,
                user: "postgres",
                password: "postgres",
                database: "postgres",
              }),
            ),
        });
        yield* genTypes(defaultFlags({ local: true })).pipe(
          Effect.provide(Layer.mergeAll(layer, stackBackendLayer("stack"))),
        );

        expect(out.stderrText).toContain("Connecting to 127.0.0.1 54321");
        expect(child.calls).toHaveLength(0);
        expect(dbConfig.resolves).toHaveLength(1);
        expect(dbConfig.resolves[0]?.connType).toBe("local");
        expect(generator.calls).toHaveLength(1);
        const call = generator.calls[0];
        expect(call?.conn).toMatchObject({
          host: "127.0.0.1",
          port: 54321,
          user: "postgres",
          password: "postgres",
        });
        expect(call?.isLocal).toBe(true);
        expect(call?.includedSchemas).toEqual(["public", "custom"]);
        // The stack backend never pins TLS for a local target either.
        expect(call?.conn.sslmode).toBeUndefined();
        expect(call?.conn.sslrootcertInline).toBeUndefined();
      }).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("db-url generation", () => {
    it.live(
      "--db-url --schema succeeds on an explicit --workdir with no project of its own, since an explicit schema never needs the config load",
      () =>
        Effect.gen(function* () {
          const root = yield* makeWorkdir("supabase-gen-types-ancestor-");
          yield* writeConfig(
            root,
            ['project_id = "demo"', "", "[api]", 'schemas = ["ancestor_only"]'].join("\n"),
          );
          const sub = path.join(root, "nested", "dir");
          yield* makeDirectory(sub);
          const { layer, dbConfig, generator } = yield* setup({
            workdir: sub,
            skipConfig: true,
            explicitWorkdir: true,
          });
          yield* genTypes(
            defaultFlags({
              dbUrl: Option.some("postgresql://postgres:postgres@127.0.0.1:5432/postgres"),
              schema: ["public"],
            }),
          ).pipe(Effect.provide(layer));

          expect(dbConfig.resolves).toHaveLength(1);
          expect(dbConfig.resolves[0]?.connType).toBe("db-url");
          expect(generator.calls[0]?.includedSchemas).toEqual(["public"]);
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "resolves db-url generation through the DbConfigResolver, defaulting schemas from config",
      () =>
        Effect.gen(function* () {
          const { layer, dbConfig, generator } = yield* setup();
          yield* genTypes(
            defaultFlags({
              dbUrl: Option.some("postgresql://postgres:postgres@127.0.0.1:5432/postgres"),
            }),
          ).pipe(Effect.provide(layer));

          expect(dbConfig.resolves[0]).toEqual({
            dbUrl: Option.some("postgresql://postgres:postgres@127.0.0.1:5432/postgres"),
            connType: "db-url",
            dnsResolver: "native",
          });
          expect(generator.calls[0]?.includedSchemas).toEqual(["public"]);
          expect(generator.calls[0]?.isLocal).toBe(false);
          expect(generator.calls[0]?.conn.runtimeParams?.["statement_timeout"]).toBe("15000");
          expect(generator.calls[0]?.conn.connectTimeoutSeconds).toBe(15);
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "keeps sub-second --query-timeout able to connect instead of disabling the timeout",
      () =>
        Effect.gen(function* () {
          const { layer, generator } = yield* setup();
          yield* genTypes(
            defaultFlags({
              dbUrl: Option.some("postgresql://postgres:postgres@127.0.0.1:5432/postgres"),
              queryTimeout: "400ms",
            }),
          ).pipe(Effect.provide(layer));

          const call = generator.calls[0];
          expect(call?.conn.runtimeParams?.["statement_timeout"]).toBe("400");
          expect(call?.conn.connectTimeoutSeconds).toBeGreaterThanOrEqual(1);
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("leaves connectTimeoutSeconds unset for --query-timeout 0s", () =>
      Effect.gen(function* () {
        const { layer, generator } = yield* setup();
        yield* genTypes(
          defaultFlags({
            dbUrl: Option.some("postgresql://postgres:postgres@127.0.0.1:5432/postgres"),
            queryTimeout: "0s",
          }),
        ).pipe(Effect.provide(layer));

        const call = generator.calls[0];
        expect(call?.conn.runtimeParams?.["statement_timeout"]).toBe("0");
        expect(call?.conn.connectTimeoutSeconds).toBeUndefined();
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "forwards --lang/--swift-access-control/--postgrest-v9-compat/--query-timeout for db-url generation",
      () =>
        Effect.gen(function* () {
          const { layer, generator } = yield* setup();
          yield* genTypes(
            defaultFlags({
              dbUrl: Option.some("postgresql://postgres:postgres@127.0.0.1:5432/postgres"),
              lang: "swift",
              schema: ["public"],
              "swift-access-control": "public",
              postgrestV9Compat: true,
              queryTimeout: "20s",
            }),
          ).pipe(Effect.provide(layer));

          const call = generator.calls[0];
          expect(call?.lang).toBe("swift");
          expect(call?.options["swift-access-control"]).toBe("public");
          expect(call?.options["detect-one-to-one-relationships"]).toBe(false);
          expect(call?.conn.runtimeParams?.["statement_timeout"]).toBe("20000");
          expect(call?.conn.connectTimeoutSeconds).toBe(20);
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("allows --postgrest-v9-compat together with --db-url", () =>
      Effect.gen(function* () {
        const { layer, generator } = yield* setup();
        yield* genTypes(
          defaultFlags({
            dbUrl: Option.some("postgresql://postgres:postgres@127.0.0.1:5432/postgres"),
            postgrestV9Compat: true,
          }),
        ).pipe(Effect.provide(layer));

        expect(generator.calls[0]?.options["detect-one-to-one-relationships"]).toBe(false);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("allows legacy positional non-typescript when --lang is explicitly set", () =>
      Effect.gen(function* () {
        const { layer, generator } = yield* setup({
          args: ["gen", "types", "go", "--lang", "go"],
        });
        yield* genTypes(
          defaultFlags({
            dbUrl: Option.some("postgresql://postgres:postgres@127.0.0.1:5432/postgres"),
            lang: "go",
            schema: ["public"],
          }),
        ).pipe(Effect.provide(layer));

        expect(generator.calls[0]?.lang).toBe("go");
      }).pipe(Effect.provide(BunServices.layer)),
    );
  });
});
