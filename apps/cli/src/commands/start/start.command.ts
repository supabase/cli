import { Effect, Layer, Option, ServiceMap } from "effect";
import {
  DEFAULT_MANAGED_STACK_NAME,
  StateManager,
  daemonLayer,
  resolveDaemonConfig,
  stackMetadata,
  type StackMetadata,
} from "@supabase/stack/effect";
import { daemonEntryPoint } from "@supabase/stack";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { projectLocalServiceVersionsLayer } from "../../config/project-local-service-versions.layer.ts";
import { ensureProjectStateIgnored } from "../../config/project-gitignore.ts";
import { CliConfig } from "../../config/cli-config.service.ts";
import { ProjectHome } from "../../config/project-home.service.ts";
import { projectLinkStateLayer } from "../../config/project-link-state.layer.ts";
import { provideProjectCommandRuntime } from "../../config/project-runtime.layer.ts";
import {
  resolveServiceVersionContext,
  type ResolvedServiceVersionContext,
} from "../../config/service-version-resolution.ts";
import {
  excludedStackServices,
  type ExcludedStackService,
  startModes,
  type StartMode,
  toStartStackConfig,
  withServiceVersions,
} from "../../config/stack-config.ts";
import { projectStackStateManagerLayer } from "../../config/project-stack-state-manager.layer.ts";
import { withJsonErrorHandling } from "../../output/json-error-handling.ts";
import { Output } from "../../output/output.service.ts";
import { inkLayer } from "../../runtime/ink.layer.ts";
import { RuntimeInfo } from "../../runtime/runtime-info.service.ts";
import { withCommandAnalytics } from "../../telemetry/command-analytics.ts";
import { start } from "./start.handler.ts";

export const excludeFlag = Flag.choice("exclude", excludedStackServices).pipe(
  Flag.atMost(excludedStackServices.length),
  Flag.withDescription(
    "Services to exclude from the local stack. Repeat the flag for multiple values.",
  ),
  Flag.withDefault([] as ReadonlyArray<ExcludedStackService>),
);

export const serviceVersionFlag = Flag.string("service-version").pipe(
  Flag.atLeast(0),
  Flag.withDescription(
    "Override a local service version for this run. Format: service=version. Repeat the flag for multiple services.",
  ),
  Flag.withDefault([] as ReadonlyArray<string>),
);

const modeFlag = Flag.choice("mode", startModes).pipe(
  Flag.withDescription(
    'Stack startup mode. "auto" prefers native binaries and falls back to Docker, "native" requires native-compatible services, and "docker" forces Docker for all services.',
  ),
  Flag.withDefault("auto" as StartMode),
);

interface StartVersionStateShape {
  readonly metadata: StackMetadata;
  readonly serviceVersionContext: ResolvedServiceVersionContext;
}

export class StartVersionState extends ServiceMap.Service<
  StartVersionState,
  StartVersionStateShape
>()("@supabase/cli/commands/start/StartVersionState") {}

const flags = {
  stack: Flag.string("stack").pipe(
    Flag.withDescription("Name of the managed local stack for this project."),
    Flag.withDefault(DEFAULT_MANAGED_STACK_NAME),
  ),
  mode: modeFlag,
  exclude: excludeFlag,
  serviceVersion: serviceVersionFlag,
  detach: Flag.boolean("detach").pipe(
    Flag.withDescription("Run in background (daemon mode)"),
    Flag.withDefault(false),
  ),
} as const;

export type StartFlags = CliCommand.Command.Config.Infer<typeof flags>;

export const startCommand = Command.make("start", flags).pipe(
  Command.withDescription(
    "Start the local Supabase development stack.\n\n" +
      "Starts the full local Supabase stack. Use --mode auto (default) to prefer native binaries and fall back to Docker, --mode native to require native-compatible services, or --mode docker to force Docker-backed startup.\n\n" +
      "Named CLI stacks persist their service data under .supabase/stacks/<name>/data in the project root. Use --exclude to skip optional services. Use --detach to run in the background.",
  ),
  Command.withShortDescription("Start local Supabase stack"),
  Command.withExamples([
    {
      command: "supabase start",
      description: "Start the stack in the foreground and watch service status live",
    },
    {
      command: "supabase start --detach",
      description: "Start the stack in the background and return to the shell",
    },
    {
      command: "supabase start --mode docker",
      description: "Force the local stack to start in Docker mode",
    },
    {
      command: "supabase start --exclude studio --exclude analytics",
      description: "Start a slimmer stack without Studio or analytics services",
    },
    {
      command: "supabase start --service-version auth=v2.180.0",
      description: "Force a specific local service version for this run",
    },
  ]),
  Command.withHandler((flags) =>
    start(flags).pipe(
      Effect.withSpan("command.start"),
      withCommandAnalytics({
        command: "start",
        flags,
        allowedFlagValues: ["mode"],
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide((flags) => {
    const providedRuntimeLayer = provideProjectCommandRuntime(
      Layer.mergeAll(
        projectLinkStateLayer,
        projectLocalServiceVersionsLayer,
        projectStackStateManagerLayer,
      ),
    );

    const runtimeStateEffect = Effect.gen(function* () {
      const output = yield* Output;
      const cliConfig = yield* CliConfig;
      const projectHome = yield* ProjectHome;
      const runtimeInfo = yield* RuntimeInfo;
      const stateManager = yield* StateManager;
      const existingMetadata = yield* stateManager.readMetadata(flags.stack).pipe(
        Effect.map(Option.some),
        Effect.catchTag("StackMetadataNotFoundError", () => Effect.succeed(Option.none())),
      );
      const serviceVersionContext = yield* resolveServiceVersionContext(
        flags.serviceVersion,
        Option.match(existingMetadata, {
          onNone: () => undefined,
          onSome: (metadata) => metadata.services,
        }),
      );
      const stackConfig = withServiceVersions(
        toStartStackConfig(flags.exclude, flags.mode),
        serviceVersionContext.runtimeVersions,
      );
      const resolvedConfig = yield* Effect.promise(() =>
        resolveDaemonConfig({
          cacheRoot: cliConfig.supabaseHome,
          cwd: runtimeInfo.cwd,
          projectDir: projectHome.projectRoot,
          projectStateRoot: projectHome.projectHomeDir,
          name: flags.stack,
          ...stackConfig,
        }),
      );

      yield* output.intro("Start local Supabase stack");
      yield* ensureProjectStateIgnored(projectHome.projectRoot);

      const metadata = stackMetadata({
        ports: resolvedConfig.ports,
        services: serviceVersionContext.pinnedBaseline,
        launch: { mode: flags.mode, excludedServices: flags.exclude },
        lastNotifiedUpdateFingerprint:
          serviceVersionContext.updateFingerprint === undefined
            ? undefined
            : Option.match(existingMetadata, {
                onNone: () => undefined,
                onSome: (value) => value.lastNotifiedUpdateFingerprint,
              }),
      });
      yield* stateManager.writeMetadata(flags.stack, metadata);

      const stackLayer = yield* daemonLayer(
        {
          ...resolvedConfig,
          name: flags.stack,
          projectDir: projectHome.projectRoot,
        },
        daemonEntryPoint,
      );

      return {
        stackLayer,
        startVersionState: StartVersionState.of({
          metadata,
          serviceVersionContext,
        }),
      };
    });

    const commandLayer = Layer.unwrap(
      runtimeStateEffect.pipe(
        Effect.map(({ stackLayer, startVersionState }) =>
          Layer.mergeAll(stackLayer, Layer.succeed(StartVersionState, startVersionState)),
        ),
        Effect.provide(providedRuntimeLayer),
      ),
    );

    return Layer.mergeAll(commandLayer, inkLayer, providedRuntimeLayer);
  }),
);
