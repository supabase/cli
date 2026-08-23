import { Effect, Layer, Context, Option } from "effect";
import { loadProjectConfig } from "@supabase/config";
import {
  DEFAULT_MANAGED_STACK_NAME,
  daemonLayer,
  fillServiceVersionManifest,
  resolveStackSummary,
  type StackSummary,
} from "@supabase/stack/effect";
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
import { managedPortIntents } from "../../config/managed-port-intents.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { inkLayer } from "../../../shared/runtime/ink.layer.ts";
import { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import { withCommandInstrumentation } from "../../../shared/telemetry/command-instrumentation.ts";
import { start } from "./start.handler.ts";
import { currentCliBuildIdentity } from "../../../shared/cli/version.ts";

/**
 * Deprecation warning shown when `[api].auto_expose_new_tables = true` is loaded from
 * config.toml. Mirrors the Go CLI warning emitted during config validation
 * (`apps/cli-go/pkg/config/config.go`).
 */
export const AUTO_EXPOSE_NEW_TABLES_DEPRECATION_WARNING =
  "api.auto_expose_new_tables is deprecated and will be removed on 2026-10-30. Remove the field or set it to false to adopt the new default of revoking Data API privileges on new entities in the public schema.";

/**
 * Resolves the tri-state `[api].auto_expose_new_tables` flag from config.toml.
 *
 *   - unset (`undefined`): defaults to `false` (revoke), matching the 2026-05-30 cloud flip.
 *   - `true`: keep the legacy auto-expose behaviour, but surface a deprecation warning.
 *   - `false`: revoke explicitly (no warning).
 */
export function resolveAutoExposeNewTables(value: boolean | undefined): {
  readonly autoExposeNewTables: boolean;
  readonly deprecationWarning: string | undefined;
} {
  return {
    autoExposeNewTables: value ?? false,
    deprecationWarning: value === true ? AUTO_EXPOSE_NEW_TABLES_DEPRECATION_WARNING : undefined,
  };
}

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
    readonly excludedServices: ReadonlyArray<ExcludedStackService>;
  };
  readonly previousUpdateFingerprint?: string;
  readonly drift?: NonNullable<StackSummary["drift"]>;
  readonly serviceVersionContext: ResolvedServiceVersionContext;
  readonly lifecycleInput: {
    readonly cacheRoot: string;
    readonly workspacePath: string;
    readonly stackName: string;
    readonly cwd: string;
    readonly buildIdentity: import("../../../shared/cli/version.ts").CliBuildIdentity;
  };
}

export class StartVersionState extends Context.Service<StartVersionState, StartVersionStateShape>()(
  "supabase/commands/start/StartVersionState",
) {}

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
    const providedRuntimeLayer = provideProjectCommandRuntime(
      Layer.mergeAll(
        projectLinkStateLayer,
        projectLocalServiceVersionsLayer,
        commandRuntimeLayer(["start"]),
      ),
    );

    const runtimeStateEffect = Effect.gen(function* () {
      const output = yield* Output;
      const buildIdentity = yield* currentCliBuildIdentity;
      const cliConfig = yield* CliConfig;
      const projectHome = yield* ProjectHome;
      const runtimeInfo = yield* RuntimeInfo;
      const existingSummary = yield* resolveStackSummary({
        cacheRoot: cliConfig.supabaseHome,
        projectDir: projectHome.projectRoot,
        cwd: runtimeInfo.cwd,
        name: flags.stack,
      }).pipe(Effect.catchTag("NoRunningStackError", () => Effect.succeed(undefined)));
      const serviceVersionContext = yield* resolveServiceVersionContext(
        flags.serviceVersion,
        existingSummary === undefined
          ? undefined
          : fillServiceVersionManifest(existingSummary.versions),
      );
      // The flag is tri-state in config.toml: unset / true / false. As of the 2026-05-30 flip,
      // unset behaves as false (revoke the default Data API GRANTs) to match the new cloud
      // default. Explicit true preserves the legacy auto-expose behaviour but is deprecated and
      // emits a warning; the field is removed entirely on 2026-10-30.
      const loadedProjectConfig = yield* loadProjectConfig(projectHome.projectRoot);
      const { autoExposeNewTables, deprecationWarning } = resolveAutoExposeNewTables(
        loadedProjectConfig?.config.api.auto_expose_new_tables,
      );
      if (deprecationWarning !== undefined) {
        yield* output.warn(deprecationWarning);
      }
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
      yield* ensureProjectStateIgnored(projectHome.projectRoot);

      const portIntents = managedPortIntents(stackConfig, loadedProjectConfig ?? undefined);
      const configuredSummary =
        existingSummary === undefined
          ? undefined
          : yield* resolveStackSummary({
              cacheRoot: cliConfig.supabaseHome,
              projectDir: projectHome.projectRoot,
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

      const stackLayer = yield* daemonLayer({
        buildIdentity,
        incompatibleOwnerPolicy: "replace",
        onReplacing: ({ oldCliVersion, newCliVersion }) =>
          output.warn(
            [
              `Restarting local stack from CLI v${oldCliVersion} with CLI v${newCliVersion}.`,
              "Database and storage data, pinned service versions, and sticky ports will be preserved.",
              "Existing connections will briefly disconnect.",
            ].join("\n"),
          ),
        cacheRoot: cliConfig.supabaseHome,
        cwd: runtimeInfo.cwd,
        projectDir: projectHome.projectRoot,
        name: flags.stack,
        portIntents,
        launch,
        ...stackConfig,
      });
      const summary = yield* resolveStackSummary({
        cacheRoot: cliConfig.supabaseHome,
        projectDir: projectHome.projectRoot,
        cwd: runtimeInfo.cwd,
        name: flags.stack,
      });
      return {
        stackLayer,
        startVersionState: StartVersionState.of({
          launch: {
            mode: summary.launch.mode,
            versions: serviceVersionContext.pinnedBaseline,
            excludedServices: flags.exclude,
          },
          ...(summary.lastNotifiedUpdateFingerprint === undefined
            ? {}
            : { previousUpdateFingerprint: summary.lastNotifiedUpdateFingerprint }),
          ...(configuredSummary?.running !== true || configuredSummary.drift === undefined
            ? {}
            : { drift: configuredSummary.drift }),
          serviceVersionContext,
          lifecycleInput: {
            cacheRoot: cliConfig.supabaseHome,
            workspacePath: projectHome.projectRoot,
            stackName: flags.stack,
            cwd: runtimeInfo.cwd,
            buildIdentity,
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
