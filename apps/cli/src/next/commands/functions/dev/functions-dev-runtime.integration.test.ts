import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { CliConfigSchema } from "@supabase/config";
import type { FunctionsManifest } from "@supabase/config";
import {
  Cause,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Schema,
  Stream,
} from "effect";
import type { StackConfig, StackId, StackStatus } from "@supabase/stack/effect";
import {
  CAPABILITY_NAMES,
  InvalidStackConfigError,
  StackIdSchema,
  StackMustBeStoppedError,
  StackUpgradeRequiredError,
} from "@supabase/stack/effect";
import { mockOutput, mockRuntimeInfo } from "../../../../../tests/helpers/mocks.ts";
import {
  serveManagedFunctions,
  type ManagedFunctionsStack,
  type ServeManagedFunctionsOperations,
} from "../../../../shared/functions/managed-functions-runtime.ts";
import { toStartStackConfig } from "../../../config/stack-config.ts";

const stackId: StackId = StackIdSchema.make(
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
);
const status = (lifecycle: StackStatus["lifecycle"]): StackStatus => ({
  id: stackId,
  lifecycle,
  desiredLifecycle: lifecycle === "starting" || lifecycle === "stopping" ? "running" : lifecycle,
  runtime: { kind: "container", engine: "docker" },
  endpoints:
    lifecycle === "running"
      ? {
          api: {
            protocol: "http",
            address: "127.0.0.1",
            port: 54321,
            url: "http://127.0.0.1:54321",
          },
        }
      : {},
  versions: {},
  capabilities: CAPABILITY_NAMES.map((name) => ({
    name,
    activation: name === "functions" ? "lazy" : "eager",
    state: lifecycle === "running" ? (name === "functions" ? "dormant" : "ready") : "stopped",
  })),
});

describe("managed Functions serving", () => {
  it.live("keeps no-flag serve input identical to start input for live functions", () => {
    const output = mockOutput({ interactive: false });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-functions-parity-" });
      const projectRoot = path.join(root, "project");
      const functionsRoot = path.join(projectRoot, "supabase", "functions", "hello");
      yield* fs.makeDirectory(functionsRoot, { recursive: true });
      yield* fs.writeFileString(path.join(functionsRoot, "index.ts"), "export default () => {};\n");
      yield* fs.writeFileString(
        path.join(projectRoot, "supabase", "functions", ".env"),
        "GLOBAL_TOKEN=global-secret\n",
      );

      const cliConfig = Schema.decodeUnknownSync(CliConfigSchema)({});
      const translated = yield* toStartStackConfig(cliConfig, []);
      let servedConfig: StackConfig | undefined;
      const stack: ManagedFunctionsStack = {
        start: (options) =>
          Effect.sync(() => {
            servedConfig = options?.config;
            return status("running");
          }),
        watchStatus: () => Stream.empty,
        logs: () => Stream.empty,
      };
      const operations: ServeManagedFunctionsOperations = {
        createStack: () => Effect.succeed(stack),
        loadConfig: () => Effect.succeed(cliConfig),
      };

      yield* serveManagedFunctions({ projectRoot, stackName: "default" }, operations);
      expect(servedConfig).toBeDefined();
      expect(servedConfig).toEqual(translated);
    }).pipe(Effect.provide(Layer.mergeAll(output.layer, BunServices.layer)));
  });

  it.live("maps flags and live manifest, waits for gateway readiness, then streams logs", () => {
    let startedConfig: StackConfig | undefined;
    const stack: ManagedFunctionsStack = {
      start: (options) =>
        Effect.sync(() => {
          startedConfig = options?.config;
          return status("starting");
        }),
      watchStatus: () => Stream.succeed(status("running")),
      logs: () =>
        Stream.fromIterable([
          {
            cursor: { opaque: "1" },
            timestamp: "now",
            source: "functions" as const,
            stream: "stdout" as const,
            message: "ready",
          },
        ]),
    };
    const output = mockOutput({ interactive: false });
    let envPath: string | undefined;
    const manifest: FunctionsManifest = {
      hello: {
        enabled: true,
        verify_jwt: true,
        import_map: "./functions/hello/manifest-deno.json",
        entrypoint: "./functions/hello/index.ts",
        static_files: ["./functions/hello/public/*.html"],
        env: { CONFIG_TOKEN: "config-secret" },
      },
    };
    const operations: ServeManagedFunctionsOperations = {
      createStack: () => Effect.succeed(stack),
      loadConfig: () =>
        Effect.succeed(
          Schema.decodeUnknownSync(CliConfigSchema)({
            edge_runtime: { inspector_port: 8090 },
          }),
        ),
      loadManifest: () => Effect.succeed(manifest),
      readEnvFile: (pathname) =>
        Effect.sync(() => {
          envPath = pathname;
          return { ENV_TOKEN: "env-secret" };
        }),
    };
    return serveManagedFunctions(
      {
        projectRoot: "/tmp/project",
        cwd: "/tmp/caller",
        stackName: "default",
        envFile: "flags.env",
        noVerifyJwt: true,
        importMap: "./functions/hello/custom-deno.json",
        inspectMode: "wait",
        inspectMain: true,
      },
      operations,
    ).pipe(
      Effect.provide(
        Layer.mergeAll(output.layer, BunServices.layer, mockRuntimeInfo({ cwd: "/tmp/caller" })),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          const functions = startedConfig?.capabilities?.functions;
          const functionSettings =
            functions !== undefined && "settings" in functions ? functions.settings : undefined;
          const hello = functionSettings?.functions?.hello;
          expect(functionSettings?.functions_root).toBe("supabase/functions");
          expect(functionSettings?.edge_runtime).toMatchObject({
            verify_jwt_default: false,
            import_map_default: "hello/custom-deno.json",
          });
          expect(functionSettings?.inspector).toEqual({ mode: "wait", main: true });
          expect(hello?.verify_jwt).toBe(false);
          expect(hello?.import_map).toBe("custom-deno.json");
          // Manifest discovery is live-runtime behavior. The stack input only contains
          // values derived from explicit flags; entrypoint/static files default to index.ts
          // and the per-function environment is not copied from the manifest.
          expect(hello?.entrypoint).toBeUndefined();
          expect(hello?.static_files).toBeUndefined();
          expect(hello?.env).toBeUndefined();
          const globalToken = functionSettings?.edge_runtime?.secrets?.ENV_TOKEN;
          expect(globalToken).toBeDefined();
          if (globalToken !== undefined) expect(Redacted.value(globalToken)).toBe("env-secret");
          expect(envPath).toBe("/tmp/caller/flags.env");
          expect(startedConfig?.listeners?.functionsInspector).toEqual({ port: 8090 });
          expect(output.messages).toContainEqual(
            expect.objectContaining({ message: "http://127.0.0.1:54321/functions/v1" }),
          );
          expect(output.messages.some((message) => message.message.includes("ready"))).toBe(true);
        }),
      ),
    );
  });

  it.live("persists a shared root import map for functions discovered later", () => {
    let startedConfig: StackConfig | undefined;
    const output = mockOutput({ interactive: false });
    const stack: ManagedFunctionsStack = {
      start: (options) =>
        Effect.sync(() => {
          startedConfig = options?.config;
          return status("running");
        }),
      watchStatus: () => Stream.empty,
      logs: () => Stream.empty,
    };
    const operations: ServeManagedFunctionsOperations = {
      createStack: () => Effect.succeed(stack),
      loadConfig: () => Effect.succeed(undefined),
      loadManifest: () =>
        Effect.succeed({
          hello: {
            enabled: true,
            verify_jwt: true,
            import_map: "",
            entrypoint: "./functions/hello/index.ts",
            static_files: [],
            env: {},
          },
        }),
    };
    return serveManagedFunctions(
      {
        projectRoot: "/tmp/project",
        stackName: "default",
        importMap: "./functions/shared-deno.json",
      },
      operations,
    ).pipe(
      Effect.provide(Layer.mergeAll(output.layer, BunServices.layer)),
      Effect.tap(() =>
        Effect.sync(() => {
          const functions = startedConfig?.capabilities?.functions;
          const settings =
            functions !== undefined && "settings" in functions ? functions.settings : undefined;
          expect(settings?.edge_runtime?.import_map_default).toBe("shared-deno.json");
          // The global option is rooted at functions_root; no slug snapshot should
          // shadow it for the current or newly discovered functions.
          expect(settings?.functions?.hello?.import_map).toBeUndefined();
        }),
      ),
    );
  });

  it.live("validates inspector flags before acquiring a managed stack", () => {
    const output = mockOutput({ interactive: false });
    let acquired = false;
    const operations: ServeManagedFunctionsOperations = {
      createStack: () =>
        Effect.gen(function* () {
          acquired = true;
          return yield* Effect.fail(new Error("createStack should not be called"));
        }),
      loadConfig: () => Effect.succeed(undefined),
    };
    return serveManagedFunctions(
      {
        projectRoot: "/tmp/project",
        stackName: "default",
        inspect: true,
        inspectMode: "wait",
      },
      operations,
    ).pipe(
      Effect.provide(Layer.mergeAll(output.layer, BunServices.layer)),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          expect(acquired).toBe(false);
        }),
      ),
    );
  });

  it.live("fails before stack acquisition when Functions are disabled", () => {
    const output = mockOutput({ interactive: false });
    let acquired = false;
    const operations: ServeManagedFunctionsOperations = {
      createStack: () =>
        Effect.gen(function* () {
          acquired = true;
          return yield* Effect.fail(new Error("createStack should not be called"));
        }),
      loadConfig: () =>
        Effect.succeed(
          Schema.decodeUnknownSync(CliConfigSchema)({
            edge_runtime: { enabled: false },
          }),
        ),
    };
    return serveManagedFunctions(
      { projectRoot: "/tmp/project", stackName: "default" },
      operations,
    ).pipe(
      Effect.provide(Layer.mergeAll(output.layer, BunServices.layer)),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          expect(acquired).toBe(false);
          if (Exit.isFailure(exit)) {
            const error = Cause.findErrorOption(exit.cause);
            expect(Option.isSome(error)).toBe(true);
            if (Option.isSome(error)) {
              expect(error.value).toBeInstanceOf(InvalidStackConfigError);
              expect(error.value).toMatchObject({
                message: expect.stringContaining("Functions are disabled in supabase/config.toml"),
              });
            }
          }
        }),
      ),
    );
  });

  it.live("fails before stack acquisition when an explicit env file is missing", () => {
    const output = mockOutput({ interactive: false });
    let acquired = false;
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-functions-env-" });
      const operations: ServeManagedFunctionsOperations = {
        createStack: () =>
          Effect.gen(function* () {
            acquired = true;
            return yield* Effect.fail(new Error("createStack should not be called"));
          }),
        loadConfig: () => Effect.succeed(undefined),
      };
      const exit = yield* serveManagedFunctions(
        { projectRoot, stackName: "default", envFile: path.join(projectRoot, "missing.env") },
        operations,
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(acquired).toBe(false);
      if (Exit.isFailure(exit)) {
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error)).toBe(true);
        if (Option.isSome(error)) {
          expect(error.value).toMatchObject({
            message: expect.stringContaining("Functions env file was not found"),
          });
          expect(error.value).toBeInstanceOf(InvalidStackConfigError);
        }
      }
    }).pipe(Effect.provide(Layer.mergeAll(output.layer, BunServices.layer)));
  });

  it.live("suggests restart when explicit serving inputs change a running stack", () => {
    const output = mockOutput({ interactive: false });
    const stack: ManagedFunctionsStack = {
      start: () =>
        Effect.fail(
          new StackMustBeStoppedError({
            message: "Running stack input changed",
          }),
        ),
      watchStatus: () => Stream.empty,
      logs: () => Stream.empty,
    };
    const operations: ServeManagedFunctionsOperations = {
      createStack: () => Effect.succeed(stack),
      loadConfig: () => Effect.succeed(undefined),
      readEnvFile: () => Effect.succeed({}),
    };
    return serveManagedFunctions(
      {
        projectRoot: "/tmp/project",
        stackName: "default",
        envFile: "flags.env",
      },
      operations,
    ).pipe(
      Effect.provide(Layer.mergeAll(output.layer, BunServices.layer)),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const error = Cause.findErrorOption(exit.cause);
            expect(Option.isSome(error)).toBe(true);
            if (Option.isSome(error)) {
              expect(error.value).toBeInstanceOf(StackMustBeStoppedError);
              expect(error.value).toMatchObject({
                message: expect.stringContaining(
                  "run supabase restart to apply stopped-time changes",
                ),
              });
            }
          }
        }),
      ),
    );
  });

  it.live("preserves upgrade errors while suggesting an owner restart", () => {
    const output = mockOutput({ interactive: false });
    const stack: ManagedFunctionsStack = {
      start: () =>
        Effect.fail(
          new StackUpgradeRequiredError({
            message: "Stack owner release is outdated",
          }),
        ),
      watchStatus: () => Stream.empty,
      logs: () => Stream.empty,
    };
    const operations: ServeManagedFunctionsOperations = {
      createStack: () => Effect.succeed(stack),
      loadConfig: () => Effect.succeed(undefined),
    };
    return serveManagedFunctions(
      { projectRoot: "/tmp/project", stackName: "default" },
      operations,
    ).pipe(
      Effect.provide(Layer.mergeAll(output.layer, BunServices.layer)),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const error = Cause.findErrorOption(exit.cause);
            expect(Option.isSome(error)).toBe(true);
            if (Option.isSome(error)) {
              expect(error.value).toBeInstanceOf(StackUpgradeRequiredError);
              expect(error.value).toMatchObject({
                message: expect.stringContaining("run supabase restart to upgrade the stack owner"),
              });
            }
          }
        }),
      ),
    );
  });
});
