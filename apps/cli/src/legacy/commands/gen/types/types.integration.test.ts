import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { ChildProcessSpawner } from "effect/unstable/process";
import { CliOutput, Command } from "effect/unstable/cli";
import { Deferred, Effect, Exit, Layer, Option, Sink, Stdio, Stream } from "effect";
import {
  LEGACY_GLOBAL_FLAGS,
  LegacyDebugFlag,
  LegacyNetworkIdFlag,
  LegacyOutputFlag,
} from "../../../../shared/legacy/global-flags.ts";
import { LegacyPlatformApiFactory } from "../../../auth/legacy-platform-api-factory.service.ts";
import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import {
  mockAnalytics,
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
  mockTty,
  processEnvLayer,
} from "../../../../../tests/helpers/mocks.ts";
import {
  buildLegacyTestRuntime,
  LEGACY_VALID_REF,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApiService,
  mockLegacyTelemetryStateTracked,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { mockChildProcessSpawner } from "../../../../../../../packages/process-compose/tests/helpers/mocks.ts";
import { textCliOutputFormatter } from "../../../../shared/output/text-formatter.ts";
import { TelemetryRuntime } from "../../../../shared/telemetry/runtime.service.ts";
import { legacyGenCommand } from "../gen.command.ts";
import type { LegacyGenTypesFlags } from "./types.command.ts";
import { legacyGenTypes } from "./types.handler.ts";
import { parseQueryTimeoutSeconds, resolvePgmetaImage } from "./types.shared.ts";

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

/** Extracts the `KEY=VALUE` entries passed via `docker run --env <entry>` arguments. */
function dockerEnv(args: ReadonlyArray<string>) {
  const entries: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--env") {
      const entry = args[index + 1];
      if (entry !== undefined) {
        entries.push(entry);
      }
    }
  }
  return {
    entries,
    has: (entry: string) => entries.includes(entry),
    startsWith: (prefix: string) => entries.some((entry) => entry.startsWith(prefix)),
  };
}

/** The argv of the `docker run` invocation captured during a spawn. */
function captureDockerRun() {
  let args: ReadonlyArray<string> | undefined;
  return {
    onSpawn: (record: { readonly command: string; readonly args: ReadonlyArray<string> }) => {
      if (record.command === "docker" && record.args.includes("run")) {
        args = record.args;
      }
    },
    get args() {
      return args;
    },
    get env() {
      return dockerEnv(args ?? []);
    },
  };
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

function setup(
  opts: {
    readonly workdir?: string;
    readonly skipConfig?: boolean;
    readonly projectId?: Option.Option<string>;
    readonly format?: "text" | "json" | "stream-json";
    readonly goOutput?: Option.Option<"env" | "pretty" | "json" | "toml" | "yaml">;
    readonly projectTypes?: string;
    readonly childStdout?: ReadonlyArray<string>;
    readonly childStderr?: ReadonlyArray<string>;
    readonly childExitCode?: number;
    readonly childLayer?: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
    readonly debug?: boolean;
    readonly networkId?: Option.Option<string>;
    readonly onSpawn?: (record: {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
    }) => void;
    readonly args?: ReadonlyArray<string>;
    readonly generateTypescriptTypes?: (input: {
      readonly ref: string;
      readonly included_schemas?: string;
    }) => Effect.Effect<{ readonly types: string }, unknown>;
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
  const processControl = mockProcessControl();
  const child = mockChildProcessSpawner({
    stdout: [...(opts.childStdout ?? [])],
    stderr: [...(opts.childStderr ?? [])],
    exitCode: opts.childExitCode ?? 0,
    onSpawn: opts.onSpawn,
  });
  const api = mockLegacyPlatformApiService({
    v1: {
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
    cliConfig: mockLegacyCliConfig({
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
    Layer.succeed(LegacyNetworkIdFlag, opts.networkId ?? Option.none()),
    Layer.succeed(LegacyPlatformApiFactory, {
      make: LegacyPlatformApi.pipe(Effect.provide(api.layer)),
    }),
  );

  return {
    workdir,
    out,
    telemetry,
    linkedProjectCache,
    processControl,
    child,
    api,
    layer,
  };
}

function mockSequentialChildProcessSpawner(
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
          pid: ChildProcessSpawner.ProcessId(2000 + spawned.length),
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

async function withSslProbeServer<T>(
  run: (port: number) => Promise<T>,
  response: "N" | "S" = "N",
): Promise<T> {
  const server = createServer((socket) => {
    socket.once("data", () => {
      socket.write(Buffer.from(response));
      socket.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("failed to bind ssl probe server");
  }

  try {
    return await run(address.port);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

const legacyTestRoot = Command.make("supabase").pipe(
  Command.withGlobalFlags(LEGACY_GLOBAL_FLAGS),
  Command.withSubcommands([legacyGenCommand]),
);

describe("legacy gen types", () => {
  it.effect("accepts Go-style microsecond duration aliases", () =>
    Effect.gen(function* () {
      expect(yield* parseQueryTimeoutSeconds(`15${"µ"}s`)).toBe(0);
      expect(yield* parseQueryTimeoutSeconds(`15${"μ"}s`)).toBe(0);
    }),
  );

  it.live("runs tokenless local generation through command wiring", () =>
    Effect.tryPromise({
      try: () =>
        withSslProbeServer(async (port) => {
          const workdir = mkdtempSync(join(tmpdir(), "supabase-gen-types-command-local-"));
          writeConfig(
            workdir,
            [
              'project_id = "demo"',
              "",
              "[api]",
              'schemas = ["public"]',
              "",
              "[db]",
              `port = ${port}`,
            ].join("\n"),
          );
          const out = mockOutput({ format: "text", interactive: false });
          const analytics = mockAnalytics();
          const child = mockSequentialChildProcessSpawner([
            { exitCode: 0 },
            { exitCode: 0, stdout: ["export type Database = {};"] },
          ]);
          const args = [
            "gen",
            "types",
            "typescript",
            "--local",
            "--schema",
            "public",
            "--workdir",
            workdir,
          ];
          const layer = Layer.mergeAll(
            BunServices.layer,
            CliOutput.layer(textCliOutputFormatter()),
            out.layer,
            analytics.layer,
            processEnvLayer({ SUPABASE_HOME: workdir }),
            mockRuntimeInfo({ cwd: workdir, homeDir: workdir }),
            mockTty({ stdinIsTty: false, stdoutIsTty: false }),
            child.layer,
            Stdio.layerTest({ args: Effect.succeed(args) }),
            Layer.succeed(
              TelemetryRuntime,
              TelemetryRuntime.of({
                configDir: join(workdir, ".supabase"),
                tracesDir: join(workdir, ".supabase", "traces"),
                consent: "granted",
                showDebug: false,
                deviceId: "test-device-id",
                sessionId: "test-session-id",
                distinctId: undefined,
                isFirstRun: false,
                isTty: false,
                isCi: false,
                os: "linux",
                arch: "x64",
                cliVersion: "0.1.0",
              }),
            ),
          );

          await Effect.runPromise(
            Command.runWith(legacyTestRoot, { version: "0.0.0-test" })(args).pipe(
              Effect.provide(layer),
            ) as Effect.Effect<void>,
          );

          expect(out.stdoutText).toContain("export type Database = {};");
          expect(out.stderrText).not.toContain("Access token not provided");
          expect(child.spawned).toHaveLength(2);
        }),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }),
  );

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
    const { layer } = setup({ args: ["gen", "types", "--local", "--linked"] });

    return Effect.gen(function* () {
      const exit = yield* legacyGenTypes(defaultFlags({ local: true, linked: true })).pipe(
        Effect.provide(layer),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain(
          "if any flags in the group [local linked project-id db-url] are set none of the others can be; [local linked] were all set",
        );
      }
    });
  });

  it.live("rejects combining --linked with --swift-access-control", () => {
    const { layer } = setup({
      args: ["gen", "types", "--linked", "--swift-access-control", "public"],
    });

    return Effect.gen(function* () {
      const exit = yield* legacyGenTypes(
        defaultFlags({ linked: true, swiftAccessControl: "public" }),
      ).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain(
          "if any flags in the group [linked project-id swift-access-control] are set none of the others can be; [linked swift-access-control] were all set",
        );
      }
    });
  });

  it.live("rejects combining --linked with --postgrest-v9-compat", () => {
    const { layer } = setup({ args: ["gen", "types", "--linked", "--postgrest-v9-compat"] });

    return Effect.gen(function* () {
      const exit = yield* legacyGenTypes(
        defaultFlags({ linked: true, postgrestV9Compat: true }),
      ).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain(
          "if any flags in the group [linked project-id postgrest-v9-compat] are set none of the others can be; [linked postgrest-v9-compat] were all set",
        );
      }
    });
  });

  it.live("rejects combining --linked with --query-timeout", () => {
    const { layer } = setup({ args: ["gen", "types", "--linked", "--query-timeout", "20s"] });

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

  it.live("requires --db-url when --postgrest-v9-compat is set", () => {
    const { layer } = setup({ args: ["gen", "types", "--local", "--postgrest-v9-compat"] });

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
    });
  });

  it.live("rejects non-typescript project generation", () => {
    const { layer } = setup({ args: ["gen", "types", "--lang", "go"] });

    return Effect.gen(function* () {
      const exit = yield* legacyGenTypes(
        defaultFlags({
          projectId: Option.some(LEGACY_VALID_REF),
          lang: "go",
        }),
      ).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain("Try using --db-url flag instead.");
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

  it.live("spawns pg-meta for local generation and forwards child output", () =>
    Effect.tryPromise({
      try: () =>
        withSslProbeServer(async (port) => {
          const docker = captureDockerRun();
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
              `port = ${port}`,
            ].join("\n"),
          );

          const { layer, out, child, linkedProjectCache } = setup({
            workdir,
            childStdout: ["export type Database = {};"],
            childStderr: ["pg-meta warning"],
            onSpawn: docker.onSpawn,
          });

          await Effect.runPromise(
            legacyGenTypes(defaultFlags({ local: true })).pipe(Effect.provide(layer)),
          );

          expect(out.stderrText).toContain("Connecting to db 5432");
          expect(out.stderrText).toContain("pg-meta warning");
          expect(out.stdoutText).toContain("export type Database = {};");
          expect(child.spawned).toHaveLength(2);
          expect(child.spawned[0]).toEqual({
            command: "docker",
            args: ["container", "inspect", "supabase_db_demo"],
          });
          expect(child.spawned[1]?.command).toBe("docker");
          expect(child.spawned[1]?.args).toContain("--network");
          expect(child.spawned[1]?.args).toContain("supabase_network_demo");
          expect(docker.env.has("PG_META_GENERATE_TYPES_INCLUDED_SCHEMAS=public,custom")).toBe(
            true,
          );
          expect(child.spawned[1]?.args).toContain(resolvePgmetaImage());
          // The local/db-url paths have no project ref, so they must not populate the
          // linked-project cache (matches Go's ensureProjectGroupsCached early return).
          expect(linkedProjectCache.cached).toBe(false);
        }),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }),
  );

  it.live("uses sanitized local docker ids and env-backed local db passwords", () =>
    Effect.tryPromise({
      try: () =>
        withSslProbeServer(async (port) => {
          const docker = captureDockerRun();
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
              `port = ${port}`,
            ].join("\n"),
          );

          const previousPassword = process.env["SUPABASE_DB_PASSWORD"];
          process.env["SUPABASE_DB_PASSWORD"] = "secret-password";
          try {
            const { layer, child } = setup({
              workdir,
              childStdout: ["generated"],
              onSpawn: docker.onSpawn,
            });

            await Effect.runPromise(
              legacyGenTypes(defaultFlags({ local: true })).pipe(Effect.provide(layer)),
            );

            expect(child.spawned[0]).toEqual({
              command: "docker",
              args: ["container", "inspect", "supabase_db_demo_project_with_spaces"],
            });
            expect(child.spawned[1]?.args).toContain("supabase_network_demo_project_with_spaces");
            expect(
              docker.env.has(
                "PG_META_DB_URL=postgresql://postgres:secret-password@db:5432/postgres?connect_timeout=10",
              ),
            ).toBe(true);
          } finally {
            if (previousPassword === undefined) {
              delete process.env["SUPABASE_DB_PASSWORD"];
            } else {
              process.env["SUPABASE_DB_PASSWORD"] = previousPassword;
            }
          }
        }),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }),
  );

  it.live("forces v9 compat when rest-version reports v9 on a modern database", () =>
    Effect.tryPromise({
      try: () =>
        withSslProbeServer(async (port) => {
          const docker = captureDockerRun();
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
              `port = ${port}`,
            ].join("\n"),
          );
          writeTempFile(workdir, "rest-version", "v9.0.1\n");

          const { layer } = setup({
            workdir,
            childStdout: ["generated"],
            onSpawn: docker.onSpawn,
          });

          await Effect.runPromise(
            legacyGenTypes(defaultFlags({ local: true })).pipe(Effect.provide(layer)),
          );

          expect(
            docker.env.has("PG_META_GENERATE_TYPES_DETECT_ONE_TO_ONE_RELATIONSHIPS=false"),
          ).toBe(true);
        }),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }),
  );

  it.live("ignores rest-version v9 marker on databases older than 15", () =>
    Effect.tryPromise({
      try: () =>
        withSslProbeServer(async (port) => {
          const docker = captureDockerRun();
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
              `port = ${port}`,
            ].join("\n"),
          );
          writeTempFile(workdir, "rest-version", "v9.0.1\n");

          const { layer } = setup({
            workdir,
            childStdout: ["generated"],
            onSpawn: docker.onSpawn,
          });

          await Effect.runPromise(
            legacyGenTypes(defaultFlags({ local: true })).pipe(Effect.provide(layer)),
          );

          expect(
            docker.env.has("PG_META_GENERATE_TYPES_DETECT_ONE_TO_ONE_RELATIONSHIPS=true"),
          ).toBe(true);
        }),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }),
  );

  it.live("overrides the pg-meta image version from the pgmeta-version temp file", () =>
    Effect.tryPromise({
      try: () =>
        withSslProbeServer(async (port) => {
          const docker = captureDockerRun();
          const workdir = mkdtempSync(join(tmpdir(), "supabase-gen-types-local-pgmeta-"));
          writeConfig(
            workdir,
            [
              'project_id = "demo"',
              "",
              "[api]",
              'schemas = ["public"]',
              "",
              "[db]",
              `port = ${port}`,
            ].join("\n"),
          );
          writeTempFile(workdir, "pgmeta-version", "v0.99.0\n");

          const { layer, child } = setup({
            workdir,
            childStdout: ["generated"],
            onSpawn: docker.onSpawn,
          });

          await Effect.runPromise(
            legacyGenTypes(defaultFlags({ local: true })).pipe(Effect.provide(layer)),
          );

          expect(child.spawned[1]?.args).toContain(resolvePgmetaImage("0.99.0"));
        }),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }),
  );

  it.live("prefers explicit --schema over config schemas for local generation", () =>
    Effect.tryPromise({
      try: () =>
        withSslProbeServer(async (port) => {
          const docker = captureDockerRun();
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
              `port = ${port}`,
            ].join("\n"),
          );
          const { layer } = setup({ workdir, childStdout: ["generated"], onSpawn: docker.onSpawn });

          await Effect.runPromise(
            legacyGenTypes(defaultFlags({ local: true, schema: ["auth", "storage"] })).pipe(
              Effect.provide(layer),
            ),
          );

          expect(docker.env.has("PG_META_GENERATE_TYPES_INCLUDED_SCHEMAS=auth,storage")).toBe(true);
        }),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }),
  );

  it.live("falls back to the workdir basename when config has no project_id", () =>
    Effect.tryPromise({
      try: () =>
        withSslProbeServer(async (port) => {
          const workdir = mkdtempSync(join(tmpdir(), "supabase-gen-types-local-noid-"));
          writeConfig(
            workdir,
            ["[api]", 'schemas = ["public"]', "", "[db]", `port = ${port}`].join("\n"),
          );
          const { layer, child } = setup({ workdir, childStdout: ["generated"] });

          await Effect.runPromise(
            legacyGenTypes(defaultFlags({ local: true })).pipe(Effect.provide(layer)),
          );

          const inspectId = child.spawned[0]?.args[2] ?? "";
          expect(inspectId.startsWith("supabase_db_")).toBe(true);
          expect(inspectId).not.toBe("supabase_db_demo");
        }),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }),
  );

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

  it.live("ignores positional language scanning when argv lacks the gen types context", () => {
    const { layer, api } = setup({
      args: ["unrelated", "argv"],
      projectId: Option.some(LEGACY_VALID_REF),
      projectTypes: "ok",
    });

    return Effect.gen(function* () {
      yield* legacyGenTypes(defaultFlags({ projectId: Option.some(LEGACY_VALID_REF) })).pipe(
        Effect.provide(layer),
      );

      expect(api.requests).toHaveLength(1);
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

  it.live("treats a positional after a valueless short flag as the language", () => {
    const { layer } = setup({ args: ["gen", "types", "-x", "go"] });

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

  it.live("fails local generation when supabase/config.toml is missing", () => {
    const workdir = mkdtempSync(join(tmpdir(), "supabase-gen-types-local-no-config-"));
    const { layer } = setup({ workdir, skipConfig: true });

    return Effect.gen(function* () {
      const exit = yield* legacyGenTypes(defaultFlags({ local: true })).pipe(
        Effect.provide(layer),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain(
          "failed to load config: supabase/config.toml not found",
        );
      }
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

  it.live("defaults schemas to public for a db-url run without a project config", () =>
    Effect.tryPromise({
      try: () =>
        withSslProbeServer(async (port) => {
          const docker = captureDockerRun();
          const workdir = mkdtempSync(join(tmpdir(), "supabase-gen-types-dburl-no-config-"));
          const { layer } = setup({
            workdir,
            skipConfig: true,
            childStdout: ["generated"],
            onSpawn: docker.onSpawn,
          });

          await Effect.runPromise(
            legacyGenTypes(
              defaultFlags({
                dbUrl: Option.some(`postgresql://postgres:postgres@127.0.0.1:${port}/postgres`),
              }),
            ).pipe(Effect.provide(layer)),
          );

          expect(docker.env.has("PG_META_GENERATE_TYPES_INCLUDED_SCHEMAS=public")).toBe(true);
        }),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }),
  );

  it.live("surfaces pg-meta container failures after local db inspection succeeds", () => {
    return Effect.tryPromise({
      try: () =>
        withSslProbeServer(async (port) => {
          const workdir = mkdtempSync(join(tmpdir(), "supabase-gen-types-local-run-error-"));
          writeConfig(
            workdir,
            [
              'project_id = "demo"',
              "",
              "[api]",
              'schemas = ["public"]',
              "",
              "[db]",
              `port = ${port}`,
            ].join("\n"),
          );
          const sequence = mockSequentialChildProcessSpawner([
            { exitCode: 0 },
            { exitCode: 1, stderr: ["pg-meta failed"] },
          ]);
          const { layer } = setup({
            workdir,
            childLayer: sequence.layer,
          });

          const exit = await Effect.runPromise(
            legacyGenTypes(defaultFlags({ local: true })).pipe(Effect.provide(layer), Effect.exit),
          );

          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(String(exit.cause)).toContain("error running container: exit 1");
          }
          expect(sequence.spawned).toHaveLength(2);
        }),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    });
  });

  it.live("spawns pg-meta for db-url generation", () =>
    Effect.tryPromise({
      try: () =>
        withSslProbeServer(async (port) => {
          const docker = captureDockerRun();
          const { layer, out, child } = setup({
            childStdout: ["generated"],
            onSpawn: docker.onSpawn,
          });

          await Effect.runPromise(
            legacyGenTypes(
              defaultFlags({
                dbUrl: Option.some(`postgresql://postgres:postgres@127.0.0.1:${port}/postgres`),
                lang: "swift",
                schema: ["public"],
                swiftAccessControl: "public",
                postgrestV9Compat: true,
                queryTimeout: "20s",
              }),
            ).pipe(Effect.provide(layer)),
          );

          expect(out.stderrText).toContain(`Connecting to 127.0.0.1 ${port}`);
          expect(child.spawned[0]?.args).toContain("--network");
          expect(child.spawned[0]?.args).toContain("host");
          expect(docker.env.has("PG_META_GENERATE_TYPES=swift")).toBe(true);
          expect(docker.env.has("PG_QUERY_TIMEOUT_SECS=20")).toBe(true);
          expect(
            docker.env.has("PG_META_GENERATE_TYPES_DETECT_ONE_TO_ONE_RELATIONSHIPS=false"),
          ).toBe(true);
        }),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }),
  );

  it.live("injects the CA bundle env var when the database speaks TLS", () =>
    Effect.tryPromise({
      try: () =>
        withSslProbeServer(async (port) => {
          const docker = captureDockerRun();
          const { layer } = setup({
            childStdout: ["generated"],
            onSpawn: docker.onSpawn,
          });

          await Effect.runPromise(
            legacyGenTypes(
              defaultFlags({
                dbUrl: Option.some(`postgresql://postgres:postgres@127.0.0.1:${port}/postgres`),
                schema: ["public"],
              }),
            ).pipe(Effect.provide(layer)),
          );

          expect(docker.env.startsWith("PG_META_DB_SSL_ROOT_CERT=")).toBe(true);
        }, "S"),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }),
  );

  it.live("omits the CA bundle env var in --debug mode even when TLS is supported", () =>
    Effect.tryPromise({
      try: () =>
        withSslProbeServer(async (port) => {
          const docker = captureDockerRun();
          const { layer } = setup({
            childStdout: ["generated"],
            debug: true,
            onSpawn: docker.onSpawn,
          });

          await Effect.runPromise(
            legacyGenTypes(
              defaultFlags({
                dbUrl: Option.some(`postgresql://postgres:postgres@127.0.0.1:${port}/postgres`),
                schema: ["public"],
              }),
            ).pipe(Effect.provide(layer)),
          );

          expect(docker.env.startsWith("PG_META_DB_SSL_ROOT_CERT=")).toBe(false);
        }, "S"),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }),
  );

  it.live("warns on stderr when SUPABASE_CA_SKIP_VERIFY is enabled", () =>
    Effect.tryPromise({
      try: () =>
        withSslProbeServer(async (port) => {
          const previous = process.env["SUPABASE_CA_SKIP_VERIFY"];
          process.env["SUPABASE_CA_SKIP_VERIFY"] = "true";
          try {
            const { layer, out } = setup({ childStdout: ["generated"] });

            await Effect.runPromise(
              legacyGenTypes(
                defaultFlags({
                  dbUrl: Option.some(`postgresql://postgres:postgres@127.0.0.1:${port}/postgres`),
                  schema: ["public"],
                }),
              ).pipe(Effect.provide(layer)),
            );

            expect(out.stderrText).toContain(
              "WARNING: TLS certificate verification disabled for SSL probe (SUPABASE_CA_SKIP_VERIFY=true)",
            );
          } finally {
            if (previous === undefined) {
              delete process.env["SUPABASE_CA_SKIP_VERIFY"];
            } else {
              process.env["SUPABASE_CA_SKIP_VERIFY"] = previous;
            }
          }
        }),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }),
  );

  it.live("honors the --network-id override for the db-url connection", () =>
    Effect.tryPromise({
      try: () =>
        withSslProbeServer(async (port) => {
          const docker = captureDockerRun();
          const { layer, child } = setup({
            childStdout: ["generated"],
            networkId: Option.some("custom-network"),
            onSpawn: docker.onSpawn,
          });

          await Effect.runPromise(
            legacyGenTypes(
              defaultFlags({
                dbUrl: Option.some(`postgresql://postgres:postgres@127.0.0.1:${port}/postgres`),
                schema: ["public"],
              }),
            ).pipe(Effect.provide(layer)),
          );

          expect(child.spawned[0]?.args).toContain("custom-network");
          expect(child.spawned[0]?.args).not.toContain("host");
        }),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }),
  );

  it.live("defaults bare db-url connections to the postgres database", () =>
    Effect.tryPromise({
      try: () =>
        withSslProbeServer(async (port) => {
          const docker = captureDockerRun();
          const { layer } = setup({
            childStdout: ["generated"],
            onSpawn: docker.onSpawn,
          });

          await Effect.runPromise(
            legacyGenTypes(
              defaultFlags({
                dbUrl: Option.some(`postgresql://postgres:postgres@127.0.0.1:${port}`),
                lang: "swift",
                schema: ["public"],
                swiftAccessControl: "public",
                postgrestV9Compat: true,
                queryTimeout: "20s",
              }),
            ).pipe(Effect.provide(layer)),
          );

          expect(
            docker.env.has(
              `PG_META_DB_URL=postgresql://postgres:postgres@127.0.0.1:${port}/postgres`,
            ),
          ).toBe(true);
        }),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }),
  );

  it.live("accepts legacy positional typescript without changing behavior", () => {
    const { layer } = setup({
      args: ["gen", "types", "typescript"],
      projectId: Option.some(LEGACY_VALID_REF),
      projectTypes: "ok",
    });

    return Effect.gen(function* () {
      yield* legacyGenTypes(defaultFlags()).pipe(Effect.provide(layer));
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

  it.live("allows legacy positional non-typescript when --lang is explicitly set", () =>
    Effect.tryPromise({
      try: () =>
        withSslProbeServer(async (port) => {
          const docker = captureDockerRun();
          const { layer } = setup({
            args: ["gen", "types", "go", "--lang", "go"],
            childStdout: ["generated"],
            onSpawn: docker.onSpawn,
          });

          await Effect.runPromise(
            legacyGenTypes(
              defaultFlags({
                dbUrl: Option.some(`postgresql://postgres:postgres@127.0.0.1:${port}/postgres`),
                lang: "go",
                schema: ["public"],
              }),
            ).pipe(Effect.provide(layer)),
          );

          expect(docker.env.has("PG_META_GENERATE_TYPES=go")).toBe(true);
        }),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }),
  );
});
