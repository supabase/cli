import { Effect, Match, Option } from "effect";
import { isStackError, StackIdSchema } from "@supabase/stack/effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { OutputFlag, resolveYes } from "../../../../command-internal/global-flags.ts";
import { promptYesNo } from "../../../../command-internal/prompt-yes-no.ts";
import { Tty } from "../../../../shared/runtime/tty.service.ts";
import { CommandSettings } from "../../../../config/command-settings.service.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import {
  StackApi,
  StackTargetError,
  rejectStackOutput,
  validateStackId,
  validateStackTarget,
} from "../stack.shared.ts";
import type { StackDestroyFlags } from "./destroy.command.ts";
import { StackCommandDestroyError } from "./destroy.errors.ts";

const mapTargetError = (error: StackTargetError) =>
  new StackCommandDestroyError({
    reason: error.reason,
    message: error.message,
    suggestion: error.suggestion,
    cause: error,
  });

const destroyError = (error: unknown): StackCommandDestroyError => {
  const stackError = isStackError(error) ? error : undefined;
  const reason =
    stackError === undefined
      ? "unknown"
      : Match.value(stackError).pipe(
          Match.tag("StackNotFoundError", "InvalidStackIdentityError", () => "flags" as const),
          Match.tag(
            "StackOwnershipConflictError",
            "StackNotRunningError",
            "StackMustBeStoppedError",
            "StackLifecycleConflictError",
            "StackRuntimeError",
            "StackCleanupError",
            "StackDestructionError",
            "StackUpgradeRequiredError",
            () => "lifecycle" as const,
          ),
          Match.tag(
            "InvalidStackConfigError",
            "StackStateFormatUnsupportedError",
            "InvalidProjectRootError",
            "StackStateInvalidError",
            () => "invalid-config" as const,
          ),
          Match.orElse(() => "unknown" as const),
        );
  return new StackCommandDestroyError({
    reason,
    message: stackError?.message ?? String(error),
    cause: error,
  });
};

export const stackDestroy = Effect.fn("experimental.stack.destroy")(function* (
  flags: StackDestroyFlags,
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

    const target = yield* Effect.gen(function* () {
      if (Option.isSome(flags.stackId)) {
        const id = yield* validateStackId(flags.stackId.value).pipe(
          Effect.mapError(mapTargetError),
        );
        return yield* api.inspectStack(id).pipe(
          Effect.map(({ descriptor }) => descriptor),
          Effect.mapError(destroyError),
        );
      }
      const found = yield* api
        .findStack({
          projectRoot: settings.workdir,
          ...(Option.isSome(flags.stack) ? { name: flags.stack.value } : {}),
        })
        .pipe(Effect.mapError(destroyError));
      if (Option.isSome(found)) return found.value;
      return yield* new StackCommandDestroyError({
        reason: "flags",
        message: `No managed stack${Option.isSome(flags.stack) ? ` named "${flags.stack.value}"` : ""} was found for this project.`,
        suggestion: "Choose an existing --stack name or omit --stack for the current project.",
      });
    });
    const yes = yield* resolveYes;
    const tty = yield* Tty;
    if (!yes && (!tty.stdinIsTty || output.format !== "text"))
      return yield* new StackCommandDestroyError({
        reason: "confirmation",
        message: "Destroying a stack requires confirmation; rerun with --yes.",
        suggestion: "Pass --yes when running non-interactively or in a machine-readable format.",
      });
    const confirmed = yield* promptYesNo(
      output,
      yes,
      `Permanently destroy stack "${target.name}" at ${target.projectRoot} (${target.id}) and all of its data?`,
      false,
    );
    if (!confirmed)
      return yield* new StackCommandDestroyError({
        reason: "confirmation",
        message: "Stack destruction was not confirmed.",
      });
    const stack = yield* api
      .openStack(StackIdSchema.make(target.id))
      .pipe(Effect.mapError(destroyError));
    const destroying = yield* output.task(`Destroying stack ${target.id}...`);
    yield* stack.destroy().pipe(
      Effect.tapError((error) => destroying.fail(error.message)),
      Effect.tap(() => destroying.clear()),
      Effect.mapError(destroyError),
    );
    if (output.format === "text") yield* output.raw(`Stack ${target.id} destroyed.\n`);
    else yield* output.success("", { destroyed: true, id: target.id });
  });
  return yield* body.pipe(Effect.ensuring(telemetryState.flush));
});
