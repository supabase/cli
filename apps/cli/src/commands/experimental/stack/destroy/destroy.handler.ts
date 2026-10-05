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
  type StackTarget,
  StackTargetError,
  rejectStackOutput,
  skippedRuntimeCleanupWarning,
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

export interface StackDestroyInput {
  readonly stack?: Option.Option<string> | string;
  readonly stackId?: ReadonlyArray<string> | Option.Option<string> | string;
}

export const stackDestroy = Effect.fn("experimental.stack.destroy")(function* (
  flags: StackDestroyFlags | StackDestroyInput,
) {
  const telemetryState = yield* TelemetryState;
  const body = Effect.gen(function* () {
    const output = yield* Output;
    const settings = yield* CommandSettings;
    const api = yield* StackApi;
    const outputFlag = yield* Effect.serviceOption(OutputFlag);
    yield* rejectStackOutput(outputFlag).pipe(Effect.mapError(mapTargetError));

    const stackOption =
      flags.stack !== undefined && Option.isOption(flags.stack)
        ? flags.stack
        : typeof flags.stack === "string"
          ? Option.some(flags.stack)
          : Option.none<string>();

    const rawStackId = flags.stackId;
    const stackIds: ReadonlyArray<string> =
      rawStackId === undefined
        ? []
        : Array.isArray(rawStackId)
          ? rawStackId
          : typeof rawStackId === "string"
            ? [rawStackId]
            : Option.isOption(rawStackId) && Option.isSome(rawStackId)
              ? [rawStackId.value]
              : [];

    yield* validateStackTarget({
      stack: Option.getOrUndefined(stackOption),
      stackId: stackIds,
    }).pipe(Effect.mapError(mapTargetError));

    const resolver = yield* StackTargetResolver;
    const path = yield* Path.Path;

    const targets: StackTarget[] = [];
    if (stackIds.length > 0) {
      for (const id of stackIds) {
        const target = yield* resolver
          .resolve({
            projectRoot: settings.workdir,
            id,
            runtime: "auto",
          })
          .pipe(Effect.mapError(mapTargetError));
        targets.push(target);
      }
    } else {
      const target = yield* resolver
        .resolve({
          projectRoot: settings.workdir,
          ...(Option.isSome(stackOption) ? { name: stackOption.value } : {}),
          runtime: "auto",
        })
        .pipe(Effect.mapError(mapTargetError));
      if (target.id === undefined)
        return yield* new StackCommandDestroyError({
          reason: "flags",
          message: Option.isSome(stackOption)
            ? `No managed stack named "${stackOption.value}" was found for this project.`
            : "No managed stack was found for this project.",
          suggestion: "Choose an existing --stack name or --stack-id.",
        });
      targets.push(target);
    }

    const seen = new Set<string>();
    const uniqueTargets: StackTarget[] = [];
    for (const target of targets) {
      if (target.id !== undefined && !seen.has(target.id)) {
        seen.add(target.id);
        uniqueTargets.push(target);
      }
    }

    const yes = yield* resolveYes;
    const tty = yield* Tty;
    if (!yes && (!tty.stdinIsTty || !output.interactive || output.format !== "text"))
      return yield* new StackCommandDestroyError({
        reason: "confirmation",
        message: "Destroying a stack requires confirmation; rerun with --yes.",
        suggestion: "Pass --yes when running non-interactively or in a machine-readable format.",
      });

    const preserved = "Storage upload files will be preserved.";
    const scope =
      uniqueTargets.length === 1
        ? `stack ${uniqueTargets[0]!.id} at ${uniqueTargets[0]!.projectRoot} and its owned data`
        : `stacks ${uniqueTargets.map((t) => t.id).join(", ")} and their owned data`;

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

    const successes: Array<{
      readonly id: string;
      readonly result: {
        readonly runtimeCleanup: "complete" | "partial" | "skipped";
        readonly engine?: "docker" | "podman";
        readonly remainingCommands?: ReadonlyArray<string>;
      };
    }> = [];
    const failures: Array<{
      readonly id: string;
      readonly error: StackCommandDestroyError;
    }> = [];

    for (const target of uniqueTargets) {
      const targetId = target.id!;
      const destroySingle = Effect.gen(function* () {
        const stack = yield* api
          .open({
            id: targetId,
            stateRoot: path.join(settings.supabaseHome, "stacks"),
            cacheRoot: path.join(settings.supabaseHome, "cache", "stack"),
          })
          .pipe(Effect.mapError(destroyError));
        const destroying = yield* output.task(`Destroying stack ${targetId}...`);
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
        return result;
      });

      const exit = yield* Effect.exit(destroySingle);
      if (Exit.isSuccess(exit)) {
        const result = exit.value;
        successes.push({ id: targetId, result });
        if (result.runtimeCleanup === "skipped")
          yield* output.warn(skippedRuntimeCleanupWarning(`stack ${targetId}`, result));
        if (output.format === "text") {
          if (result.runtimeCleanup === "complete")
            yield* output.raw(`Stack ${targetId} destroyed.\n`);
          else
            yield* output.raw(
              `Stack ${targetId} was removed locally; its ${result.engine === "docker" ? "Docker" : "Podman"} resources remain until the commands above are run.\n`,
            );
        }
      } else {
        const error = Option.getOrElse(
          Exit.findErrorOption(exit),
          () =>
            new StackCommandDestroyError({
              reason: "unknown",
              message: `Failed to destroy stack ${targetId}`,
            }),
        );
        failures.push({ id: targetId, error });
        yield* output.error(`Failed to destroy stack ${targetId}: ${error.message}`);
      }
    }

    if (uniqueTargets.length === 1 && successes.length === 1) {
      yield* Effect.annotateCurrentSpan({
        "stack.prompted": !yes,
        "stack.runtime_cleanup": successes[0]!.result.runtimeCleanup,
      });
    } else {
      yield* Effect.annotateCurrentSpan({
        "stack.prompted": !yes,
        "stack.count": uniqueTargets.length,
        "stack.destroyed_count": successes.length,
        "stack.failed_count": failures.length,
      });
    }

    if (output.format !== "text") {
      if (uniqueTargets.length === 1 && successes.length === 1) {
        yield* output.success("", {
          destroyed: true,
          id: successes[0]!.id,
          ...successes[0]!.result,
        });
      } else {
        yield* output.success("", {
          destroyed: failures.length === 0,
          stacks: successes.map(({ id, result }) => ({ id, ...result })),
          failures: failures.map(({ id, error }) => ({ id, message: error.message })),
        });
      }
    }

    if (failures.length > 0) {
      if (failures.length === 1 && uniqueTargets.length === 1) {
        return yield* failures[0]!.error;
      }
      return yield* new StackCommandDestroyError({
        reason: "unknown",
        message: `Failed to destroy ${failures.length} managed stack(s).`,
        detail: failures.map(({ id, error }) => `${id}: ${error.message}`).join("\n"),
        cause: failures,
      });
    }
  });
  return yield* body.pipe(Effect.ensuring(telemetryState.flush));
});
