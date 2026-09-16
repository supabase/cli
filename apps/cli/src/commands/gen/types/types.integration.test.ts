import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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
import {
  ConfigProvider,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  PlatformError,
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
import type { DbConfigError } from "../../../command-internal/db-config.service.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import { DbConfigLoadError } from "../../../command-internal/db-config.errors.ts";
import type { DbConfigFlags, ResolvedDbConfig } from "../../../command-internal/db-config.types.ts";
import type { GenTypesFlags } from "./types.command.ts";
import { genTypes } from "./types.handler.ts";
import { localDbContainerId, parseQueryTimeoutSeconds, rootCaBundle } from "./types.shared.ts";
import { stackBackendLayer } from "../../../command-internal/stack-backend.ts";
import {
  GenTypesGenerationError,
  GenTypesGenerator,
  type GenTypesGenerateInput,
} from "./types.generator.service.ts";

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

function defaultFlags(overrides: Partial<GenTypesFlags> = {}): GenTypesFlags {
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
    ) => Effect.Effect<string, GenTypesGenerationError>;
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
  steps: ReadonlyArray<() => Effect.Effect<string, GenTypesGenerationError>>,
) {
  return mockGenTypesGenerator({
    generate: (_input, index) =>
      (steps[Math.min(index, steps.length - 1)] ?? (() => Effect.succeed("generated")))(),
  });
}

function ipv6Failure(lang = "go") {
  return new GenTypesGenerationError({
    message: `failed to generate ${lang} types: could not translate host name to address: No address associated with hostname`,
  });
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
        const isStandard = command._tag === "StandardCommand";
        const cmd = isStandard ? command.command : "";
        const args = isStandard ? command.args : [];
        const options = isStandard ? command.options : undefined;
        calls.push({ command: cmd, args, env: options?.env, extendEnv: options?.extendEnv });

        if (opts.dockerMissing === true && cmd === "docker") {
          return yield* Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "ChildProcess",
              method: "spawn",
              description: "docker not found",
            }),
          );
        }

        const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        yield* Effect.forkDetach(
          Effect.gen(function* () {
            yield* Effect.sleep("5 millis");
            yield* Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(opts.exitCode ?? 0));
          }),
        );
        const stderrBytes = (opts.stderr ?? []).map((line) => encoder.encode(`${line}\n`));

        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(4000 + calls.length),
          stdout: Stream.empty,
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
    get calls() {
      return calls;
    },
  };
}

type BranchConfig = typeof V1GetABranchConfigOutput.Type;
type LoginRole = typeof V1CreateLoginRoleOutput.Type;
type PoolerConfig = typeof V1GetPoolerConfigOutput.Type;
type Project = typeof V1GetProjectOutput.Type;

function setup(
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
  const workdir = opts.workdir ?? mkdtempSync(join(tmpdir(), "supabase-gen-types-"));
  if (!opts.skipConfig) {
    ensureDefaultConfig(workdir);
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
}

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
      expect(yield* parseQueryTimeoutSeconds(`15${"µ"}s`)).toBe(0);
      expect(yield* parseQueryTimeoutSeconds(`15${"μ"}s`)).toBe(0);
    }),
  );

  it.live("generates typescript types from a project ref", () => {
    const { layer, out, api, linkedProjectCache, telemetry } = setup({
      projectId: Option.some(VALID_REF),
      projectTypes: "export type Database = {};",
    });

    return Effect.gen(function* () {
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
    });
  });

  it.live("generates types from the explicit --linked flag", () => {
    const { layer, out, api, linkedProjectCache, telemetry } = setup({
      projectId: Option.some(VALID_REF),
      projectTypes: "export type Database = {};",
    });

    return Effect.gen(function* () {
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
    });
  });

  it.live("uses explicit schemas for the management API path", () => {
    const { layer, api } = setup({
      projectTypes: "ok",
    });

    return Effect.gen(function* () {
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
        yield* genTypes(
          defaultFlags({
            projectId: Option.some(VALID_REF),
          }),
        ).pipe(Effect.provide(layer));

        expect(api.requests[0]).toEqual({
          method: "generateTypescriptTypes",
          input: { ref: VALID_REF, included_schemas: "public,auth,storage" },
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
        projectId: Option.some(VALID_REF),
        projectTypes: "ok",
      });

      return Effect.gen(function* () {
        yield* genTypes(defaultFlags()).pipe(Effect.provide(layer));

        expect(api.requests[0]).toEqual({
          method: "generateTypescriptTypes",
          input: { ref: VALID_REF, included_schemas: "public,auth,storage" },
        });
      });
    },
  );

  it.live(
    "fails instead of picking up an ancestor project's configured api schemas when --workdir names a subdirectory with no config of its own",
    () => {
      const root = mkdtempSync(join(tmpdir(), "supabase-gen-types-ancestor-"));
      writeConfig(
        root,
        ['project_id = "demo"', "", "[api]", 'schemas = ["ancestor_only"]'].join("\n"),
      );
      const sub = join(root, "nested", "dir");
      mkdirSync(sub, { recursive: true });
      const { layer, api } = setup({
        workdir: sub,
        skipConfig: true,
        explicitWorkdir: true,
        projectId: Option.some(VALID_REF),
        projectTypes: "ok",
      });

      return Effect.gen(function* () {
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
      });
    },
  );

  it.live(
    "a defaulted workdir still picks up an ancestor project's configured api schemas from a subdirectory",
    () => {
      const root = mkdtempSync(join(tmpdir(), "supabase-gen-types-ancestor-"));
      writeConfig(
        root,
        ['project_id = "demo"', "", "[api]", 'schemas = ["ancestor_only"]'].join("\n"),
      );
      const sub = join(root, "nested", "dir");
      mkdirSync(sub, { recursive: true });
      const { layer, api } = setup({
        workdir: sub,
        skipConfig: true,
        explicitWorkdir: false,
        projectId: Option.some(VALID_REF),
        projectTypes: "ok",
      });

      return Effect.gen(function* () {
        yield* genTypes(defaultFlags({ projectId: Option.some(VALID_REF) })).pipe(
          Effect.provide(layer),
        );

        expect(api.requests[0]).toEqual({
          method: "generateTypescriptTypes",
          input: { ref: VALID_REF, included_schemas: "public,ancestor_only" },
        });
      });
    },
  );

  it.live(
    "an explicit --workdir naming a directory that does not exist at all fails before any config load",
    () => {
      const missing = join(tmpdir(), "supabase-gen-types-does-not-exist", "nonexistent");
      const { layer, api } = setup({
        workdir: missing,
        skipConfig: true,
        explicitWorkdir: true,
        projectId: Option.some(VALID_REF),
      });

      return Effect.gen(function* () {
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
      });
    },
  );

  it.live(
    "surfaces a real error message when supabase/config.toml is malformed, not the raw CliConfigParseError tag",
    () => {
      const workdir = mkdtempSync(join(tmpdir(), "supabase-gen-types-malformed-"));
      writeConfig(workdir, 'project_id = "unterminated\n');
      const { layer, api } = setup({
        workdir,
        skipConfig: true,
        projectId: Option.some(VALID_REF),
      });

      return Effect.gen(function* () {
        const exit = yield* genTypes(defaultFlags({ projectId: Option.some(VALID_REF) })).pipe(
          Effect.provide(layer),
          Effect.exit,
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const rendered = String(exit.cause);
          expect(rendered).toContain("GenTypesParseConfigError");
          expect(rendered).toContain("failed to parse");
          expect(rendered).toContain(join("supabase", "config.toml"));
          expect(rendered).not.toContain("CliConfigParseError");
        }
        expect(api.requests).toHaveLength(0);
      });
    },
  );

  it.live("fails when no target resolves", () => {
    const { layer } = setup();

    return Effect.gen(function* () {
      const exit = yield* genTypes(defaultFlags()).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain(
          "Must specify one of --local, --linked, --project-id, or --db-url",
        );
      }
    });
  });

  it.live("generates from --project-id without a local project config", () => {
    const workdir = mkdtempSync(join(tmpdir(), "supabase-gen-types-pid-no-config-"));
    const { layer, api } = setup({ workdir, skipConfig: true, projectTypes: "ok" });

    return Effect.gen(function* () {
      yield* genTypes(defaultFlags({ projectId: Option.some(VALID_REF) })).pipe(
        Effect.provide(layer),
      );

      expect(api.requests[0]).toEqual({
        method: "generateTypescriptTypes",
        input: { ref: VALID_REF, included_schemas: "public" },
      });
    });
  });

  it.live("resolves the linked fallback without a local project config", () => {
    const workdir = mkdtempSync(join(tmpdir(), "supabase-gen-types-fallback-no-config-"));
    const { layer, api } = setup({
      workdir,
      skipConfig: true,
      projectId: Option.some(VALID_REF),
      projectTypes: "ok",
    });

    return Effect.gen(function* () {
      yield* genTypes(defaultFlags()).pipe(Effect.provide(layer));

      expect(api.requests[0]).toEqual({
        method: "generateTypescriptTypes",
        input: { ref: VALID_REF, included_schemas: "public" },
      });
    });
  });

  it.live("ignores positional language scanning when argv lacks the gen types context", () => {
    const { layer, api } = setup({
      args: ["unrelated", "argv"],
      projectId: Option.some(VALID_REF),
      projectTypes: "ok",
    });

    return Effect.gen(function* () {
      yield* genTypes(defaultFlags({ projectId: Option.some(VALID_REF) })).pipe(
        Effect.provide(layer),
      );

      expect(api.requests).toHaveLength(1);
    });
  });

  it.live("prefers explicit --schema on the linked path", () => {
    const { layer, api } = setup({
      projectId: Option.some(VALID_REF),
      projectTypes: "ok",
    });

    return Effect.gen(function* () {
      yield* genTypes(defaultFlags({ linked: true, schema: ["auth"] })).pipe(Effect.provide(layer));
      expect(api.requests[0]).toEqual({
        method: "generateTypescriptTypes",
        input: { ref: VALID_REF, included_schemas: "auth" },
      });
    });
  });

  it.live("prefers explicit --schema on the linked fallback path", () => {
    const { layer, api } = setup({
      projectId: Option.some(VALID_REF),
      projectTypes: "ok",
    });

    return Effect.gen(function* () {
      yield* genTypes(defaultFlags({ schema: ["auth"] })).pipe(Effect.provide(layer));
      expect(api.requests[0]).toEqual({
        method: "generateTypescriptTypes",
        input: { ref: VALID_REF, included_schemas: "auth" },
      });
    });
  });

  it.live("silently ignores --query-timeout for implicit linked TypeScript generation", () => {
    const { layer, out, api } = setup({
      args: ["gen", "types", "--query-timeout", "20s"],
      projectId: Option.some(VALID_REF),
      projectTypes: "ok",
    });

    return Effect.gen(function* () {
      yield* genTypes(defaultFlags({ queryTimeout: "20s" })).pipe(Effect.provide(layer));

      expect(out.stderrText).not.toContain("--query-timeout");
      expect(api.requests).toContainEqual({
        method: "generateTypescriptTypes",
        input: { ref: VALID_REF, included_schemas: "public" },
      });
    });
  });

  it.live("maps project type generation network failures", () => {
    const { layer } = setup({
      generateTypescriptTypes: () => Effect.fail(new Error("network error")),
    });

    return Effect.gen(function* () {
      const exit = yield* genTypes(
        defaultFlags({
          projectId: Option.some(VALID_REF),
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

  it.live("accepts legacy positional typescript without changing behavior", () => {
    const { layer } = setup({
      args: ["gen", "types", "typescript"],
      projectId: Option.some(VALID_REF),
      projectTypes: "ok",
    });

    return Effect.gen(function* () {
      yield* genTypes(defaultFlags()).pipe(Effect.provide(layer));
    });
  });

  // --- Flag mutex groups and argv-scan precedence -----------------------------------------

  it.live("rejects combining --local and --linked", () => {
    const { layer, telemetry } = setup({ args: ["gen", "types", "--local", "--linked"] });

    return Effect.gen(function* () {
      const exit = yield* genTypes(defaultFlags({ local: true, linked: true })).pipe(
        Effect.provide(layer),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain(
          "if any flags in the group [local linked project-id db-url] are set none of the others can be; [linked local] were all set",
        );
      }
      expect(telemetry.flushed).toBe(true);
    });
  });

  it.live("does not misdetect a mutex flag consumed as -s's value (pflag consumption)", () => {
    // `childExitCode: 1` fails the local target's `container inspect`, keeping the
    // downstream failure deterministic once `--linked` is consumed as `-s`'s value.
    const { layer } = setup({
      args: ["gen", "types", "-s", "--linked", "--local"],
      childExitCode: 1,
    });

    return Effect.gen(function* () {
      const exit = yield* genTypes(defaultFlags({ local: true, linked: true })).pipe(
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
      const exit = yield* genTypes(
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
        VALID_REF,
        "--swift-access-control",
        "public",
        "--lang",
        "swift",
      ],
    });

    return Effect.gen(function* () {
      const exit = yield* genTypes(
        defaultFlags({
          projectId: Option.some(VALID_REF),
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
      args: ["gen", "types", "--project-id", VALID_REF, "--postgrest-v9-compat"],
    });

    return Effect.gen(function* () {
      const exit = yield* genTypes(
        defaultFlags({ projectId: Option.some(VALID_REF), postgrestV9Compat: true }),
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
    });
  });

  it.live("rejects --query-timeout with --project-id (cobra mutex group)", () => {
    const { layer } = setup({
      args: ["gen", "types", "--project-id", VALID_REF, "--query-timeout", "20s"],
    });

    return Effect.gen(function* () {
      const exit = yield* genTypes(
        defaultFlags({ projectId: Option.some(VALID_REF), queryTimeout: "20s" }),
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
      projectId: Option.some(VALID_REF),
    });

    return Effect.gen(function* () {
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
    });
  });

  it.live("counts explicitly negated booleans as set for mutex groups (pflag Changed)", () => {
    const { layer } = setup({
      args: ["gen", "types", "--linked=false", "--project-id", VALID_REF],
    });

    return Effect.gen(function* () {
      const exit = yield* genTypes(
        defaultFlags({ linked: false, projectId: Option.some(VALID_REF) }),
      ).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
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
    });
  });

  it.live("prefers the --postgrest-v9-compat guard over mutex group errors", () => {
    const { layer } = setup({
      args: ["gen", "types", "--local", "--linked", "--postgrest-v9-compat"],
    });

    return Effect.gen(function* () {
      const exit = yield* genTypes(
        defaultFlags({ local: true, linked: true, postgrestV9Compat: true }),
      ).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
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
      const exit = yield* genTypes(defaultFlags({ local: true, linked: true })).pipe(
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
      args: ["gen", "types", "--db-url", dbUrl, "--postgrest-v9-compat", "--project-id", VALID_REF],
    });

    return Effect.gen(function* () {
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
    });
  });

  it.live("rejects a non-typescript language passed after a -- separator", () => {
    const { layer } = setup({ args: ["gen", "types", "--", "go"] });

    return Effect.gen(function* () {
      const exit = yield* genTypes(defaultFlags()).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain("use --lang flag to specify the typegen language");
      }
    });
  });

  it.live("treats a trailing -- with no operand as no positional language", () => {
    const { layer, api } = setup({
      args: ["gen", "types", "--"],
      projectId: Option.some(VALID_REF),
      projectTypes: "ok",
    });

    return Effect.gen(function* () {
      yield* genTypes(defaultFlags()).pipe(Effect.provide(layer));
      expect(api.requests).toHaveLength(1);
    });
  });

  it.live("treats a positional after a valueless long flag as the language", () => {
    const { layer } = setup({ args: ["gen", "types", "--local", "go"] });

    return Effect.gen(function* () {
      const exit = yield* genTypes(defaultFlags()).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain("use --lang flag to specify the typegen language");
      }
    });
  });

  it.live("treats a positional after a valueless short flag as the language", () => {
    const { layer } = setup({ args: ["gen", "types", "-x", "go"] });

    return Effect.gen(function* () {
      const exit = yield* genTypes(defaultFlags()).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain("use --lang flag to specify the typegen language");
      }
    });
  });

  it.live("rejects legacy positional non-typescript without an explicit lang flag", () => {
    const { layer } = setup({
      args: ["gen", "types", "go"],
    });

    return Effect.gen(function* () {
      const exit = yield* genTypes(defaultFlags()).pipe(Effect.provide(layer), Effect.exit);

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
        const exit = yield* genTypes(defaultFlags()).pipe(Effect.provide(layer), Effect.exit);

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(String(exit.cause)).toContain("use --lang flag to specify the typegen language");
        }
      });
    },
  );

  // --- --network-id is a hard error on every natively-generated path ---------------------

  it.live("rejects --network-id after the gen types command path", () => {
    const { layer, generator, child } = setup({
      args: ["gen", "types", "--local", "--network-id", "net"],
    });

    return Effect.gen(function* () {
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
    });
  });

  it.live(
    "rejects a persistent --network-id set before the command path (supabase --network-id net gen types --local)",
    () => {
      const { layer, generator, child } = setup({
        args: ["--network-id", "net", "gen", "types", "--local"],
      });

      return Effect.gen(function* () {
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
      });
    },
  );

  // --- Non-TypeScript generation through the DB resolver + native generator --------------

  for (const scenario of nonTypescriptProjectRefScenarios) {
    it.live(`generates ${scenario.lang} types from a project ref through the DB resolver`, () => {
      const { layer, out, api, linkedProjectCache, dbConfig, generator } = setup({
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
          Effect.fail(new Error(`unexpected preview branch lookup for ${branch_id_or_ref}`)),
        createLoginRole: ({ ref }) =>
          Effect.fail(new Error(`unexpected login role creation for ${ref}`)),
      });

      return Effect.gen(function* () {
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
      });
    });
  }

  it.live("resolves the linked workdir DB without ad-hoc project-ref semantics", () => {
    const { layer, dbConfig } = setup({
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

    return Effect.gen(function* () {
      yield* genTypes(defaultFlags({ linked: true, lang: "go" })).pipe(Effect.provide(layer));

      expect(dbConfig.resolves).toHaveLength(1);
      expect(dbConfig.resolves[0]?.connType).toBe("linked");
      expect(dbConfig.resolves[0]?.adHocProjectRef).toBe(false);
    });
  });

  it.live("preserves resolver connection options for remote non-TypeScript typegen", () => {
    const { layer, generator } = setup({
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

    return Effect.gen(function* () {
      yield* genTypes(
        defaultFlags({
          projectId: Option.some(VALID_REF),
          lang: "go",
        }),
      ).pipe(Effect.provide(layer));

      expect(generator.calls[0]?.conn.options).toBe(`reference=${VALID_REF}`);
      expect(generator.calls[0]?.conn.user).toBe(`postgres.${VALID_REF}`);
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
        projectId: Option.some(VALID_REF),
      });

      return Effect.gen(function* () {
        yield* genTypes(
          defaultFlags({ lang: "go", queryTimeout: "20s", swiftAccessControl: "public" }),
        ).pipe(Effect.provide(layer));

        expect(dbConfig.resolves[0]?.adHocProjectRef).toBe(false);
        const call = generator.calls[0];
        expect(call?.swiftAccessControl).toBe("public");
        expect(call?.conn.runtimeParams?.["statement_timeout"]).toBe("20000");
        expect(call?.conn.connectTimeoutSeconds).toBe(20);
      });
    },
  );

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
        `project_id = "${VALID_REF}"`,
        "",
        "[remotes.staging.api]",
        'schemas = ["private"]',
        "",
      ].join("\n"),
    );
    const { layer, generator } = setup({
      workdir,
      args: ["gen", "types", "--lang", "go", "--project-id", VALID_REF],
    });

    return Effect.gen(function* () {
      yield* genTypes(
        defaultFlags({
          projectId: Option.some(VALID_REF),
          lang: "go",
        }),
      ).pipe(Effect.provide(layer));

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
        `project_id = "${VALID_REF}"`,
        "",
        "[remotes.staging.api]",
        'schemas = ["private"]',
        "",
      ].join("\n"),
    );
    const { layer, generator } = setup({
      workdir,
      projectId: Option.some(VALID_REF),
      args: ["gen", "types", "--lang", "go", "--linked"],
    });

    return Effect.gen(function* () {
      yield* genTypes(
        defaultFlags({
          linked: true,
          lang: "go",
        }),
      ).pipe(Effect.provide(layer));

      expect(generator.calls[0]?.includedSchemas).toEqual(["public", "private"]);
    });
  });

  // --- Preview-branch fallback -------------------------------------------------------------

  it.live("falls back to preview branch config for non-TypeScript project refs", () => {
    const { layer, api, dbConfig, generator } = setup({
      args: ["gen", "types", "--lang", "python", "--project-id", VALID_REF],
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
    });
  });

  it.live("falls back to preview branch config for any project 404 body", () => {
    const { layer, api, dbConfig, generator } = setup({
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

    return Effect.gen(function* () {
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
    });
  });

  it.live("fails clearly when preview branch config does not include DB credentials", () => {
    const { layer } = setup({
      args: ["gen", "types", "--lang", "python", "--project-id", VALID_REF],
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
      const exit = yield* genTypes(
        defaultFlags({
          projectId: Option.some(VALID_REF),
          lang: "python",
        }),
      ).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain("Preview branch database credentials are unavailable");
      }
    });
  });

  // --- Pooler fallback on an IPv6-classified generation failure ---------------------------

  it.live("retries through the IPv4 pooler on an IPv6-classified generation failure", () => {
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
    const { layer, out, dbConfig } = setup({
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

    return Effect.gen(function* () {
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
    });
  });

  it.live("does not retry through the pooler when the failure is not IPv6-classified", () => {
    const generator = sequentialGenerator([() => Effect.fail(nonIpv6Failure())]);
    const { layer, dbConfig } = setup({
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

    return Effect.gen(function* () {
      const exit = yield* genTypes(
        defaultFlags({ projectId: Option.some(VALID_REF), lang: "go" }),
      ).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(generator.calls).toHaveLength(1);
      expect(dbConfig.poolerFallbacks).toHaveLength(0);
    });
  });

  it.live("does not run pooler fallback a second time when the retry also fails IPv6-style", () => {
    const generator = sequentialGenerator([
      () => Effect.fail(ipv6Failure()),
      () => Effect.fail(ipv6Failure()),
    ]);
    const { layer, dbConfig } = setup({
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

    return Effect.gen(function* () {
      const exit = yield* genTypes(
        defaultFlags({ projectId: Option.some(VALID_REF), lang: "go" }),
      ).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(generator.calls).toHaveLength(2);
      expect(dbConfig.poolerFallbacks).toHaveLength(1);
    });
  });

  it.live(
    "does not retry through the pooler when the resolved connection is already a pooler host",
    () => {
      const generator = sequentialGenerator([() => Effect.fail(ipv6Failure())]);
      const { layer, out, dbConfig } = setup({
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

      return Effect.gen(function* () {
        const exit = yield* genTypes(
          defaultFlags({ projectId: Option.some(VALID_REF), lang: "go" }),
        ).pipe(Effect.provide(layer), Effect.exit);

        expect(Exit.isFailure(exit)).toBe(true);
        expect(generator.calls).toHaveLength(1);
        expect(dbConfig.poolerFallbacks).toHaveLength(0);
        expect(out.stderrText).not.toContain("Retrying via the IPv4 connection pooler.");
      });
    },
  );

  it.live("preserves the original generation error when pooler fallback resolution fails", () => {
    const generator = sequentialGenerator([() => Effect.fail(ipv6Failure())]);
    const { layer } = setup({
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

    return Effect.gen(function* () {
      const exit = yield* genTypes(
        defaultFlags({ projectId: Option.some(VALID_REF), lang: "go" }),
      ).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain("No address associated with hostname");
        expect(String(exit.cause)).not.toContain("pooler fallback failed");
      }
      expect(generator.calls).toHaveLength(1);
    });
  });

  it.live("retries preview branch generation through the branch IPv4 pooler", () => {
    const poolerHost = "aws-0-us-east-1.pooler.supabase.com";
    const generator = sequentialGenerator([
      () => Effect.fail(ipv6Failure("python")),
      () => Effect.succeed("class RetriedViaBranchPooler(BaseModel):"),
    ]);
    const { layer, api } = setup({
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

    return Effect.gen(function* () {
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
    });
  });

  it.live("skips preview branch pooler fallback when the pooler URL fails validation", () => {
    const generator = sequentialGenerator([() => Effect.fail(ipv6Failure("python"))]);
    const { layer, api } = setup({
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

    return Effect.gen(function* () {
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
    });
  });

  // --- TLS: pin the Supabase CA only where the design calls for it ------------------------

  it.live("pins the Supabase CA for a db-url pointing at a direct database host", () => {
    const { layer, generator } = setup({
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

    return Effect.gen(function* () {
      yield* genTypes(
        defaultFlags({
          dbUrl: Option.some(
            `postgresql://postgres:postgres@db.${VALID_REF}.supabase.co:5432/postgres`,
          ),
        }),
      ).pipe(Effect.provide(layer));

      expect(generator.calls[0]?.conn.sslmode).toBe("require");
      expect(generator.calls[0]?.conn.sslrootcertInline).toBe(rootCaBundle());
    });
  });

  it.live("pins the Supabase CA for a db-url pointing at the pooler host", () => {
    const { layer, generator } = setup({
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

    return Effect.gen(function* () {
      yield* genTypes(
        defaultFlags({
          dbUrl: Option.some(
            "postgresql://postgres.ref:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
          ),
        }),
      ).pipe(Effect.provide(layer));

      expect(generator.calls[0]?.conn.sslmode).toBe("require");
      expect(generator.calls[0]?.conn.sslrootcertInline).toBe(rootCaBundle());
    });
  });

  it.live("honors an explicit sslmode from the db-url's DSN on a Supabase host", () => {
    const { layer, generator } = setup({
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

    return Effect.gen(function* () {
      yield* genTypes(
        defaultFlags({
          dbUrl: Option.some(
            `postgresql://postgres:postgres@db.${VALID_REF}.supabase.co:5432/postgres?sslmode=disable`,
          ),
        }),
      ).pipe(Effect.provide(layer));

      expect(generator.calls[0]?.conn.sslmode).toBe("disable");
      expect(generator.calls[0]?.conn.sslrootcertInline).toBeUndefined();
    });
  });

  it.live("leaves a non-Supabase db-url host unpinned", () => {
    const { layer, generator } = setup({
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

    return Effect.gen(function* () {
      yield* genTypes(
        defaultFlags({
          dbUrl: Option.some("postgresql://postgres:postgres@db.example.net:5432/postgres"),
        }),
      ).pipe(Effect.provide(layer));

      expect(generator.calls[0]?.conn.sslmode).toBeUndefined();
      expect(generator.calls[0]?.conn.sslrootcertInline).toBeUndefined();
    });
  });

  it.live("never pins TLS for a local db-url target", () => {
    const { layer, generator } = setup({
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

    return Effect.gen(function* () {
      yield* genTypes(
        defaultFlags({
          dbUrl: Option.some("postgresql://postgres:postgres@127.0.0.1:5432/postgres"),
        }),
      ).pipe(Effect.provide(layer));

      expect(generator.calls[0]?.conn.sslmode).toBeUndefined();
      expect(generator.calls[0]?.conn.sslrootcertInline).toBeUndefined();
    });
  });

  // --- Local generation: legacy backend (still inspects the Docker container) -------------

  it.live(
    "generates locally via the legacy backend, connecting directly to the mapped port",
    () => {
      const workdir = mkdtempSync(join(tmpdir(), "supabase-gen-types-local-"));
      writeConfig(
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
      writeFileSync(
        join(workdir, "supabase", ".env"),
        "DOCKER_HOST=project-daemon\nSUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io\nSUPABASE_USE_SLIM_IMAGES=1\nSUPABASE_DB_PASSWORD=dotenv-password\n",
      );
      const { layer, out, linkedProjectCache, child, generator } = setup({ workdir });
      const configProvider = ConfigProvider.fromEnvRecord({}, { preserveEmptyStrings: true });

      return Effect.gen(function* () {
        yield* genTypes(defaultFlags({ local: true })).pipe(
          Effect.provide(layer),
          Effect.provideService(ConfigProvider.ConfigProvider, configProvider),
        );

        expect(out.stderrText).toContain("Connecting to 127.0.0.1 54321");
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
        expect(call?.detectOneToOneRelationships).toBe(true);
        expect(call?.conn.sslmode).toBeUndefined();
        expect(call?.conn.sslrootcertInline).toBeUndefined();
        expect(linkedProjectCache.cached).toBe(false);
      });
    },
  );

  it.live("falls back to podman when the docker executable is missing for local generation", () => {
    const workdir = mkdtempSync(join(tmpdir(), "supabase-gen-types-local-podman-"));
    writeConfig(
      workdir,
      ['project_id = "demo"', "", "[api]", 'schemas = ["public"]', "", "[db]", "port = 54321"].join(
        "\n",
      ),
    );
    const { layer, out, child, generator } = setup({ workdir, childDockerMissing: true });

    return Effect.gen(function* () {
      yield* genTypes(defaultFlags({ local: true })).pipe(Effect.provide(layer));

      expect(out.stdoutText).toContain("generated");
      expect(child.calls.map((call) => call.command)).toEqual(["docker", "podman"]);
      expect(child.calls[1]?.args).toEqual(["container", "inspect", "supabase_db_demo"]);
      expect(generator.calls).toHaveLength(1);
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
        "port = 54321",
      ].join("\n"),
    );
    const { layer, child, generator } = setup({ workdir });

    return Effect.gen(function* () {
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
        "port = 54321",
      ].join("\n"),
    );
    writeTempFile(workdir, "rest-version", "v9.0.1\n");
    const { layer, generator } = setup({ workdir });

    return Effect.gen(function* () {
      yield* genTypes(defaultFlags({ local: true })).pipe(Effect.provide(layer));

      expect(generator.calls[0]?.detectOneToOneRelationships).toBe(false);
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
        "port = 54321",
      ].join("\n"),
    );
    writeTempFile(workdir, "rest-version", "v9.0.1\n");
    const { layer, generator } = setup({ workdir });

    return Effect.gen(function* () {
      yield* genTypes(defaultFlags({ local: true })).pipe(Effect.provide(layer));

      expect(generator.calls[0]?.detectOneToOneRelationships).toBe(true);
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
        "port = 54321",
      ].join("\n"),
    );
    const { layer, generator } = setup({ workdir });

    return Effect.gen(function* () {
      yield* genTypes(defaultFlags({ local: true, schema: ["auth", "storage"] })).pipe(
        Effect.provide(layer),
      );

      expect(generator.calls[0]?.includedSchemas).toEqual(["auth", "storage"]);
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

    return Effect.gen(function* () {
      yield* genTypes(
        defaultFlags({ local: true, lang: "python", swiftAccessControl: "public" }),
      ).pipe(Effect.provide(layer));

      expect(generator.calls[0]?.lang).toBe("python");
      expect(generator.calls[0]?.swiftAccessControl).toBe("public");
    });
  });

  it.live("falls back to the workdir basename when config has no project_id", () => {
    const workdir = mkdtempSync(join(tmpdir(), "supabase-gen-types-local-noid-"));
    writeConfig(workdir, ["[api]", 'schemas = ["public"]', "", "[db]", "port = 54321"].join("\n"));
    const { layer, child } = setup({ workdir });

    return Effect.gen(function* () {
      yield* genTypes(defaultFlags({ local: true })).pipe(Effect.provide(layer));

      const inspectId = child.calls[0]?.args[2] ?? "";
      expect(inspectId.startsWith("supabase_db_")).toBe(true);
      expect(inspectId).not.toBe("supabase_db_demo");
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
      const exit = yield* genTypes(defaultFlags({ local: true })).pipe(
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
    const { layer, child } = setup({
      workdir,
      childDockerMissing: true,
      childExitCode: 1,
      childStderr: ['Error: inspecting object: no such container "supabase_db_demo"'],
    });

    return Effect.gen(function* () {
      const exit = yield* genTypes(defaultFlags({ local: true })).pipe(
        Effect.provide(layer),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain("supabase start is not running.");
      }
      expect(child.calls.map((call) => call.command)).toEqual(["docker", "podman"]);
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
        const exit = yield* genTypes(defaultFlags({ local: true })).pipe(
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
    const { layer, out, child, generator } = setup({ workdir, skipConfig: true });

    return Effect.gen(function* () {
      yield* genTypes(defaultFlags({ local: true })).pipe(Effect.provide(layer));

      const projectId = basename(workdir);
      expect(child.calls[0]?.args).toEqual(["container", "inspect", localDbContainerId(projectId)]);
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
        "SUPABASE_API_SCHEMAS=private,graphql_public",
        "SUPABASE_SERVICES_HOSTNAME=host.docker.internal",
        "SUPABASE_INTERNAL_IMAGE_REGISTRY=mirror.example.com",
        "",
      ].join("\n"),
    );
    const { layer, out, child, generator } = setup({ workdir, skipConfig: true });

    return Effect.gen(function* () {
      yield* genTypes(defaultFlags({ local: true })).pipe(Effect.provide(layer));

      expect(child.calls[0]?.args).toEqual([
        "container",
        "inspect",
        localDbContainerId("configless-env-project"),
      ]);
      expect(child.calls[0]?.env?.["SUPABASE_INTERNAL_IMAGE_REGISTRY"]).toBe("mirror.example.com");
      expect(generator.calls[0]?.conn.host).toBe("host.docker.internal");
      expect(generator.calls[0]?.conn.port).toBe(55432);
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
      const exit = yield* genTypes(defaultFlags({ local: true })).pipe(
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

  it.live("surfaces generation failures after local db inspection succeeds", () => {
    const workdir = mkdtempSync(join(tmpdir(), "supabase-gen-types-local-run-error-"));
    writeConfig(
      workdir,
      ['project_id = "demo"', "", "[api]", 'schemas = ["public"]', "", "[db]", "port = 54321"].join(
        "\n",
      ),
    );
    const generator = mockGenTypesGenerator({
      generate: () =>
        Effect.fail(
          new GenTypesGenerationError({ message: "failed to generate typescript types: boom" }),
        ),
    });
    const { layer, child } = setup({ workdir, generator });

    return Effect.gen(function* () {
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
    });
  });

  // --- Local generation: stack backend (no Docker inspection at all) ----------------------

  it.live("resolves the stack local database directly, without inspecting any container", () => {
    const workdir = mkdtempSync(join(tmpdir(), "supabase-gen-types-stack-local-"));
    writeConfig(
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
    const { layer, out, child, dbConfig, generator } = setup({
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

    return Effect.gen(function* () {
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
    });
  });

  // --- db-url generation ---------------------------------------------------------------

  it.live(
    "--db-url --schema succeeds on an explicit --workdir with no project of its own, since an explicit schema never needs the config load",
    () => {
      const root = mkdtempSync(join(tmpdir(), "supabase-gen-types-ancestor-"));
      writeConfig(
        root,
        ['project_id = "demo"', "", "[api]", 'schemas = ["ancestor_only"]'].join("\n"),
      );
      const sub = join(root, "nested", "dir");
      mkdirSync(sub, { recursive: true });
      const { layer, dbConfig, generator } = setup({
        workdir: sub,
        skipConfig: true,
        explicitWorkdir: true,
      });

      return Effect.gen(function* () {
        yield* genTypes(
          defaultFlags({
            dbUrl: Option.some("postgresql://postgres:postgres@127.0.0.1:5432/postgres"),
            schema: ["public"],
          }),
        ).pipe(Effect.provide(layer));

        expect(dbConfig.resolves).toHaveLength(1);
        expect(dbConfig.resolves[0]?.connType).toBe("db-url");
        expect(generator.calls[0]?.includedSchemas).toEqual(["public"]);
      });
    },
  );

  it.live(
    "resolves db-url generation through the DbConfigResolver, defaulting schemas from config",
    () => {
      const { layer, dbConfig, generator } = setup();

      return Effect.gen(function* () {
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
      });
    },
  );

  it.live(
    "forwards --lang/--swift-access-control/--postgrest-v9-compat/--query-timeout for db-url generation",
    () => {
      const { layer, generator } = setup();

      return Effect.gen(function* () {
        yield* genTypes(
          defaultFlags({
            dbUrl: Option.some("postgresql://postgres:postgres@127.0.0.1:5432/postgres"),
            lang: "swift",
            schema: ["public"],
            swiftAccessControl: "public",
            postgrestV9Compat: true,
            queryTimeout: "20s",
          }),
        ).pipe(Effect.provide(layer));

        const call = generator.calls[0];
        expect(call?.lang).toBe("swift");
        expect(call?.swiftAccessControl).toBe("public");
        expect(call?.detectOneToOneRelationships).toBe(false);
        expect(call?.conn.runtimeParams?.["statement_timeout"]).toBe("20000");
        expect(call?.conn.connectTimeoutSeconds).toBe(20);
      });
    },
  );

  it.live("allows --postgrest-v9-compat together with --db-url", () => {
    const { layer, generator } = setup();

    return Effect.gen(function* () {
      yield* genTypes(
        defaultFlags({
          dbUrl: Option.some("postgresql://postgres:postgres@127.0.0.1:5432/postgres"),
          postgrestV9Compat: true,
        }),
      ).pipe(Effect.provide(layer));

      expect(generator.calls[0]?.detectOneToOneRelationships).toBe(false);
    });
  });

  it.live("allows legacy positional non-typescript when --lang is explicitly set", () => {
    const { layer, generator } = setup({
      args: ["gen", "types", "go", "--lang", "go"],
    });

    return Effect.gen(function* () {
      yield* genTypes(
        defaultFlags({
          dbUrl: Option.some("postgresql://postgres:postgres@127.0.0.1:5432/postgres"),
          lang: "go",
          schema: ["public"],
        }),
      ).pipe(Effect.provide(layer));

      expect(generator.calls[0]?.lang).toBe("go");
    });
  });
});
