import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { ChildProcessSpawner } from "effect/unstable/process";
import { Deferred, Effect, Exit, Layer, Option, Sink, Stdio, Stream } from "effect";
import {
  LegacyDebugFlag,
  LegacyNetworkIdFlag,
  LegacyOutputFlag,
} from "../../../../shared/legacy/global-flags.ts";
import { mockOutput, mockProcessControl } from "../../../../../tests/helpers/mocks.ts";
import {
  buildLegacyTestRuntime,
  LEGACY_VALID_REF,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApiService,
  mockLegacyTelemetryStateTracked,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { mockChildProcessSpawner } from "../../../../../../../packages/process-compose/tests/helpers/mocks.ts";
import type { LegacyGenTypesFlags } from "./types.command.ts";
import { legacyGenTypes } from "./types.handler.ts";
import { parseQueryTimeoutSeconds, resolvePgmetaImage } from "./types.shared.ts";

function writeConfig(workdir: string, contents: string) {
  const supabaseDir = join(workdir, "supabase");
  mkdirSync(supabaseDir, { recursive: true });
  writeFileSync(join(supabaseDir, "config.toml"), contents);
}

function ensureDefaultConfig(workdir: string) {
  const configPath = join(workdir, "supabase", "config.toml");
  if (existsSync(configPath)) {
    return;
  }
  writeConfig(workdir, ['project_id = "demo"', "", "[api]", "schemas = []"].join("\n"));
}

function readEnvFileArg(args: ReadonlyArray<string>) {
  const index = args.indexOf("--env-file");
  expect(index).toBeGreaterThanOrEqual(0);
  const envFilePath = args[index + 1];
  expect(envFilePath).toBeDefined();
  expect(existsSync(envFilePath!)).toBe(true);
  return {
    envFilePath: envFilePath!,
    contents: readFileSync(envFilePath!, "utf8"),
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
    readonly projectId?: Option.Option<string>;
    readonly format?: "text" | "json" | "stream-json";
    readonly goOutput?: Option.Option<"env" | "pretty" | "json" | "toml" | "yaml">;
    readonly projectTypes?: string;
    readonly childStdout?: ReadonlyArray<string>;
    readonly childStderr?: ReadonlyArray<string>;
    readonly childExitCode?: number;
    readonly childLayer?: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
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
  ensureDefaultConfig(workdir);
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
    Layer.succeed(LegacyDebugFlag, false),
    Layer.succeed(LegacyNetworkIdFlag, Option.none()),
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

async function withSslProbeServer<T>(run: (port: number) => Promise<T>): Promise<T> {
  const server = createServer((socket) => {
    socket.once("data", () => {
      socket.write(Buffer.from("N"));
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

describe("legacy gen types", () => {
  it.effect("accepts Go-style microsecond duration aliases", () =>
    Effect.gen(function* () {
      expect(yield* parseQueryTimeoutSeconds(`15${"\u00b5"}s`)).toBe(0);
      expect(yield* parseQueryTimeoutSeconds(`15${"\u03bc"}s`)).toBe(0);
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
          let capturedEnvFile:
            | {
                readonly envFilePath: string;
                readonly contents: string;
              }
            | undefined;
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

          const { layer, out, child } = setup({
            workdir,
            childStdout: ["export type Database = {};"],
            childStderr: ["pg-meta warning"],
            onSpawn: (record) => {
              if (record.command === "docker" && record.args.includes("run")) {
                capturedEnvFile = readEnvFileArg(record.args);
              }
            },
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
          expect(child.spawned[1]?.args).toContain("--env-file");
          expect(capturedEnvFile?.contents).toContain(
            "PG_META_GENERATE_TYPES_INCLUDED_SCHEMAS=public,custom",
          );
          expect(child.spawned[1]?.args).toContain(resolvePgmetaImage());
          expect(capturedEnvFile && existsSync(capturedEnvFile.envFilePath)).toBe(false);
        }),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }),
  );

  it.live("uses sanitized local docker ids and env-backed local db passwords", () =>
    Effect.tryPromise({
      try: () =>
        withSslProbeServer(async (port) => {
          let capturedEnvFile:
            | {
                readonly envFilePath: string;
                readonly contents: string;
              }
            | undefined;
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
              onSpawn: (record) => {
                if (record.command === "docker" && record.args.includes("run")) {
                  capturedEnvFile = readEnvFileArg(record.args);
                }
              },
            });

            await Effect.runPromise(
              legacyGenTypes(defaultFlags({ local: true })).pipe(Effect.provide(layer)),
            );

            expect(child.spawned[0]).toEqual({
              command: "docker",
              args: ["container", "inspect", "supabase_db_demo_project_with_spaces"],
            });
            expect(child.spawned[1]?.args).toContain("supabase_network_demo_project_with_spaces");
            expect(child.spawned[1]?.args.some((arg) => arg.startsWith("PG_META_DB_URL="))).toBe(
              false,
            );
            expect(capturedEnvFile?.contents).toContain(
              "PG_META_DB_URL=postgresql://postgres:secret-password@db:5432/postgres?connect_timeout=10",
            );
            expect(capturedEnvFile && existsSync(capturedEnvFile.envFilePath)).toBe(false);
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
          let capturedEnvFile:
            | {
                readonly envFilePath: string;
                readonly contents: string;
              }
            | undefined;
          const { layer, out, child } = setup({
            childStdout: ["generated"],
            onSpawn: (record) => {
              if (record.command === "docker" && record.args.includes("run")) {
                capturedEnvFile = readEnvFileArg(record.args);
              }
            },
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
          expect(child.spawned[0]?.args).toContain("--env-file");
          expect(capturedEnvFile?.contents).toContain("PG_META_GENERATE_TYPES=swift");
          expect(capturedEnvFile?.contents).toContain("PG_QUERY_TIMEOUT_SECS=20");
          expect(capturedEnvFile?.contents).toContain(
            "PG_META_GENERATE_TYPES_DETECT_ONE_TO_ONE_RELATIONSHIPS=false",
          );
          expect(capturedEnvFile && existsSync(capturedEnvFile.envFilePath)).toBe(false);
        }),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }),
  );

  it.live("defaults bare db-url connections to the postgres database", () =>
    Effect.tryPromise({
      try: () =>
        withSslProbeServer(async (port) => {
          let capturedEnvFile:
            | {
                readonly envFilePath: string;
                readonly contents: string;
              }
            | undefined;
          const { layer } = setup({
            childStdout: ["generated"],
            onSpawn: (record) => {
              if (record.command === "docker" && record.args.includes("run")) {
                capturedEnvFile = readEnvFileArg(record.args);
              }
            },
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

          expect(capturedEnvFile?.contents).toContain(
            `PG_META_DB_URL=postgresql://postgres:postgres@127.0.0.1:${port}/postgres`,
          );
          expect(capturedEnvFile && existsSync(capturedEnvFile.envFilePath)).toBe(false);
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
          let capturedEnvFile:
            | {
                readonly envFilePath: string;
                readonly contents: string;
              }
            | undefined;
          const { layer } = setup({
            args: ["gen", "types", "go", "--lang", "go"],
            childStdout: ["generated"],
            onSpawn: (record) => {
              if (record.command === "docker" && record.args.includes("run")) {
                capturedEnvFile = readEnvFileArg(record.args);
              }
            },
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

          expect(capturedEnvFile?.contents).toContain("PG_META_GENERATE_TYPES=go");
          expect(capturedEnvFile && existsSync(capturedEnvFile.envFilePath)).toBe(false);
        }),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }),
  );
});
