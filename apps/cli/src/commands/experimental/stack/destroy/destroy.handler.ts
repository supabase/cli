import { Cause, Effect, Exit, Option, Path, Result } from "effect";
import type { StackError } from "@supabase/stack/effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { OutputFlag, resolveYes } from "../../../../command-internal/global-flags.ts";
import { promptYesNo } from "../../../../command-internal/prompt-yes-no.ts";
import { Tty } from "../../../../shared/runtime/tty.service.ts";
import { CommandSettings } from "../../../../config/command-settings.service.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import {
  isStackId,
  StackApi,
  StackTargetError,
  rejectStackOutput,
  skippedRuntimeCleanupWarning,
  StackTargetResolver,
  validateStackTarget,
} from "../stack.shared.ts";
import type { StackDestroyFlags } from "./destroy.command.ts";
import { StackCommandDestroyError } from "./destroy.errors.ts";

const mapTargetError = (error: StackTargetError, detail?: string) =>
  new StackCommandDestroyError({
    reason: error.reason,
    message: error.message,
    ...(detail === undefined ? {} : { detail }),
    ...(error.suggestion === undefined ? {} : { suggestion: error.suggestion }),
    cause: error,
  });

const destroyError = (cause: StackError) =>
  new StackCommandDestroyError({
    reason: "stack",
    message: cause.message,
    cause,
  });

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

    const resolver = yield* StackTargetResolver;
    const path = yield* Path.Path;
    const locations = {
      stateRoot: path.join(settings.supabaseHome, "stacks"),
      cacheRoot: path.join(settings.supabaseHome, "cache", "stack"),
    };
    const lookup =
      Option.isSome(flags.stackId) && isStackId(flags.stackId.value)
        ? yield* Effect.result(api.findDeleted({ ...locations, id: flags.stackId.value }))
        : Result.succeedNone;
    const deleted = Result.getOrElse(lookup, Option.none);
    const target = Option.isSome(deleted)
      ? undefined
      : yield* resolver
          .resolve({
            projectRoot: settings.workdir,
            ...(Option.isSome(flags.stack) ? { name: flags.stack.value } : {}),
            ...(Option.isSome(flags.stackId) ? { id: flags.stackId.value } : {}),
            runtime: "auto",
          })
          .pipe(
            Effect.mapError((error) =>
              mapTargetError(error, Result.isFailure(lookup) ? lookup.failure.message : undefined),
            ),
          );
    const id = Option.isSome(deleted) ? deleted.value.id : target?.id;
    if (id === undefined)
      return yield* new StackCommandDestroyError({
        reason: "flags",
        message: Option.isSome(flags.stack)
          ? `No managed stack named "${flags.stack.value}" was found for this project.`
          : "No managed stack was found for this project.",
        suggestion: "Choose an existing --stack name or --stack-id.",
      });
    const yes = yield* resolveYes;
    const tty = yield* Tty;
    if (!yes && (!tty.stdinIsTty || !output.interactive || output.format !== "text"))
      return yield* new StackCommandDestroyError({
        reason: "confirmation",
        message: "Destroying a stack requires confirmation; rerun with --yes.",
        suggestion: "Pass --yes when running non-interactively or in a machine-readable format.",
      });
    const scope =
      target === undefined
        ? `the containers deleted stack ${id} left behind`
        : `stack ${id} at ${target.projectRoot} and its owned data`;
    const preserved = "Storage upload files will be preserved.";
    if (yes) yield* output.raw(`Permanently destroying ${scope}. ${preserved}\n`, "stderr");
    else {
      const confirmed = yield* promptYesNo(
        output,
        false,
        `Permanently destroy ${scope}? ${preserved}`,
        false,
      );
      if (!confirmed)
        return yield* new StackCommandDestroyError({
          reason: "cancelled",
          message: "Stack destruction was not confirmed.",
        });
    }
    const stack = Option.isSome(deleted)
      ? deleted.value
      : yield* api.open({ ...locations, id }).pipe(Effect.mapError(destroyError));
    const destroying = yield* output.task(`Destroying stack ${id}...`);
    const result = yield* stack.destroy.pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? destroying.clear
          : Cause.hasInterruptsOnly(exit.cause)
            ? destroying.cancel()
            : destroying.fail(Option.getOrUndefined(Exit.findErrorOption(exit))?.message),
      ),
      Effect.mapError(destroyError),
    );
    yield* Effect.annotateCurrentSpan({
      "stack.prompted": !yes,
      "stack.runtime_cleanup": result.runtimeCleanup,
    });
    if (result.runtimeCleanup === "skipped")
      yield* output.warn(skippedRuntimeCleanupWarning(`stack ${id}`, result));
    if (output.format !== "text") yield* output.success("", { destroyed: true, id, ...result });
    else if (result.runtimeCleanup === "complete")
      yield* output.raw(
        target === undefined
          ? `Removed the containers stack ${id} left behind.\n`
          : `Stack ${id} destroyed.\n`,
      );
    else
      yield* output.raw(
        `Stack ${id} was removed locally; its ${result.engine === "docker" ? "Docker" : "Podman"} resources remain until the commands above are run.\n`,
      );
  });
  return yield* body.pipe(Effect.ensuring(telemetryState.flush));
});
