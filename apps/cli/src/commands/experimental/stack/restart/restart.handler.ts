import { Effect, Match, Option } from "effect";
import type { StackDescriptor, StackError, StackId } from "@supabase/stack/effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { OutputFlag } from "../../../../command-internal/global-flags.ts";
import { CommandSettings } from "../../../../config/command-settings.service.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import {
  StackApi,
  StackTargetError,
  rejectStackOutput,
  renderStackStatus,
  stackStatusPayload,
  validateStackId,
  validateStackTarget,
} from "../stack.shared.ts";
import type { StackRestartFlags } from "./restart.command.ts";
import { StackCommandRestartError } from "./restart.errors.ts";

const mapTargetError = (error: StackTargetError) =>
  new StackCommandRestartError({
    reason: error.reason,
    message: error.message,
    ...(error.suggestion === undefined ? {} : { suggestion: error.suggestion }),
    cause: error,
  });

const mapStackError = (error: StackError) => {
  const classification = Match.value(error).pipe(
    Match.tag("StackNotFoundError", () => ({ reason: "not-found" as const })),
    Match.tag("InvalidStackIdentityError", () => ({ reason: "flags" as const })),
    Match.tag("PortUnavailableError", "PortAllocationError", () => ({
      reason: "port" as const,
      suggestion:
        "Free the conflicting port and retry, or stop the stack and use supabase stack start to apply updated project port configuration.",
    })),
    Match.tag(
      "InvalidStackConfigError",
      "StackVersionUnsupportedError",
      "InvalidProjectRootError",
      "StackStateInvalidError",
      "StackStateFormatUnsupportedError",
      "StackSecretMismatchError",
      "InvalidJwtSigningMaterialError",
      () => ({ reason: "invalid-config" as const }),
    ),
    Match.tag("StackRuntimeMismatchError", () => ({
      reason: "flags" as const,
      suggestion:
        "Restart preserves the existing runtime; choose a different existing stack if needed.",
    })),
    Match.tag(
      "StackLifecycleConflictError",
      "StackNotRunningError",
      "StackMustBeStoppedError",
      "StackOwnershipConflictError",
      "StackUpgradeRequiredError",
      () => ({
        reason: "lifecycle" as const,
        suggestion: "Run supabase stack status to inspect the stack state.",
      }),
    ),
    Match.tag("ContainerEngineError", () => ({
      reason: "runtime" as const,
      suggestion: "Ensure the selected container engine is running and retry the command.",
    })),
    Match.tag("ContainerPullError", () => ({
      reason: "registry" as const,
      suggestion: "Check registry connectivity and image availability, then retry the command.",
    })),
    Match.tag("ArtifactIntegrityError", "StackPreparationError", () => ({
      reason: "artifact" as const,
      suggestion: "Retry the stack restart with --debug if the artifact cannot be prepared.",
    })),
    Match.tag("StackRuntimeError", () => ({
      reason: "unknown" as const,
      suggestion: "Retry the stack restart with --debug and inspect the runtime diagnostics.",
    })),
    Match.tag("StackCleanupError", () => ({
      reason: "unknown" as const,
      suggestion: "Retry the stack restart with --debug and inspect cleanup diagnostics.",
    })),
    Match.orElse(() => ({ reason: "unknown" as const })),
  );
  return new StackCommandRestartError({
    ...classification,
    message: error.message,
    cause: error,
  });
};

export const stackRestart = Effect.fn("experimental.stack.restart")(function* (
  flags: StackRestartFlags,
) {
  const telemetryState = yield* TelemetryState;
  const body = Effect.gen(function* () {
    const output = yield* Output;
    const settings = yield* CommandSettings;
    const api = yield* StackApi;
    const outputFlag = yield* Effect.serviceOption(OutputFlag);
    yield* rejectStackOutput(outputFlag).pipe(Effect.mapError(mapTargetError));
    yield* validateStackTarget({
      stack: Option.getOrUndefined(flags.stack),
      stackId: Option.getOrUndefined(flags.stackId),
    }).pipe(Effect.mapError(mapTargetError));

    let id: StackId;
    let desiredLifecycle: StackDescriptor["desiredLifecycle"];
    if (Option.isSome(flags.stackId)) {
      id = yield* validateStackId(flags.stackId.value).pipe(Effect.mapError(mapTargetError));
      const inspection = yield* api.inspectStack(id).pipe(Effect.mapError(mapStackError));
      desiredLifecycle = inspection.descriptor.desiredLifecycle;
    } else {
      const found = yield* api
        .findStack({
          projectRoot: settings.workdir,
          ...(Option.isSome(flags.stack) ? { name: flags.stack.value } : {}),
        })
        .pipe(Effect.mapError(mapStackError));
      if (Option.isNone(found))
        return yield* new StackCommandRestartError({
          reason: "not-found",
          message: Option.isSome(flags.stack)
            ? `No managed stack named "${flags.stack.value}" was found for this project.`
            : "No managed stack exists for the selected project.",
          suggestion: Option.isSome(flags.stack)
            ? "Choose an existing --stack name or omit --stack for the current project."
            : "Run supabase stack start first.",
        });
      id = found.value.id;
      desiredLifecycle = found.value.desiredLifecycle;
    }
    if (desiredLifecycle === "unconfigured")
      return yield* new StackCommandRestartError({
        reason: "lifecycle",
        message: "The selected stack has not been configured yet.",
        suggestion: "Run supabase stack start to configure the stack first.",
      });
    const stack = yield* api.openStack(id).pipe(Effect.mapError(mapStackError));
    const task = yield* output.task("Restarting local Supabase stack...");
    const status = yield* stack.restart().pipe(
      Effect.mapError(mapStackError),
      Effect.tapError((error) => task.fail(error.message)),
      Effect.tap(() => task.clear()),
    );
    if (output.format === "text") yield* output.raw(renderStackStatus(status));
    else yield* output.success("", stackStatusPayload(status));
    return status;
  });
  return yield* body.pipe(Effect.ensuring(telemetryState.flush));
});
