import { BunServices } from "@effect/platform-bun";
import { ProjectConfigStore } from "@supabase/config";
import { unixHttpClientLayer } from "@supabase/stack";
import type { FileSystem, Path } from "effect";
import { Cause, Clock, Effect, Exit, Fiber, Layer, Stdio } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";
import { CLI_VERSION } from "./version.ts";
import { Credentials } from "../../next/auth/credentials.service.ts";
import type { CliConfig } from "../../next/config/cli-config.service.ts";
import { jsonCliOutputFormatter } from "../output/json-formatter.ts";
import { textCliOutputFormatter } from "../output/text-formatter.ts";
import { outputLayerFor } from "../output/output.layer.ts";
import { normalizeCause } from "../output/normalize-error.ts";
import type { OutputFormat } from "../output/types.ts";
import { Output } from "../output/output.service.ts";
import { cliConfigLayer } from "../../next/config/cli-config.layer.ts";
import { projectHomeLayer } from "../../next/config/project-home.layer.ts";
import { ProjectLocalServiceVersions } from "../../next/config/project-local-service-versions.service.ts";
import { projectContextLayer } from "../../next/config/project-context.layer.ts";
import { projectLinkStateLayer } from "../../next/config/project-link-state.layer.ts";
import { processControlLayer } from "../runtime/process-control.layer.ts";
import type { RuntimeInfo } from "../runtime/runtime-info.service.ts";
import { runtimeInfoLayer } from "../runtime/runtime-info.layer.ts";
import type { Tty } from "../runtime/tty.service.ts";
import { ttyLayer } from "../runtime/tty.layer.ts";
import { CommandRuntime } from "../runtime/command-runtime.service.ts";
import { ProcessControl } from "../runtime/process-control.service.ts";
import { Analytics } from "../telemetry/analytics.service.ts";
import { withAnalyticsContext } from "../telemetry/analytics-context.ts";
import { aiToolLayer } from "../telemetry/ai-tool.layer.ts";
import { AiTool } from "../telemetry/ai-tool.service.ts";
import {
  EventCommandExecuted,
  PropDurationMs,
  PropExitCode,
  PropOutputFormat,
} from "../telemetry/event-catalog.ts";
import { classifyCliCauseActionability } from "../telemetry/error-actionability.ts";
import { telemetryRuntimeLayer } from "../telemetry/runtime.layer.ts";
import { tracingLayer } from "../telemetry/tracing.layer.ts";
import { CliArgs } from "./cli-args.service.ts";
import { resolveAgentOutputFormatFromArgs } from "./agent-output.ts";

// Global flags that consume the following argv token as their value. Keep this in
// sync with the value-taking global flags defined in `shared/cli/global-flags.ts`
// and `legacy/shared/legacy/global-flags.ts`: a value flag missing here would make
// `extractCommandPath` mistake its value for a command-path segment.
const globalFlagsWithValues = new Set([
  "--output-format",
  "--output",
  "-o",
  "--profile",
  "--workdir",
  "--network-id",
  "--dns-resolver",
  "--agent",
]);

// Commands that run their own foreground signal loop (serve/start daemons) and must
// NOT be wrapped in the global signal-interrupt handler, which would otherwise race
// their graceful shutdown. Matched by leading command-path segments.
const selfManagedSignalCommands: ReadonlyArray<ReadonlyArray<string>> = [
  ["start"],
  ["db", "start"],
  ["functions", "serve"],
];

const preHandlerTelemetryTags = new Set([
  "InvalidServiceVersionOverrideError",
  "MissingOption",
  "ProjectConfigParseError",
  "ProjectEnvParseError",
  "UnknownSubcommand",
  "UnrecognizedOption",
]);

const rootTelemetryCommandPaths: ReadonlyArray<ReadonlyArray<string>> = [
  ["db", "schema", "declarative", "generate"],
  ["db", "schema", "declarative", "sync"],
  ["inspect", "db", "bloat"],
  ["inspect", "db", "blocking"],
  ["inspect", "db", "cache-hit"],
  ["inspect", "db", "calls"],
  ["inspect", "db", "db-stats"],
  ["inspect", "db", "index-sizes"],
  ["inspect", "db", "index-stats"],
  ["inspect", "db", "index-usage"],
  ["inspect", "db", "locks"],
  ["inspect", "db", "long-running-queries"],
  ["inspect", "db", "outliers"],
  ["inspect", "db", "replication-slots"],
  ["inspect", "db", "role-configs"],
  ["inspect", "db", "role-connections"],
  ["inspect", "db", "role-stats"],
  ["inspect", "db", "seq-scans"],
  ["inspect", "db", "table-index-sizes"],
  ["inspect", "db", "table-record-counts"],
  ["inspect", "db", "table-sizes"],
  ["inspect", "db", "table-stats"],
  ["inspect", "db", "total-index-size"],
  ["inspect", "db", "total-table-sizes"],
  ["inspect", "db", "traffic-profile"],
  ["inspect", "db", "unused-indexes"],
  ["inspect", "db", "vacuum-stats"],
  ["backups", "list"],
  ["backups", "restore"],
  ["branches", "create"],
  ["branches", "delete"],
  ["branches", "disable"],
  ["branches", "get"],
  ["branches", "list"],
  ["branches", "pause"],
  ["branches", "switch"],
  ["branches", "unpause"],
  ["branches", "update"],
  ["completion", "bash"],
  ["completion", "fish"],
  ["completion", "powershell"],
  ["completion", "zsh"],
  ["config", "push"],
  ["db", "advisors"],
  ["db", "branch", "create"],
  ["db", "branch", "delete"],
  ["db", "branch", "list"],
  ["db", "branch", "switch"],
  ["db", "branch"],
  ["db", "diff"],
  ["db", "dump"],
  ["db", "lint"],
  ["db", "pull"],
  ["db", "push"],
  ["db", "query"],
  ["db", "remote", "changes"],
  ["db", "remote", "commit"],
  ["db", "remote"],
  ["db", "reset"],
  ["db", "schema"],
  ["db", "start"],
  ["db", "test"],
  ["domains", "activate"],
  ["domains", "create"],
  ["domains", "delete"],
  ["domains", "get"],
  ["domains", "reverify"],
  ["encryption", "get-root-key"],
  ["encryption", "update-root-key"],
  ["functions", "delete"],
  ["functions", "deploy"],
  ["functions", "dev"],
  ["functions", "download"],
  ["functions", "list"],
  ["functions", "new"],
  ["functions", "serve"],
  ["gen", "bearer-jwt"],
  ["gen", "keys"],
  ["gen", "signing-key"],
  ["gen", "types"],
  ["inspect", "db"],
  ["inspect", "report"],
  ["migration", "down"],
  ["migration", "fetch"],
  ["migration", "list"],
  ["migration", "new"],
  ["migration", "repair"],
  ["migration", "squash"],
  ["migration", "up"],
  ["network-bans", "get"],
  ["network-bans", "remove"],
  ["network-restrictions", "get"],
  ["network-restrictions", "update"],
  ["orgs", "create"],
  ["orgs", "list"],
  ["postgres-config", "delete"],
  ["postgres-config", "get"],
  ["postgres-config", "update"],
  ["projects", "api-keys"],
  ["projects", "create"],
  ["projects", "delete"],
  ["projects", "list"],
  ["secrets", "list"],
  ["secrets", "set"],
  ["secrets", "unset"],
  ["seed", "buckets"],
  ["snippets", "download"],
  ["snippets", "list"],
  ["ssl-enforcement", "get"],
  ["ssl-enforcement", "update"],
  ["sso", "add"],
  ["sso", "info"],
  ["sso", "list"],
  ["sso", "remove"],
  ["sso", "show"],
  ["sso", "update"],
  ["storage", "cp"],
  ["storage", "ls"],
  ["storage", "mv"],
  ["storage", "rm"],
  ["telemetry", "disable"],
  ["telemetry", "enable"],
  ["telemetry", "status"],
  ["test", "db"],
  ["test", "new"],
  ["vanity-subdomains", "activate"],
  ["vanity-subdomains", "check-availability"],
  ["vanity-subdomains", "delete"],
  ["vanity-subdomains", "get"],
  ["backups"],
  ["bootstrap"],
  ["branches"],
  ["completion"],
  ["config"],
  ["db"],
  ["domains"],
  ["encryption"],
  ["functions"],
  ["gen"],
  ["init"],
  ["inspect"],
  ["issue", "bug"],
  ["issue", "feature"],
  ["issue", "docs"],
  ["issue"],
  ["link"],
  ["list"],
  ["login"],
  ["logout"],
  ["logs"],
  ["migration"],
  ["network-bans"],
  ["network-restrictions"],
  ["orgs"],
  ["platform"],
  ["postgres-config"],
  ["projects"],
  ["secrets"],
  ["seed"],
  ["services"],
  ["snippets"],
  ["ssl-enforcement"],
  ["sso"],
  ["start"],
  ["status"],
  ["stop"],
  ["storage"],
  ["telemetry"],
  ["test"],
  ["unlink"],
  ["update"],
  ["vanity-subdomains"],
];

const legacyRootTelemetryMachineOutputFormats = new Set(["csv", "env", "json", "toml", "yaml"]);
const legacyRootTelemetryOutputFormats = new Set([
  ...legacyRootTelemetryMachineOutputFormats,
  "pretty",
  "table",
]);

/** Positional command-path tokens from argv, skipping global flags and their values. */
export function extractCommandPath(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const commandArgs: Array<string> = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg.startsWith("-")) {
      const [flag] = arg.split("=", 1);
      if (!arg.includes("=") && flag !== undefined && globalFlagsWithValues.has(flag)) {
        index += 1;
      }
      continue;
    }
    commandArgs.push(arg);
  }
  return commandArgs;
}

function normalizeRootTelemetryCommandPath(
  commandPath: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (commandPath[0] === "migrations") {
    return ["migration", ...commandPath.slice(1)];
  }
  return commandPath;
}

/** Whether the global signal-interrupt handler should wrap this invocation. */
export function shouldUseGlobalSignalInterrupt(args: ReadonlyArray<string>): boolean {
  const commandPath = extractCommandPath(args);
  return !selfManagedSignalCommands.some((command) =>
    command.every((segment, index) => commandPath[index] === segment),
  );
}

function formatterLayerFor(
  rootCommand: Command.Command.Any,
  args: ReadonlyArray<string>,
  format: OutputFormat,
) {
  const context = { rootCommand, args };
  return format === "json" || format === "stream-json"
    ? CliOutput.layer(jsonCliOutputFormatter(context))
    : CliOutput.layer(textCliOutputFormatter(context));
}

function isErrorRecord(error: unknown): error is Record<string, unknown> {
  return typeof error === "object" && error !== null;
}

function isExplicitHelpCause(cause: Cause.Cause<unknown>): boolean {
  const error = Cause.findErrorOption(cause);
  if (error._tag !== "Some" || !isErrorRecord(error.value)) return false;
  if (error.value["_tag"] !== "ShowHelp") return false;

  const errors = error.value["errors"];
  return !Array.isArray(errors) || errors.length === 0;
}

function readCauseErrorTag(cause: Cause.Cause<unknown>): string | undefined {
  const error = Cause.findErrorOption(cause);
  if (error._tag !== "Some" || !isErrorRecord(error.value)) return undefined;
  const tag = error.value["_tag"];
  return typeof tag === "string" ? tag : undefined;
}

function isPortAllocationStackError(cause: Cause.Cause<unknown>): boolean {
  const error = Cause.findErrorOption(cause);
  if (error._tag !== "Some" || !isErrorRecord(error.value)) return false;
  return error.value["name"] === "StackError" && error.value["code"] === "PORT_ALLOCATION";
}

export function shouldCapturePreHandlerFailureTelemetry(cause: Cause.Cause<unknown>): boolean {
  const error = Cause.findErrorOption(cause);
  if (error._tag !== "Some" || !isErrorRecord(error.value)) return false;
  if (isPortAllocationStackError(cause)) return true;

  const tag = readCauseErrorTag(cause);
  if (tag === "ShowHelp") {
    const errors = error.value["errors"];
    return Array.isArray(errors) && errors.length > 0;
  }

  return tag !== undefined && preHandlerTelemetryTags.has(tag);
}

export function commandNameForRootTelemetry(args: ReadonlyArray<string>): string {
  const commandPath = normalizeRootTelemetryCommandPath(extractCommandPath(args));
  const matchedPath = rootTelemetryCommandPaths.find((candidate) =>
    candidate.every((segment, index) => commandPath[index] === segment),
  );
  return matchedPath === undefined ? "root" : matchedPath.join(" ");
}

function extractLegacyRootTelemetryOutputFormat(args: ReadonlyArray<string>): string | undefined {
  if (commandNameForRootTelemetry(args) === "db diff") return undefined;

  let format: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg === "--output" || arg === "-o") {
      const value = args[index + 1];
      if (value !== undefined && legacyRootTelemetryOutputFormats.has(value)) {
        format = value;
      }
      index += 1;
      continue;
    }

    if (arg.startsWith("--output=") || arg.startsWith("-o=")) {
      const value = arg.slice(arg.indexOf("=") + 1);
      if (legacyRootTelemetryOutputFormats.has(value)) {
        format = value;
      }
      continue;
    }

    if (arg.startsWith("-o") && arg.length > 2) {
      const value = arg.slice(2);
      if (legacyRootTelemetryOutputFormats.has(value)) {
        format = value;
      }
    }
  }

  return format;
}

export function outputFormatForRootTelemetry(
  args: ReadonlyArray<string>,
  outputFormat: OutputFormat,
): string {
  const legacyOutputFormat = extractLegacyRootTelemetryOutputFormat(args);
  const commandName = commandNameForRootTelemetry(args);
  if (
    (legacyOutputFormat === "csv" || legacyOutputFormat === "table") &&
    commandName === "db query"
  ) {
    return legacyOutputFormat;
  }
  if (
    legacyOutputFormat !== undefined &&
    legacyOutputFormat !== "csv" &&
    legacyRootTelemetryMachineOutputFormats.has(legacyOutputFormat)
  ) {
    return legacyOutputFormat;
  }
  return outputFormat;
}

export function capturePreHandlerFailureTelemetry(
  args: ReadonlyArray<string>,
  outputFormat: string,
  durationMs: number,
  cause: Cause.Cause<unknown>,
) {
  return Effect.gen(function* () {
    if (!shouldCapturePreHandlerFailureTelemetry(cause)) return;

    const analytics = yield* Analytics;
    yield* analytics
      .capture(EventCommandExecuted, {
        [PropExitCode]: 1,
        [PropDurationMs]: durationMs,
        [PropOutputFormat]: outputFormat,
        ...classifyCliCauseActionability(cause),
      })
      .pipe(
        withAnalyticsContext({
          command_run_id: crypto.randomUUID(),
          command: commandNameForRootTelemetry(args),
        }),
      );
  }).pipe(Effect.catchCause(() => Effect.void));
}

function projectContextLayerFor(runtimeLayer: Layer.Layer<never>) {
  return projectContextLayer.pipe(Layer.provide(runtimeLayer), Layer.provide(BunServices.layer));
}

function cliConfigLayerFor(runtimeLayer: Layer.Layer<never>) {
  return cliConfigLayer.pipe(
    Layer.provide(projectContextLayerFor(runtimeLayer)),
    Layer.provide(runtimeLayer),
  );
}

function projectHomeLayerFor(runtimeLayer: Layer.Layer<never>) {
  return projectHomeLayer.pipe(
    Layer.provide(cliConfigLayerFor(runtimeLayer)),
    Layer.provide(projectContextLayerFor(runtimeLayer)),
    Layer.provide(runtimeLayer),
    Layer.provide(BunServices.layer),
  );
}

type AnyAnalyticsLayer = Layer.Layer<
  Analytics,
  never,
  CliConfig | FileSystem.FileSystem | Path.Path | RuntimeInfo | Tty
>;

export interface RunCliOptions {
  readonly analyticsLayer: AnyAnalyticsLayer;
}

function cliProgramFor(
  rootCommand: Command.Command.Any,
  args: ReadonlyArray<string>,
  options: RunCliOptions,
  outputFormat: OutputFormat,
): Effect.Effect<void, unknown, any> {
  const runtimeLayer = Layer.mergeAll(processControlLayer, runtimeInfoLayer, ttyLayer);
  const fallbackCommandLayer = Layer.mergeAll(
    // Root command env inference currently leaks some subcommand-provided services.
    Layer.succeed(Credentials, {
      getAccessToken: Effect.die("unexpected root credentials access"),
      saveAccessToken: () => Effect.die("unexpected root credentials write"),
      deleteAccessToken: Effect.die("unexpected root credentials deletion"),
    }),
    Layer.succeed(ProjectLocalServiceVersions, {
      load: Effect.die("unexpected root project local service versions access"),
    }),
    Layer.succeed(ProjectConfigStore, {
      load: () => Effect.die("unexpected root project config access"),
      loadFile: () => Effect.die("unexpected root project config file access"),
      save: () => Effect.die("unexpected root project config write"),
    }),
    Layer.succeed(
      CommandRuntime,
      CommandRuntime.of({
        commandPath: ["root"],
        commandRunId: "root-command-run-id",
      }),
    ),
  );
  return Command.runWith(rootCommand, { version: CLI_VERSION })(args).pipe(
    Effect.provide(formatterLayerFor(rootCommand, args, outputFormat)),
    Effect.provide(options.analyticsLayer),
    Effect.provide(tracingLayer),
    Effect.provide(telemetryRuntimeLayer),
    Effect.provide(cliConfigLayerFor(runtimeLayer)),
    Effect.provide(projectContextLayerFor(runtimeLayer)),
    Effect.provide(projectLinkStateLayer),
    Effect.provide(projectHomeLayerFor(runtimeLayer)),
    Effect.provide(runtimeLayer),
    Effect.provide(unixHttpClientLayer),
    Effect.provide(fallbackCommandLayer),
    Effect.provide(Layer.succeed(CliArgs, { args })),
    Effect.provide(BunServices.layer),
  );
}

export async function runCli(rootCommand: Command.Command.Any, options: RunCliOptions) {
  const args = await Effect.runPromise(
    Effect.gen(function* () {
      const stdio = yield* Stdio.Stdio;
      return yield* stdio.args;
    }).pipe(Effect.provide(BunServices.layer)),
  );

  const useGlobalSignalInterrupt = shouldUseGlobalSignalInterrupt(args);
  const outputFormat = await Effect.runPromise(
    Effect.gen(function* () {
      const aiTool = yield* AiTool;
      return resolveAgentOutputFormatFromArgs(args, aiTool.name);
    }).pipe(Effect.provide(aiToolLayer)),
  );
  const cliProgram = cliProgramFor(rootCommand, args, options, outputFormat);

  const signalAwareProgram = Effect.scoped(
    Effect.gen(function* () {
      const processControl = yield* ProcessControl;
      const cliFiber = yield* cliProgram.pipe(Effect.forkScoped);
      const outcome = yield* Effect.raceFirst(
        Fiber.await(cliFiber).pipe(Effect.map((exit) => ({ _tag: "cli" as const, exit }))),
        processControl
          .awaitSignal()
          .pipe(Effect.map((signal) => ({ _tag: "signal" as const, signal }))),
      );

      if (outcome._tag === "signal") {
        yield* Fiber.interrupt(cliFiber);
        return yield* Effect.interrupt;
      }

      return yield* outcome.exit;
    }),
  ).pipe(
    Effect.provide(processControlLayer),
    Effect.provide(runtimeInfoLayer),
    Effect.provide(ttyLayer),
    Effect.provide(unixHttpClientLayer),
    Effect.provide(BunServices.layer),
  );

  const handledRuntimeLayer = Layer.mergeAll(processControlLayer, runtimeInfoLayer, ttyLayer);
  const captureHandledPreHandlerFailureTelemetry = (
    outputFormat: string,
    durationMs: number,
    cause: Cause.Cause<unknown>,
  ) =>
    capturePreHandlerFailureTelemetry(args, outputFormat, durationMs, cause).pipe(
      Effect.provide(options.analyticsLayer),
      Effect.provide(tracingLayer),
      Effect.provide(telemetryRuntimeLayer),
      Effect.provide(projectHomeLayerFor(handledRuntimeLayer)),
      Effect.provide(cliConfigLayerFor(handledRuntimeLayer)),
      Effect.provide(projectContextLayerFor(handledRuntimeLayer)),
      Effect.catchCause(() => Effect.void),
    );

  const handledProgram = (program: Effect.Effect<unknown, unknown, any>): any =>
    Effect.gen(function* () {
      const processControl = yield* ProcessControl;
      const output = yield* Output;
      yield* processControl.clearHandledFailureCause;
      const startedAt = yield* Clock.currentTimeMillis;
      const exit = yield* program.pipe(Effect.exit);
      const finishedAt = yield* Clock.currentTimeMillis;
      if (Exit.isFailure(exit)) {
        const interrupted = Cause.hasInterruptsOnly(exit.cause);
        if (!interrupted && !isExplicitHelpCause(exit.cause)) {
          yield* captureHandledPreHandlerFailureTelemetry(
            outputFormatForRootTelemetry(args, outputFormat),
            finishedAt - startedAt,
            exit.cause,
          );
          yield* output.fail(normalizeCause(exit.cause));
        }
        yield* processControl.clearHandledFailureCause;
        return yield* processControl.exit(interrupted ? 130 : 1);
      }
      const exitCode = yield* processControl.getExitCode;
      const handledFailureCause = yield* processControl.getHandledFailureCause;
      if ((exitCode ?? 0) !== 0 && handledFailureCause !== undefined) {
        yield* captureHandledPreHandlerFailureTelemetry(
          outputFormatForRootTelemetry(args, outputFormat),
          finishedAt - startedAt,
          handledFailureCause,
        );
      }
      yield* processControl.clearHandledFailureCause;
      return yield* processControl.exit(exitCode ?? 0);
    }).pipe(
      Effect.provide(outputLayerFor(outputFormat)),
      Effect.provide(processControlLayer),
      Effect.provide(runtimeInfoLayer),
      Effect.provide(ttyLayer),
      Effect.provide(unixHttpClientLayer),
      Effect.provide(BunServices.layer),
    );

  if (useGlobalSignalInterrupt) {
    await Effect.runPromise(handledProgram(signalAwareProgram));
  } else {
    await Effect.runPromise(handledProgram(cliProgram));
  }
}
