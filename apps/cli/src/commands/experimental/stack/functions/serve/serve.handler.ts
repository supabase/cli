import type {
  OpenStackError,
  ServeFunctionsError,
  StackDiscoveryError,
  StackLogEntry,
  StackLogsError,
  StackStatusError,
} from "@supabase/stack/effect";
import {
  Cause,
  Config,
  Crypto,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Match,
  Option,
  Path,
  Stream,
} from "effect";
import { CommandSettings } from "../../../../../config/command-settings.service.ts";
import { candidateDotenvFilenames } from "../../../../../command-internal/project-environment.ts";
import { DebugFlag } from "../../../../../command-internal/global-flags.ts";
import {
  type FunctionsServeFlags,
  type FunctionsServeWatchSpec,
  waitForFunctionsRestartSignal,
  writeStoppedServingMessage,
} from "../../../../../shared/functions/serve.ts";
import { Output } from "../../../../../shared/output/output.service.ts";
import { ProcessControl } from "../../../../../shared/runtime/process-control.service.ts";
import { RuntimeInfo } from "../../../../../shared/runtime/runtime-info.service.ts";
import { TelemetryState } from "../../../../../telemetry/telemetry-state.service.ts";
import { loadStackConfig } from "../../stack-config.ts";
import { StackApi } from "../../stack.shared.ts";
import { functionsServeStackConfig } from "./serve.config.ts";
import { StackFunctionsServeError } from "./serve.errors.ts";

type FunctionsStackApiError =
  | StackDiscoveryError
  | OpenStackError
  | ServeFunctionsError
  | StackLogsError
  | StackStatusError;

const serveError = (error: FunctionsStackApiError): StackFunctionsServeError => {
  const classification = Match.value(error).pipe(
    Match.tag("StackNotFoundError", "StackNotRunningError", () => ({
      reason: "lifecycle" as const,
      suggestion: "Run supabase start before serving Functions.",
    })),
    Match.tag("GatewayActivationError", () => ({
      reason: "invalid-config" as const,
      suggestion: "Enable edge_runtime in supabase/config.toml, then restart the stack.",
    })),
    Match.tag(
      "InvalidStackConfigError",
      "InvalidStackIdentityError",
      "StackVersionUnsupportedError",
      "StackSecretMismatchError",
      "InvalidJwtSigningMaterialError",
      "InvalidProjectRootError",
      "StackStateInvalidError",
      "StackStateFormatUnsupportedError",
      () => ({ reason: "invalid-config" as const }),
    ),
    Match.tag("StackPreparationError", "ArtifactIntegrityError", "ContainerPullError", () => ({
      reason: "artifact" as const,
      suggestion: "Retry with --debug and inspect the stack preparation diagnostics.",
    })),
    Match.tag("ContainerEngineError", "StackRuntimeError", () => ({
      reason: "runtime" as const,
      suggestion: "Retry with --debug and inspect the Functions runtime diagnostics.",
    })),
    Match.tag(
      "StackOwnershipConflictError",
      "StackLifecycleConflictError",
      "StackUpgradeRequiredError",
      "StackCleanupError",
      () => ({
        reason: "lifecycle" as const,
        suggestion: "Stop and restart the selected stack with this CLI, then retry.",
      }),
    ),
    Match.tag("StackRuntimeMismatchError", "InvalidLogCursorError", () => ({
      reason: "unknown" as const,
    })),
    Match.exhaustive,
  );
  return new StackFunctionsServeError({ ...classification, message: error.message, cause: error });
};

const renderLog = (entry: StackLogEntry): string =>
  entry.message.endsWith("\n") ? entry.message : `${entry.message}\n`;

const functionsWatchSpecs = (input: {
  readonly projectRoot: string;
  readonly watchPaths: ReadonlyArray<string>;
}): Effect.Effect<ReadonlyArray<FunctionsServeWatchSpec>, Config.ConfigError, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const functionsRoot = path.join(input.projectRoot, "supabase", "functions");
    const supabaseRoot = path.join(input.projectRoot, "supabase");
    const configuredEnvironment = yield* Config.string("SUPABASE_ENV").pipe(
      Config.withDefault("development"),
    );
    const environment = configuredEnvironment || "development";
    const files = [
      path.join(supabaseRoot, "config.toml"),
      ...[input.projectRoot, supabaseRoot].flatMap((root) =>
        candidateDotenvFilenames(environment).map((name) => path.join(root, name)),
      ),
      ...input.watchPaths,
    ];
    const fileSpecs = new Map<string, Set<string>>();
    for (const file of files) {
      const relative = path.relative(functionsRoot, file);
      if (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
        continue;
      const root = path.dirname(file);
      const matches = fileSpecs.get(root) ?? new Set<string>();
      matches.add(file);
      fileSpecs.set(root, matches);
    }
    return [
      { root: functionsRoot, recursive: true },
      ...[...fileSpecs].map(([root, matchPaths]) => ({
        root,
        recursive: false,
        matchPaths,
      })),
    ];
  });

const unexpectedTermination = () =>
  new StackFunctionsServeError({
    reason: "runtime",
    message: "Edge Functions stopped unexpectedly while the managed stack is still running.",
    suggestion: "Retry with --debug and inspect the Functions runtime diagnostics.",
  });

export const functionsServeStack = Effect.fn("experimental.stack.functions.serve")(function* (
  flags: FunctionsServeFlags,
) {
  const telemetryState = yield* TelemetryState;
  const body = Effect.gen(function* () {
    const output = yield* Output;
    const settings = yield* CommandSettings;
    const runtime = yield* RuntimeInfo;
    const processControl = yield* ProcessControl;
    const debug = yield* DebugFlag;
    const stackApi = yield* StackApi;
    const crypto = yield* Crypto.Crypto;
    const sessionId = yield* crypto.randomUUIDv4;
    const target = yield* stackApi
      .findStack({ projectRoot: settings.workdir })
      .pipe(Effect.mapError(serveError));
    if (Option.isNone(target))
      return yield* new StackFunctionsServeError({
        reason: "lifecycle",
        message: "No managed stack was found for this project.",
        suggestion: "Run supabase start before serving Functions.",
      });
    const stack = yield* stackApi.openStack(target.value.id).pipe(Effect.mapError(serveError));
    const shutdownRequested = yield* Deferred.make<void>();
    yield* processControl
      .awaitSignal(["SIGINT", "SIGTERM", "SIGHUP"])
      .pipe(
        Effect.andThen(Deferred.succeed(shutdownRequested, undefined)),
        Effect.forkScoped({ startImmediately: true }),
      );

    let transientRequested = false;
    let externallyStopped = false;
    const session = Effect.gen(function* () {
      for (;;) {
        const run = Effect.gen(function* () {
          const loaded = yield* (
            Option.isSome(flags.envFile)
              ? loadStackConfig(target.value.projectRoot, { discoverFunctionEnvFiles: false })
              : loadStackConfig(target.value.projectRoot)
          ).pipe(
            Effect.mapError(
              (cause) =>
                new StackFunctionsServeError({
                  reason: "invalid-config",
                  message: cause.message,
                  cause,
                }),
            ),
          );
          const resolved = yield* functionsServeStackConfig({
            config: loaded,
            flags,
            projectRoot: target.value.projectRoot,
            cwd: runtime.cwd,
            debug,
          });
          for (const warning of resolved.warnings) yield* output.raw(warning, "stderr");
          const watchSpecs = yield* functionsWatchSpecs({
            projectRoot: target.value.projectRoot,
            watchPaths: resolved.watchPaths,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new StackFunctionsServeError({
                  reason: "invalid-config",
                  message: "Unable to resolve SUPABASE_ENV",
                  cause,
                }),
            ),
          );
          const initial = yield* stack
            .logs({ capabilities: ["functions"], tail: 0 })
            .pipe(Effect.mapError(serveError));
          yield* output.raw("Setting up Edge Functions runtime...\n", "stderr");
          yield* Effect.sync(() => {
            transientRequested = true;
          });
          const watcher = yield* waitForFunctionsRestartSignal(watchSpecs).pipe(
            Effect.mapError(
              (cause) =>
                new StackFunctionsServeError({
                  reason: "runtime",
                  message: `Unable to watch ${cause.path}`,
                  cause,
                }),
            ),
            Effect.as("restart" as const),
            Effect.forkChild({ startImmediately: true }),
          );
          const status = yield* stack
            .serveFunctions({
              sessionId,
              config: resolved.config,
              ...(resolved.importMapSource === undefined
                ? {}
                : { importMapSource: resolved.importMapSource }),
            })
            .pipe(Effect.mapError(serveError));
          const apiUrl = status.endpoints.api?.url;
          if (apiUrl !== undefined)
            yield* output.raw(`Serving Functions on ${apiUrl}/functions/v1/<function-name>\n`);

          const follow = stack
            .followLogs({
              capabilities: ["functions"],
              cursor: initial.cursor,
            })
            .pipe(
              Stream.mapError(serveError),
              Stream.runForEach((entry) => output.raw(renderLog(entry))),
              Effect.andThen(Effect.never),
            );
          const termination = stack.serveFunctions({ sessionId, waitForTermination: true }).pipe(
            Effect.catchTag("StackNotRunningError", (waitError) =>
              stack.status.pipe(
                Effect.flatMap((status) =>
                  status.lifecycle === "stopped" ? Effect.succeed(status) : Effect.fail(waitError),
                ),
              ),
            ),
            Effect.mapError(serveError),
            Effect.flatMap((status) =>
              status.lifecycle === "stopped"
                ? Effect.succeed("stack-stopped" as const)
                : Effect.fail(unexpectedTermination()),
            ),
          );
          return yield* Effect.raceFirst(
            Fiber.join(watcher),
            Effect.raceFirst(follow, termination),
          );
        });
        const outcome = yield* Effect.raceFirst(
          Deferred.await(shutdownRequested).pipe(Effect.as("shutdown" as const)),
          run,
        );
        if (outcome === "stack-stopped") {
          yield* Effect.sync(() => {
            externallyStopped = true;
          });
          return;
        }
        if (outcome !== "restart") return;
      }
    });

    const { sessionExit, restoreExit } = yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const sessionExit = yield* restore(session).pipe(Effect.exit);
        const restoreExit =
          transientRequested && !externallyStopped
            ? yield* stack
                .serveFunctions({ sessionId })
                .pipe(Effect.mapError(serveError), Effect.asVoid, Effect.exit)
            : Exit.void;
        return { sessionExit, restoreExit };
      }),
    );
    if (Exit.isFailure(sessionExit) && Exit.isFailure(restoreExit))
      return yield* Effect.failCause(Cause.combine(sessionExit.cause, restoreExit.cause));
    if (Exit.isFailure(sessionExit)) return yield* Effect.failCause(sessionExit.cause);
    if (Exit.isFailure(restoreExit)) return yield* Effect.failCause(restoreExit.cause);
    yield* writeStoppedServingMessage();
  });
  return yield* body.pipe(Effect.ensuring(telemetryState.flush));
});
