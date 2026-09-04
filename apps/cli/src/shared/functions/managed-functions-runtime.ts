import { inferFunctionsManifest, loadCliConfig } from "@supabase/config/effect";
import { CliConfigSchema } from "@supabase/config";
import type { CliConfig, FunctionsManifest, LoadedCliConfig } from "@supabase/config";
import {
  Crypto,
  Data,
  FileSystem,
  Effect,
  Path,
  Redacted,
  Schedule,
  Scope,
  Schema,
  Stream,
} from "effect";
import { parse as parseDotenv } from "dotenv";
import { resolve } from "node:path";
import { ChildProcessSpawner } from "effect/unstable/process";
import { createStack, type EffectStack, type CreateStackOptions } from "@supabase/stack/effect";
import type { StackStatus } from "@supabase/stack/effect";
import {
  InvalidStackConfigError,
  StackMustBeStoppedError,
  StackUpgradeRequiredError,
} from "@supabase/stack/effect";
import { Output } from "../output/output.service.ts";
import {
  isFunctionScopedPath,
  relativeFunctionPath,
  relativeGlobalFunctionPath,
  toStartStackConfig,
} from "../../next/config/stack-config.ts";

/** The narrow stack surface owned by the managed Functions command. */
export type ManagedFunctionsStack = Pick<EffectStack, "start" | "status" | "logs" | "followLogs">;

type ManagedFunctionsRuntime =
  | Scope.Scope
  | FileSystem.FileSystem
  | Path.Path
  | Crypto.Crypto
  | ChildProcessSpawner.ChildProcessSpawner;

export interface ServeManagedFunctionsOptions {
  readonly projectRoot: string;
  readonly stackName: string;
  /** Caller working directory used to resolve an explicit --env-file. */
  readonly cwd?: string;
  readonly envFile?: string;
  readonly noVerifyJwt?: boolean;
  readonly importMap?: string;
  readonly inspect?: boolean;
  readonly inspectMode?: "run" | "brk" | "wait";
  readonly inspectMain?: boolean;
}

export interface ServeManagedFunctionsOperations {
  readonly createStack: (
    options: CreateStackOptions,
  ) => Effect.Effect<ManagedFunctionsStack, unknown, ManagedFunctionsRuntime>;
  readonly loadConfig: (
    cwd: string,
  ) => Effect.Effect<
    LoadedCliConfig | CliConfig | undefined,
    unknown,
    FileSystem.FileSystem | Path.Path
  >;
  readonly loadManifest?: (
    cwd: string,
    config: CliConfig,
  ) => Effect.Effect<FunctionsManifest, unknown, FileSystem.FileSystem | Path.Path>;
  readonly readEnvFile?: (
    pathname: string,
  ) => Effect.Effect<Readonly<Record<string, string>>, unknown, FileSystem.FileSystem>;
}

const defaultOperations: Required<ServeManagedFunctionsOperations> = {
  createStack,
  loadConfig: (cwd) => loadCliConfig(cwd).pipe(Effect.map((loaded) => loaded ?? undefined)),
  loadManifest: (cwd, config) => inferFunctionsManifest({ cwd, config }),
  readEnvFile: (pathname) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      if (!(yield* fs.exists(pathname))) {
        return yield* Effect.fail(
          new InvalidStackConfigError({
            message: `Functions env file was not found: ${pathname}`,
          }),
        );
      }
      const contents = yield* fs.readFileString(pathname);
      return yield* Effect.try({
        try: () => parseDotenv(contents),
        catch: (error) => error,
      });
    }),
};

const capabilityReady = (status: StackStatus): boolean =>
  status.capabilities.some(
    (capability) =>
      capability.name === "functions" &&
      (capability.state === "ready" || capability.state === "dormant"),
  );

const servingReady = (status: StackStatus): boolean =>
  status.lifecycle === "running" && status.endpoints.api !== undefined && capabilityReady(status);

class ReadinessPending extends Data.TaggedError("ReadinessPending")<{}> {}

const statusAfterReadiness = Effect.fnUntraced(function* (
  stack: ManagedFunctionsStack,
  initial: StackStatus,
) {
  if (servingReady(initial)) return initial;
  return yield* stack.status().pipe(
    Effect.flatMap((next) =>
      servingReady(next) ? Effect.succeed(next) : Effect.fail(new ReadinessPending()),
    ),
    Effect.retry({
      schedule: Schedule.spaced("100 millis").pipe(Schedule.upTo({ duration: "3 minutes" })),
      while: (error) => error instanceof ReadinessPending,
    }),
    Effect.catchTag("ReadinessPending", () =>
      Effect.fail(new Error("Managed Functions stack did not reach gateway readiness")),
    ),
  );
});

const toFunctionOverrides = (manifest: FunctionsManifest, options: ServeManagedFunctionsOptions) =>
  Object.fromEntries(
    Object.entries(manifest).flatMap(([slug]) => {
      const override = {
        ...(options.noVerifyJwt === true ? { verify_jwt: false } : {}),
        ...(options.importMap === undefined || !isFunctionScopedPath(slug, options.importMap)
          ? {}
          : { import_map: relativeFunctionPath(slug, options.importMap) }),
      };
      return Object.keys(override).length === 0 ? [] : [[slug, override]];
    }),
  );

/** Serves every local Function through the stack-owned Edge Runtime. */
export const serveManagedFunctions = Effect.fnUntraced(function* (
  options: ServeManagedFunctionsOptions,
  operations: ServeManagedFunctionsOperations = defaultOperations,
) {
  const output = yield* Output;
  const resolvedOperations: Required<ServeManagedFunctionsOperations> = {
    ...defaultOperations,
    ...operations,
    loadManifest: operations.loadManifest ?? defaultOperations.loadManifest,
    readEnvFile: operations.readEnvFile ?? defaultOperations.readEnvFile,
  };

  // Validate mutually-exclusive flags before finding or creating a stack. A malformed invocation
  // must never leave a Supervisor running behind a command that is about to fail.
  if (options.inspect && options.inspectMode !== undefined) {
    return yield* Effect.fail(
      new Error(
        "if any flags in the group [inspect inspect-mode] are set none of the others can be; [inspect inspect-mode] were all set",
      ),
    );
  }
  const inspectorMode = options.inspectMode ?? (options.inspect ? "brk" : undefined);
  if (options.inspectMain && inspectorMode === undefined) {
    return yield* Effect.fail(
      new Error("--inspect-main must be used together with --inspect or --inspect-mode"),
    );
  }

  // Decode and validate the stack input before acquiring an owner. Serving a
  // disabled Functions capability can never reach readiness, so fail with a
  // direct configuration fix instead of leaving the command waiting forever.
  const loadedConfig = yield* resolvedOperations.loadConfig(options.projectRoot);
  const translated = yield* toStartStackConfig(loadedConfig, []);
  const functionsCapability = translated.capabilities?.functions;
  if (functionsCapability !== undefined && "enabled" in functionsCapability) {
    if (functionsCapability.enabled === false) {
      return yield* Effect.fail(
        new InvalidStackConfigError({
          message:
            "Functions are disabled in supabase/config.toml; set [edge_runtime].enabled = true before running supabase functions serve.",
        }),
      );
    }
  }

  const cliConfig =
    loadedConfig !== undefined && "config" in loadedConfig ? loadedConfig.config : loadedConfig;
  const config = cliConfig ?? (yield* Schema.decodeUnknownEffect(CliConfigSchema)({}));
  const hasFunctionFlags = options.noVerifyJwt === true || options.importMap !== undefined;
  const manifest = hasFunctionFlags
    ? yield* resolvedOperations.loadManifest(options.projectRoot, config)
    : undefined;
  // The default functions/.env remains runtime-owned and must not alter the
  // stack fingerprint on a no-flag serve join. An explicit --env-file is a
  // deliberate stack input and is persisted as global Edge Runtime secrets.
  const envFile =
    options.envFile === undefined
      ? {}
      : yield* resolvedOperations.readEnvFile(
          resolve(options.cwd ?? options.projectRoot, options.envFile),
        );

  yield* Effect.scoped(
    Effect.gen(function* () {
      const stack = yield* resolvedOperations.createStack({
        projectRoot: options.projectRoot,
        name: options.stackName,
      });
      const existingSettings =
        functionsCapability !== undefined && "settings" in functionsCapability
          ? functionsCapability.settings
          : undefined;
      const existingEdgeRuntime = existingSettings?.edge_runtime;
      const existingSecrets = existingEdgeRuntime?.secrets ?? {};
      const functionDefaults = {
        ...(options.noVerifyJwt === true ? { verify_jwt_default: false } : {}),
        ...(options.importMap === undefined
          ? {}
          : {
              import_map_default: relativeGlobalFunctionPath(options.importMap, {
                projectRoot: options.projectRoot,
                cwd: options.cwd,
              }),
            }),
      };
      const edgeRuntimeSettings = {
        ...existingEdgeRuntime,
        ...functionDefaults,
        ...(options.envFile === undefined
          ? {}
          : {
              secrets: {
                ...existingSecrets,
                ...Object.fromEntries(
                  Object.entries(envFile).map(([name, value]) => [name, Redacted.make(value)]),
                ),
              },
            }),
      };
      const hasExplicitChanges =
        hasFunctionFlags || options.envFile !== undefined || inspectorMode !== undefined;
      const functionsConfig = hasExplicitChanges
        ? {
            ...(functionsCapability !== undefined ? functionsCapability : {}),
            enabled: true,
            settings: {
              ...existingSettings,
              ...(manifest === undefined
                ? {}
                : {
                    functions: {
                      ...existingSettings?.functions,
                      ...toFunctionOverrides(manifest, options),
                    },
                  }),
              ...(inspectorMode === undefined
                ? {}
                : { inspector: { mode: inspectorMode, main: options.inspectMain === true } }),
              ...(Object.keys(edgeRuntimeSettings).length === 0
                ? {}
                : { edge_runtime: edgeRuntimeSettings }),
            },
          }
        : functionsCapability;
      const status = yield* stack
        .start({
          config: {
            ...translated,
            capabilities: {
              ...translated.capabilities,
              ...(functionsConfig === undefined ? {} : { functions: functionsConfig }),
            },
            listeners: {
              ...translated.listeners,
              ...(inspectorMode === undefined
                ? {}
                : {
                    functionsInspector: translated.listeners?.functionsInspector ?? {
                      enabled: true,
                    },
                  }),
            },
          },
        })
        .pipe(
          Effect.catchIf(
            (error) => error instanceof StackMustBeStoppedError,
            (error) =>
              Effect.fail(
                new StackMustBeStoppedError({
                  ...error,
                  message: `${error.message}; run supabase restart to apply stopped-time changes`,
                }),
              ),
          ),
          Effect.catchIf(
            (error) => error instanceof StackUpgradeRequiredError,
            (error) =>
              Effect.fail(
                new StackUpgradeRequiredError({
                  ...error,
                  message: `${error.message}; run supabase restart to upgrade the stack owner`,
                }),
              ),
          ),
        );
      const ready = yield* statusAfterReadiness(stack, status);
      const apiUrl = ready.endpoints.api?.url;
      yield* output.success(`Functions stack is ${ready.lifecycle}.`, {
        stack: options.stackName,
        functions_root: "supabase/functions",
        lifecycle: ready.lifecycle,
      });
      if (apiUrl !== undefined) yield* output.info(`${apiUrl}/functions/v1`);
      yield* stack
        .followLogs({ capabilities: ["functions"] })
        .pipe(Stream.runForEach((entry) => output.info(`[${entry.source}] ${entry.message}`)));
    }),
  );
});
