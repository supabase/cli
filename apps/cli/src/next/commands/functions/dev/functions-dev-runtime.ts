import { watch, type FSWatcher } from "node:fs";
import { daemonEntryPoint } from "@supabase/stack";
import {
  connectLayer,
  daemonLayer,
  resolveDaemonConfig,
  stackMetadata,
  Stack,
  StateManager,
} from "@supabase/stack/effect";
import { Effect, Layer, Option, Queue, ServiceMap, Stream } from "effect";
import { CliConfig } from "../../../config/cli-config.service.ts";
import { ProjectHome } from "../../../config/project-home.service.ts";
import { projectLocalServiceVersionsLayer } from "../../../config/project-local-service-versions.layer.ts";
import { projectLinkStateLayer } from "../../../config/project-link-state.layer.ts";
import { projectStackStateManagerLayer } from "../../../config/project-stack-state-manager.layer.ts";
import {
  resolveServiceVersionContext,
  type ResolvedServiceVersionContext,
} from "../../../config/service-version-resolution.ts";
import { toStartStackConfig, withServiceVersions } from "../../../config/stack-config.ts";
import { ensureProjectStateIgnored } from "../../../config/project-gitignore.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { ProcessControl } from "../../../../shared/runtime/process-control.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import { startStackWithProgress } from "../../../stack/stack.shared.ts";
import {
  functionsDevWatchPaths,
  toStackFunctionsConfig,
  type FunctionsDevConfigOptions,
} from "./functions-dev-config.ts";

interface FunctionsDevRuntimeOptions extends FunctionsDevConfigOptions {
  readonly stack: string;
}

type StackService = ServiceMap.Service.Shape<typeof Stack>;

function versionsFromContext(context: ResolvedServiceVersionContext) {
  return withServiceVersions(toStartStackConfig([], "auto"), context.runtimeVersions);
}

const startFullStack = Effect.fnUntraced(function* (opts: FunctionsDevRuntimeOptions) {
  const cliConfig = yield* CliConfig;
  const projectHome = yield* ProjectHome;
  const runtimeInfo = yield* RuntimeInfo;
  const stateManager = yield* StateManager;
  const output = yield* Output;

  yield* output.info("No local stack is running. Starting the local Supabase stack...");
  yield* ensureProjectStateIgnored(projectHome.projectRoot);

  const serviceVersionContext = yield* resolveServiceVersionContext([], undefined);
  const config = yield* Effect.promise(() =>
    resolveDaemonConfig({
      cacheRoot: cliConfig.supabaseHome,
      cwd: runtimeInfo.cwd,
      projectDir: projectHome.projectRoot,
      projectStateRoot: projectHome.projectHomeDir,
      name: opts.stack,
      functions: toStackFunctionsConfig(opts),
      ...versionsFromContext(serviceVersionContext),
    }),
  );

  yield* stateManager.writeMetadata(
    opts.stack,
    stackMetadata({
      ports: config.ports,
      services: serviceVersionContext.pinnedBaseline,
      launch: { mode: "auto", excludedServices: [] },
    }),
  );

  const stackLayer = yield* daemonLayer(config, daemonEntryPoint);
  yield* startStackWithProgress().pipe(Effect.provide(stackLayer));
  const stack = yield* Stack.asEffect().pipe(Effect.provide(stackLayer));

  return { stack, startedByCommand: true };
});

export const connectOrStartFunctionsDevStack = Effect.fnUntraced(function* (
  opts: FunctionsDevRuntimeOptions,
) {
  const cliConfig = yield* CliConfig;
  const projectHome = yield* ProjectHome;
  const runtimeInfo = yield* RuntimeInfo;

  const existingLayer = yield* connectLayer({
    cwd: runtimeInfo.cwd,
    cacheRoot: cliConfig.supabaseHome,
    projectDir: projectHome.projectRoot,
    projectStateRoot: projectHome.projectHomeDir,
    name: opts.stack,
  }).pipe(
    Effect.map(Option.some),
    Effect.catchTag("NoRunningStackError", () => Effect.succeed(Option.none())),
  );

  if (Option.isSome(existingLayer)) {
    const stack = yield* Stack.asEffect().pipe(Effect.provide(existingLayer.value));
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

function watchPaths(paths: ReadonlyArray<string>) {
  return Stream.callback<void>((queue) => {
    const watchers: FSWatcher[] = [];
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const notify = () => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      timeout = setTimeout(() => {
        Effect.runFork(Queue.offer(queue, void 0));
      }, 100);
    };

    for (const path of paths) {
      try {
        watchers.push(watch(path, { recursive: true }, notify));
      } catch {
        try {
          watchers.push(watch(path, notify));
        } catch {
          // Missing paths are allowed; a parent directory watcher will pick them up later.
        }
      }
    }

    return Effect.sync(() => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      for (const watcher of watchers) {
        watcher.close();
      }
    });
  });
}

export const runFunctionsDevRuntime = Effect.fnUntraced(function* (
  opts: FunctionsDevRuntimeOptions,
) {
  const output = yield* Output;
  const processControl = yield* ProcessControl;

  yield* output.intro("Develop Edge Functions");

  const { stack, startedByCommand } = yield* connectOrStartFunctionsDevStack(opts);
  yield* stack.reloadFunctions(toStackFunctionsConfig(opts));
  const info = yield* stack.getInfo();
  const watchPathList = yield* functionsDevWatchPaths(opts.envFile);

  yield* output.success("Edge Functions dev server is running.", {
    functions_url: `${info.url}/functions/v1`,
  });
  yield* output.info(`Functions URL: ${info.url}/functions/v1/<function-name>`);

  const restartOnChange = watchPaths(watchPathList).pipe(
    Stream.runForEach(() =>
      Effect.gen(function* () {
        yield* output.info("Function files changed. Restarting edge-runtime...");
        yield* stack.reloadFunctions(toStackFunctionsConfig(opts));
      }).pipe(
        Effect.catch((error) =>
          output.error(error instanceof Error ? error.message : String(error)),
        ),
      ),
    ),
  );

  const logs = logEntryStream(stack).pipe(Stream.runForEach((event) => output.event(event)));
  const shutdown = processControl.awaitShutdown;

  yield* Effect.raceFirst(Effect.raceFirst(restartOnChange, logs), shutdown).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        if (startedByCommand) {
          yield* stack.dispose().pipe(Effect.ignore);
        } else {
          yield* stack.reloadFunctions({}).pipe(Effect.ignore);
        }
      }),
    ),
  );
});

export const functionsDevRuntimeLayer = Layer.mergeAll(
  projectLinkStateLayer,
  projectLocalServiceVersionsLayer,
  projectStackStateManagerLayer,
);
