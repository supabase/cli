import { connectLayer, daemonLayer, Stack, type EdgeRuntimeConfig } from "@supabase/stack/effect";
import { loadProjectConfig } from "@supabase/config";
import { Context, Duration, Effect, FileSystem, Layer, Option, Stream } from "effect";
import { join } from "node:path";
import { CLI_VERSION } from "../../../../shared/cli/version.ts";
import { CliConfig } from "../../../config/cli-config.service.ts";
import { ProjectHome } from "../../../config/project-home.service.ts";
import { projectLocalServiceVersionsLayer } from "../../../config/project-local-service-versions.layer.ts";
import { projectLinkStateLayer } from "../../../config/project-link-state.layer.ts";
import { resolveServiceVersionContext } from "../../../config/service-version-resolution.ts";
import { managedPortIntents } from "../../../config/managed-port-intents.ts";
import { toStartStackConfig, withServiceVersions } from "../../../config/stack-config.ts";
import { ensureProjectStateIgnored } from "../../../config/project-gitignore.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import {
  FileWatcher,
  type FileWatchEvent,
} from "../../../../shared/runtime/file-watcher.service.ts";
import { ProcessControl } from "../../../../shared/runtime/process-control.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import { startStackWithProgress } from "../../../stack/stack.shared.ts";
import {
  functionsDevWatchPaths,
  resolveFunctionsBundle,
  type FunctionsDevConfigOptions,
  type FunctionsDevWatchPath,
} from "./functions-dev-config.ts";
import {
  resolveFunctionsDevEdgeRuntimeConfig,
  type ResolvedFunctionsDevEdgeRuntimeConfig,
} from "./functions-dev-edge-runtime-config.ts";

interface FunctionsDevRuntimeOptions extends FunctionsDevConfigOptions {
  readonly stack: string;
}

interface FunctionsDevStackOptions extends FunctionsDevRuntimeOptions {
  readonly edgeRuntime: EdgeRuntimeConfig;
}

interface FunctionsDevWatchChange {
  readonly touchesProjectConfig: boolean;
}

type StackService = typeof Stack.Service;

const startFullStack = Effect.fnUntraced(function* (opts: FunctionsDevStackOptions) {
  const cliConfig = yield* CliConfig;
  const projectHome = yield* ProjectHome;
  const runtimeInfo = yield* RuntimeInfo;
  const output = yield* Output;

  yield* output.info("No local stack is running. Starting the local Supabase stack...");
  yield* ensureProjectStateIgnored(projectHome.projectRoot);

  const serviceVersionContext = yield* resolveServiceVersionContext([], undefined);
  const loadedProjectConfig = yield* loadProjectConfig(projectHome.projectRoot);
  const stackConfig = {
    ...withServiceVersions(toStartStackConfig([], "docker"), serviceVersionContext.runtimeVersions),
    // Functions dev explicitly requires Edge Runtime even when the project
    // config supplies only schema defaults. Request Docker explicitly so the
    // managed daemon validates container availability before persisting state.
    servicePolicies: { "edge-runtime": "eager" as const },
  };
  const stackLayer = yield* daemonLayer({
    cliVersion: CLI_VERSION,
    incompatibleOwnerPolicy: "fail",
    cacheRoot: cliConfig.supabaseHome,
    cwd: runtimeInfo.cwd,
    projectDir: projectHome.projectRoot,
    name: opts.stack,
    edgeRuntime: opts.edgeRuntime,
    launch: {
      versions: serviceVersionContext.pinnedBaseline,
      excludedServices: [],
    },
    ...stackConfig,
    portIntents: managedPortIntents(stackConfig, loadedProjectConfig ?? undefined),
  });
  const context = yield* Layer.build(stackLayer);
  const stack = Context.get(context, Stack);
  yield* startStackWithProgress().pipe(Effect.provide(context));

  return { stack, startedByCommand: true };
});

export const connectOrStartFunctionsDevStack = Effect.fnUntraced(function* (
  opts: FunctionsDevStackOptions,
) {
  const cliConfig = yield* CliConfig;
  const projectHome = yield* ProjectHome;
  const runtimeInfo = yield* RuntimeInfo;

  const existingLayer = yield* connectLayer({
    cliVersion: CLI_VERSION,
    cwd: runtimeInfo.cwd,
    cacheRoot: cliConfig.supabaseHome,
    projectDir: projectHome.projectRoot,
    name: opts.stack,
  }).pipe(
    Effect.map(Option.some),
    Effect.catchTag("NoRunningStackError", () => Effect.succeed(Option.none())),
  );

  if (Option.isSome(existingLayer)) {
    const context = yield* Layer.build(existingLayer.value);
    const stack = Context.get(context, Stack);
    return { stack, startedByCommand: false };
  }

  return yield* startFullStack(opts);
});

function logEntryStream(stack: StackService) {
  return stack.subscribeLogs("edge-runtime").pipe(
    Stream.map((entry) => ({
      type: "log-entry" as const,
      timestamp: new Date(entry.timestamp).toISOString(),
      service: entry.service,
      stream: entry.stream,
      line: entry.line,
      source: "live" as const,
    })),
  );
}

const ensureFunctionsDirectory = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const projectHome = yield* ProjectHome;
  yield* fs.makeDirectory(join(projectHome.supabaseDir, "functions"), { recursive: true });
});

function watchEventMatches(spec: FunctionsDevWatchPath, event: FileWatchEvent): boolean {
  if (spec.names === undefined) {
    return true;
  }
  const segments = event.path.replaceAll("\\", "/").split("/");
  return spec.names.some((name) => segments.includes(name));
}

function isProjectConfigEvent(event: FileWatchEvent): boolean {
  const segments = event.path.replaceAll("\\", "/").split("/");
  return segments.includes("config.toml") || segments.includes("config.json");
}

export function watchPaths(paths: ReadonlyArray<FunctionsDevWatchPath>) {
  return Stream.unwrap(
    Effect.gen(function* () {
      const fileWatcher = yield* FileWatcher;
      const streams = paths.map((spec) =>
        fileWatcher.watch(spec.path).pipe(
          Stream.filter((events) => events.some((event) => watchEventMatches(spec, event))),
          Stream.map((events) => ({
            touchesProjectConfig: events.some(isProjectConfigEvent),
          })),
        ),
      );
      return Stream.mergeAll(streams, { concurrency: "unbounded" }).pipe(
        Stream.debounce(Duration.millis(100)),
      );
    }),
  );
}

function reloadEdgeRuntime(
  stack: StackService,
  opts: FunctionsDevRuntimeOptions,
  edgeRuntime: EdgeRuntimeConfig,
) {
  return Effect.gen(function* () {
    const functions = yield* resolveFunctionsBundle(opts);
    yield* stack.reloadEdgeRuntime({ edgeRuntime, functions });
  });
}

function applyWatchedChange(
  currentEdgeRuntimeState: ResolvedFunctionsDevEdgeRuntimeConfig,
  change: FunctionsDevWatchChange,
) {
  return Effect.gen(function* () {
    if (!change.touchesProjectConfig) {
      return {
        state: currentEdgeRuntimeState,
        action: "functions" as const,
      };
    }

    const nextEdgeRuntimeState = yield* resolveFunctionsDevEdgeRuntimeConfig();
    if (nextEdgeRuntimeState.fingerprint === currentEdgeRuntimeState.fingerprint) {
      return {
        state: currentEdgeRuntimeState,
        action: "functions" as const,
      };
    }

    return {
      state: nextEdgeRuntimeState,
      action: "edge-runtime" as const,
    };
  });
}

export const runFunctionsDevRuntime = Effect.fnUntraced(function* (
  opts: FunctionsDevRuntimeOptions,
) {
  const output = yield* Output;
  const processControl = yield* ProcessControl;

  yield* output.intro("Develop Edge Functions");

  let edgeRuntimeState = yield* resolveFunctionsDevEdgeRuntimeConfig();
  const { stack, startedByCommand } = yield* connectOrStartFunctionsDevStack({
    ...opts,
    edgeRuntime: edgeRuntimeState.config,
  });
  const restoreFunctions = startedByCommand
    ? undefined
    : yield* resolveFunctionsBundle({ envFile: Option.none(), noVerifyJwt: false });

  yield* Effect.gen(function* () {
    yield* ensureFunctionsDirectory();
    yield* reloadEdgeRuntime(stack, opts, edgeRuntimeState.config);
    const info = yield* stack.getInfo();
    const watchPathList = yield* functionsDevWatchPaths(opts.envFile);

    yield* output.success("Edge Functions dev server is running.", {
      functions_url: `${info.url}/functions/v1`,
    });
    yield* output.info(`Functions URL: ${info.url}/functions/v1/<function-name>`);

    const restartOnChange = watchPaths(watchPathList).pipe(
      Stream.runForEach((change) =>
        Effect.gen(function* () {
          const result = yield* applyWatchedChange(edgeRuntimeState, change);
          if (result.action === "edge-runtime") {
            yield* output.info("Edge runtime config changed. Restarting edge-runtime...");
            yield* reloadEdgeRuntime(stack, opts, result.state.config);
            edgeRuntimeState = result.state;
            return;
          }
          edgeRuntimeState = result.state;
          yield* output.info("Function files changed. Restarting edge-runtime...");
          yield* stack.reloadFunctions({ functions: yield* resolveFunctionsBundle(opts) });
        }).pipe(
          Effect.catch((error) =>
            output.error(error instanceof Error ? error.message : String(error)),
          ),
        ),
      ),
    );

    const logs = logEntryStream(stack).pipe(Stream.runForEach((event) => output.event(event)));
    const shutdown = processControl.awaitShutdown;

    yield* Effect.raceFirst(Effect.raceFirst(restartOnChange, logs), shutdown);
  }).pipe(
    Effect.ensuring(
      startedByCommand
        ? stack.dispose().pipe(Effect.ignore)
        : stack.reloadFunctions({ functions: restoreFunctions }).pipe(Effect.ignore),
    ),
  );
});

export const functionsDevRuntimeLayer = Layer.mergeAll(
  projectLinkStateLayer,
  projectLocalServiceVersionsLayer,
);
