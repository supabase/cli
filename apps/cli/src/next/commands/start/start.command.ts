import { Effect, Layer, Context, Option } from "effect";
import { loadCliConfig } from "@supabase/config/effect";
import {
  DEFAULT_MANAGED_STACK_NAME,
  daemonLayer,
  restartManagedStackForUpgrade,
  fillServiceVersionManifest,
  resolveStackSummary,
  type StackSummary,
} from "@supabase/stack/effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { cliProjectLocalServiceVersionsLayer } from "../../config/cli-project-local-service-versions.layer.ts";
import { ensureProjectStateIgnored } from "../../config/project-gitignore.ts";
import { CliSettings } from "../../config/cli-settings.service.ts";
import { CliProjectHome } from "../../config/cli-project-home.service.ts";
import { projectLinkStateLayer } from "../../config/project-link-state.layer.ts";
import { provideCliProjectCommandRuntime } from "../../config/project-runtime.layer.ts";
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
import { managedPortIntents } from "../../config/managed-port-intents.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { inkLayer } from "../../../shared/runtime/ink.layer.ts";
import { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import { withCommandInstrumentation } from "../../../shared/telemetry/command-instrumentation.ts";
import { start } from "./start.handler.ts";
import { CLI_VERSION } from "../../../shared/cli/version.ts";

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
    'Stack startup mode. "native" requires native-compatible services and "docker" requires a usable Docker or Podman runtime.',
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

interface StartVersionStateShape {
  readonly launch: {
    readonly mode?: StartMode;
    readonly versions: Readonly<Record<string, string>>;
    /**
     * Preserve the managed document's raw exclusions. The document may contain
     * service names introduced by a newer CLI; narrowing is only appropriate
     * when deriving the current runtime configuration.
     */
    readonly excludedServices: ReadonlyArray<string>;
  };
  readonly previousUpdateFingerprint?: string;
  readonly drift?: NonNullable<StackSummary["drift"]>;
  readonly serviceVersionContext: ResolvedServiceVersionContext;
  readonly lifecycleInput: {
    readonly cacheRoot: string;
    readonly workspacePath: string;
    readonly stackName: string;
    readonly cwd: string;
    readonly cliVersion: string;
  };
}

export class StartVersionState extends Context.Service<StartVersionState, StartVersionStateShape>()(
  "supabase/commands/start/StartVersionState",
) {}

/**
 * Project the managed launch metadata observed after daemon startup into the
 * state consumed by the start handler. The post-start summary is authoritative:
 * an incompatible-owner upgrade restart may preserve selections from the existing
 * daemon even when this invocation supplied different flags or version defaults.
 * @internal
 */
export const startVersionStateLaunch = (
  summary: Pick<StackSummary, "launch">,
): StartVersionStateShape["launch"] => ({
  mode: summary.launch.mode,
  versions: summary.launch.versions,
  excludedServices: summary.launch.excludedServices ?? [],
});

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
      "Starts the full local Supabase stack when Docker or Podman is usable; otherwise a supported host starts the native-capable service set. Use --mode to require one explicitly.\n\n" +
      "Named CLI stacks persist managed runtime state under the Supabase home directory. Use --exclude to skip optional services. Use --detach to run in the background.",
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
      withCommandInstrumentation({
        flags,
        allowedFlagValues: ["mode"],
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide((flags) => {
    const providedRuntimeLayer = provideCliProjectCommandRuntime(
      Layer.mergeAll(
        projectLinkStateLayer,
        cliProjectLocalServiceVersionsLayer,
        commandRuntimeLayer(["start"]),
      ),
    );

    const runtimeStateEffect = Effect.gen(function* () {
      const output = yield* Output;
      const cliSettings = yield* CliSettings;
      const cliProjectHome = yield* CliProjectHome;
      const runtimeInfo = yield* RuntimeInfo;
      const existingSummary = yield* resolveStackSummary({
        cacheRoot: cliSettings.supabaseHome,
        projectDir: cliProjectHome.projectRoot,
        cwd: runtimeInfo.cwd,
        name: flags.stack,
      }).pipe(Effect.catchTag("NoRunningStackError", () => Effect.succeed(undefined)));
      const serviceVersionContext = yield* resolveServiceVersionContext(
        flags.serviceVersion,
        existingSummary === undefined
          ? undefined
          : fillServiceVersionManifest(existingSummary.versions),
      );
      const loadedCliConfig = yield* loadCliConfig(cliProjectHome.projectRoot);
      // Tri-state in config.toml: unset and explicit `true` both auto-expose new entities in
      // `public` (the cloud default); only explicit `false` revokes the default Data API GRANTs.
      const autoExposeNewTables = loadedCliConfig?.config.api.auto_expose_new_tables ?? true;
      const effectiveMode = flags.mode ?? existingSummary?.launch.mode;
      const baseStackConfig = withServiceVersions(
        toStartStackConfig(flags.exclude, effectiveMode),
        serviceVersionContext.runtimeVersions,
      );
      const stackConfig = {
        ...baseStackConfig,
        postgres: { ...baseStackConfig.postgres, autoExposeNewTables },
      };
      yield* output.intro("Start local Supabase stack");
      yield* ensureProjectStateIgnored(cliProjectHome.projectRoot);

      const portIntents = managedPortIntents(stackConfig, loadedCliConfig ?? undefined);
      const configuredSummary =
        existingSummary === undefined
          ? undefined
          : yield* resolveStackSummary({
              cacheRoot: cliSettings.supabaseHome,
              projectDir: cliProjectHome.projectRoot,
              cwd: runtimeInfo.cwd,
              name: flags.stack,
              portDocument: portIntents,
            });
      const launch = {
        ...(flags.mode === undefined ? {} : { mode: flags.mode }),
        versions: serviceVersionContext.pinnedBaseline,
        excludedServices: flags.exclude,
        ...(existingSummary?.lastNotifiedUpdateFingerprint === undefined
          ? {}
          : { lastNotifiedUpdateFingerprint: existingSummary.lastNotifiedUpdateFingerprint }),
      };

      const managedInput = {
        cliVersion: CLI_VERSION,
        cacheRoot: cliSettings.supabaseHome,
        cwd: runtimeInfo.cwd,
        projectDir: cliProjectHome.projectRoot,
        name: flags.stack,
        portIntents,
        launch,
        ...stackConfig,
      };
      const stackLayer = yield* daemonLayer(managedInput).pipe(
        Effect.catchTag("DaemonUpgradeRequired", (error) =>
          output
            .warn(
              [
                `Local stack was started with CLI v${error.oldCliVersion}. Restarting it with CLI v${error.newCliVersion}.`,
                "Database and storage data, pinned service versions, and sticky ports will be preserved.",
                "Existing connections will briefly disconnect.",
              ].join("\n"),
            )
            .pipe(Effect.andThen(restartManagedStackForUpgrade(managedInput, error))),
        ),
      );
      const summary = yield* resolveStackSummary({
        cacheRoot: cliSettings.supabaseHome,
        projectDir: cliProjectHome.projectRoot,
        cwd: runtimeInfo.cwd,
        name: flags.stack,
      });
      return {
        stackLayer,
        startVersionState: StartVersionState.of({
          launch: startVersionStateLaunch(summary),
          ...(summary.lastNotifiedUpdateFingerprint === undefined
            ? {}
            : { previousUpdateFingerprint: summary.lastNotifiedUpdateFingerprint }),
          ...(configuredSummary?.running !== true || configuredSummary.drift === undefined
            ? {}
            : { drift: configuredSummary.drift }),
          serviceVersionContext,
          lifecycleInput: {
            cacheRoot: cliSettings.supabaseHome,
            workspacePath: cliProjectHome.projectRoot,
            stackName: flags.stack,
            cwd: runtimeInfo.cwd,
            cliVersion: CLI_VERSION,
          },
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
