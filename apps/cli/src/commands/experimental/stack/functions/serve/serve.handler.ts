import type {
  OpenStackError,
  ServeFunctionsError,
  StackDiscoveryError,
  StackLogEntry,
  StackLogsError,
} from "@supabase/stack/effect";
import { Effect, Match, Option, Stream } from "effect";
import { CommandSettings } from "../../../../../config/command-settings.service.ts";
import { DebugFlag } from "../../../../../command-internal/global-flags.ts";
import type { FunctionsServeFlags } from "../../../../../shared/functions/serve.ts";
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
  | StackLogsError;

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
    const loaded = yield* loadStackConfig(target.value.projectRoot).pipe(
      Effect.mapError(
        (cause) =>
          new StackFunctionsServeError({
            reason: "invalid-config",
            message: cause.message,
            cause,
          }),
      ),
    );
    const config = yield* functionsServeStackConfig({
      config: loaded,
      flags,
      projectRoot: target.value.projectRoot,
      cwd: runtime.cwd,
      debug,
    });
    const initial = yield* stack
      .logs({ capabilities: ["functions"], tail: 0 })
      .pipe(Effect.mapError(serveError));
    yield* output.raw("Setting up Edge Functions runtime...\n");
    const status = yield* stack.serveFunctions({ config }).pipe(Effect.mapError(serveError));
    const apiUrl = status.endpoints.api?.url;
    if (apiUrl !== undefined)
      yield* output.raw(`Serving Functions on ${apiUrl}/functions/v1/<function-name>\n`);

    const follow = stack.followLogs({ capabilities: ["functions"], cursor: initial.cursor }).pipe(
      Stream.mapError(serveError),
      Stream.runForEach((entry) => output.raw(renderLog(entry))),
    );
    yield* Effect.raceFirst(
      follow,
      processControl.awaitSignal(["SIGINT", "SIGTERM", "SIGHUP"]).pipe(Effect.asVoid),
    );
    yield* output.raw("Stopped serving supabase/functions\n");
  });
  return yield* body.pipe(Effect.ensuring(telemetryState.flush));
});
