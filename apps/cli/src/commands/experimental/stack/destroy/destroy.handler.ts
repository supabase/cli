import { Cause, Effect, Exit, Option, Path } from "effect";
import type { StackError } from "@supabase/stack/effect";
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
  StackTargetResolver,
  validateStackTarget,
} from "../stack.shared.ts";
import type { StackDestroyFlags } from "./destroy.command.ts";
import { StackCommandDestroyError } from "./destroy.errors.ts";

const mapTargetError = (error: StackTargetError) =>
  new StackCommandDestroyError({
    reason: error.reason,
    message: error.message,
    ...(error.suggestion === undefined ? {} : { suggestion: error.suggestion }),
    cause: error,
  });

const destroyError = (cause: StackError) =>
  new StackCommandDestroyError({
    reason: "unknown",
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
    const target = yield* resolver
      .resolve({
        projectRoot: settings.workdir,
        ...(Option.isSome(flags.stack) ? { name: flags.stack.value } : {}),
        ...(Option.isSome(flags.stackId) ? { id: flags.stackId.value } : {}),
        runtime: "auto",
      })
      .pipe(Effect.mapError(mapTargetError));
    if (target.id === undefined)
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
    const confirmed = yield* promptYesNo(
      output,
      yes,
      `Permanently destroy stack ${target.id} at ${target.projectRoot} and its owned data? Storage upload files will be preserved.`,
      false,
    );
    if (!confirmed)
      return yield* new StackCommandDestroyError({
        reason: "cancelled",
        message: "Stack destruction was not confirmed.",
      });
    const stack = yield* api
      .open({
        id: target.id,
        stateRoot: path.join(settings.supabaseHome, "stacks"),
        cacheRoot: path.join(settings.supabaseHome, "cache", "stack"),
      })
      .pipe(Effect.mapError(destroyError));
    const destroying = yield* output.task(`Destroying stack ${target.id}...`);
    yield* stack.destroy.pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? destroying.clear()
          : Cause.hasInterruptsOnly(exit.cause)
            ? destroying.cancel()
            : destroying.fail(Option.getOrUndefined(Exit.findErrorOption(exit))?.message),
      ),
      Effect.mapError(destroyError),
    );
    if (output.format === "text") yield* output.raw(`Stack ${target.id} destroyed.\n`);
    else yield* output.success("", { destroyed: true, id: target.id });
  });
  return yield* body.pipe(Effect.ensuring(telemetryState.flush));
});
