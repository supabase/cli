import { inferFunctionsManifest, loadCliConfig } from "@supabase/config/effect";
import { CliConfigSchema } from "@supabase/config";
import type { CliConfig, FunctionsManifest } from "@supabase/config";
import { Crypto, FileSystem, Effect, Option, Path, Redacted, Scope, Schema, Stream } from "effect";
import { parse as parseDotenv } from "dotenv";
import { resolve } from "node:path";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  createStack,
  findStack,
  openStack,
  type EffectStack,
  type FindStackOptions,
  type CreateStackOptions,
} from "@supabase/stack/effect";
import type { StackDescriptor, StackStatus, StackId } from "@supabase/stack/effect";
import { CliProjectHome } from "../../../config/cli-project-home.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { toStartStackConfig } from "../../../config/stack-config.ts";
import type { FunctionsDevFlags } from "./dev.command.ts";

/** The narrow stack surface owned by the managed Functions command. */
export type ManagedFunctionsStack = Pick<
  EffectStack,
  "id" | "start" | "status" | "watchStatus" | "logs" | "close"
>;

type ManagedFunctionsRuntime =
  | Scope.Scope
  | FileSystem.FileSystem
  | Path.Path
  | Crypto.Crypto
  | ChildProcessSpawner.ChildProcessSpawner;

export interface ServeManagedFunctionsOptions {
  readonly projectRoot: string;
  readonly stackName: string;
  readonly envFile?: string;
  readonly noVerifyJwt?: boolean;
  readonly importMap?: string;
  readonly inspect?: boolean;
  readonly inspectMode?: "run" | "brk" | "wait";
  readonly inspectMain?: boolean;
}

export interface ServeManagedFunctionsOperations {
  readonly findStack: (
    options: FindStackOptions,
  ) => Effect.Effect<Option.Option<StackDescriptor>, unknown, ManagedFunctionsRuntime>;
  readonly createStack: (
    options: CreateStackOptions,
  ) => Effect.Effect<ManagedFunctionsStack, unknown, ManagedFunctionsRuntime>;
  readonly openStack: (
    id: StackId,
  ) => Effect.Effect<ManagedFunctionsStack, unknown, ManagedFunctionsRuntime>;
  readonly loadConfig: (
    cwd: string,
  ) => Effect.Effect<CliConfig | undefined, unknown, FileSystem.FileSystem | Path.Path>;
  readonly loadManifest?: (
    cwd: string,
    config: CliConfig,
  ) => Effect.Effect<FunctionsManifest, unknown, FileSystem.FileSystem | Path.Path>;
  readonly readEnvFile?: (
    pathname: string,
  ) => Effect.Effect<Readonly<Record<string, string>>, unknown, FileSystem.FileSystem>;
}

const defaultOperations: Required<ServeManagedFunctionsOperations> = {
  findStack,
  createStack,
  openStack,
  loadConfig: (cwd) => loadCliConfig(cwd).pipe(Effect.map((loaded) => loaded?.config)),
  loadManifest: (cwd, config) => inferFunctionsManifest({ cwd, config }),
  readEnvFile: (pathname) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
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

const statusAfterReadiness = Effect.fnUntraced(function* (
  stack: ManagedFunctionsStack,
  initial: StackStatus,
) {
  if (servingReady(initial)) return initial;
  const next = yield* stack.watchStatus().pipe(Stream.filter(servingReady), Stream.runHead);
  if (Option.isNone(next)) {
    return yield* Effect.fail(new Error("Managed Functions stack did not reach gateway readiness"));
  }
  return next.value;
});

const toFunctionOverrides = (
  manifest: FunctionsManifest,
  options: ServeManagedFunctionsOptions,
  envFile: Readonly<Record<string, string>>,
) =>
  Object.fromEntries(
    Object.entries(manifest).map(([slug, config]) => [
      slug,
      {
        enabled: config.enabled,
        verify_jwt: options.noVerifyJwt === true ? false : config.verify_jwt,
        import_map: options.importMap ?? config.import_map,
        entrypoint: config.entrypoint,
        static_files: config.static_files,
        env: Object.fromEntries(
          Object.entries({ ...config.env, ...envFile }).map(([name, value]) => [
            name,
            Redacted.make(value),
          ]),
        ),
      },
    ]),
  );

export const runFunctionsDevRuntime = Effect.fnUntraced(function* (flags: FunctionsDevFlags) {
  return yield* serveManagedFunctions({
    projectRoot: (yield* CliProjectHome).projectRoot,
    stackName: flags.stack,
    envFile: Option.getOrUndefined(flags.envFile),
    noVerifyJwt: flags.noVerifyJwt,
    importMap: Option.getOrUndefined(flags.importMap),
  });
});

/** Serves every local Function through the stack-owned Edge Runtime. */
export const serveManagedFunctions = Effect.fnUntraced(function* (
  options: ServeManagedFunctionsOptions,
  operations: ServeManagedFunctionsOperations = defaultOperations,
) {
  const output = yield* Output;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const descriptor = yield* operations.findStack({
        projectRoot: options.projectRoot,
        name: options.stackName,
      });
      const stack = Option.isNone(descriptor)
        ? yield* operations.createStack({
            projectRoot: options.projectRoot,
            name: options.stackName,
            runtime: { kind: "container" },
          })
        : yield* operations.openStack(descriptor.value.id);
      const loadedConfig = yield* operations.loadConfig(options.projectRoot);
      const config = loadedConfig ?? Schema.decodeUnknownSync(CliConfigSchema)({});
      const manifest = yield* (operations.loadManifest ?? defaultOperations.loadManifest)(
        options.projectRoot,
        config,
      );
      const envFile =
        options.envFile === undefined
          ? {}
          : yield* (operations.readEnvFile ?? defaultOperations.readEnvFile)(
              resolve(options.projectRoot, options.envFile),
            );
      const translated = toStartStackConfig(loadedConfig, [], "docker");
      const functionsCapability = translated.capabilities?.functions;
      const existingSettings =
        functionsCapability !== undefined && "settings" in functionsCapability
          ? functionsCapability.settings
          : undefined;
      const functionsConfig = {
        ...(functionsCapability !== undefined ? functionsCapability : {}),
        enabled: true,
        settings: {
          ...existingSettings,
          functions_root: "supabase/functions",
          functions: toFunctionOverrides(manifest, options, envFile),
        },
      };
      const inspectRequested = options.inspect === true || options.inspectMode !== undefined;
      const inspectorPort = loadedConfig?.edge_runtime?.inspector_port ?? 8083;
      const status = yield* stack.start({
        config: {
          ...translated,
          capabilities: {
            ...translated.capabilities,
            functions: functionsConfig,
          },
          listeners: {
            ...translated.listeners,
            ...(inspectRequested ? { functionsInspector: { port: inspectorPort } } : {}),
          },
        },
      });
      const ready = yield* statusAfterReadiness(stack, status);
      const apiUrl = ready.endpoints.api?.url;
      yield* output.success(`Functions stack is ${ready.lifecycle}.`, {
        stack: options.stackName,
        functions_root: "supabase/functions",
        lifecycle: ready.lifecycle,
      });
      if (apiUrl !== undefined) yield* output.info(`${apiUrl}/functions/v1`);
      yield* stack
        .logs({ capabilities: ["functions"], follow: true })
        .pipe(Stream.runForEach((entry) => output.info(`[${entry.source}] ${entry.message}`)));
    }),
  );
});
