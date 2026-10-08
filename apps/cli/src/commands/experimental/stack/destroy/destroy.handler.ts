import { Cause, Effect, Exit, Option, Path, Result } from "effect";
import type { StackError } from "@supabase/stack/effect";
import { MachineErrorContext } from "../../../../shared/output/machine-error-context.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { OutputFlag, resolveYes } from "../../../../command-internal/global-flags.ts";
import { promptYesNo } from "../../../../command-internal/prompt-yes-no.ts";
import { Tty } from "../../../../shared/runtime/tty.service.ts";
import { CommandSettings } from "../../../../config/command-settings.service.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import {
  isStackId,
  StackApi,
  rejectStackOutput,
  StackTargetResolver,
  mapTargetError,
  validateStackTarget,
} from "../stack.shared.ts";
import type { StackDestroyFlags } from "./destroy.command.ts";
import { StackCommandDestroyError } from "./destroy.errors.ts";

const destroyError = (id: string) => (cause: StackError) =>
  cause.reason === "runtime-unavailable"
    ? new StackCommandDestroyError({
        reason: "runtime",
        message: cause.message,
        suggestion: `Start the container engine, then run "supabase stack destroy --stack-id ${id} --yes" again; nothing was removed.`,
        cause,
      })
    : new StackCommandDestroyError({
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
    yield* rejectStackOutput(outputFlag).pipe(
      Effect.mapError(mapTargetError((props) => new StackCommandDestroyError(props))),
    );
    yield* validateStackTarget({
      stack: Option.getOrUndefined(flags.stack),
      stackId: flags.stackId[0],
    }).pipe(Effect.mapError(mapTargetError((props) => new StackCommandDestroyError(props))));

    const resolver = yield* StackTargetResolver;
    const path = yield* Path.Path;
    const locations = {
      stateRoot: path.join(settings.supabaseHome, "stacks"),
      cacheRoot: path.join(settings.supabaseHome, "cache", "stack"),
    };
    const select = Effect.fnUntraced(function* (stackId: string | undefined) {
      const lookup =
        stackId !== undefined && isStackId(stackId)
          ? yield* Effect.result(api.findDeleted({ ...locations, id: stackId }))
          : Result.succeedNone;
      const deleted = Result.getOrElse(lookup, Option.none);
      if (Option.isSome(deleted))
        return {
          id: deleted.value.id,
          deleted,
          scope: `the containers deleted stack ${deleted.value.id} left behind`,
        };
      const detail = Result.isFailure(lookup) ? lookup.failure.message : undefined;
      const target = yield* resolver
        .resolve({
          projectRoot: settings.workdir,
          ...(Option.isSome(flags.stack) ? { name: flags.stack.value } : {}),
          ...(stackId === undefined ? {} : { id: stackId }),
          runtime: "auto",
        })
        .pipe(
          Effect.mapError(
            mapTargetError(
              (props) =>
                new StackCommandDestroyError({
                  ...props,
                  ...(detail === undefined ? {} : { detail }),
                }),
            ),
          ),
        );
      if (target.id === undefined)
        return yield* new StackCommandDestroyError({
          reason: "flags",
          message: Option.isSome(flags.stack)
            ? `No managed stack named "${flags.stack.value}" was found for this project.`
            : "No managed stack was found for this project.",
          suggestion: "Choose an existing --stack name or --stack-id.",
        });
      return {
        id: target.id,
        deleted,
        scope: `stack ${target.id} at ${target.projectRoot} and its owned data`,
      };
    });
    /* Every id resolves before the prompt, so a missing one destroys nothing. */
    const [unresolved, resolved] = yield* Effect.partition(
      flags.stackId.length === 0 ? [undefined] : flags.stackId,
      (stackId) => select(stackId).pipe(Effect.mapError((error) => ({ stackId, error }))),
    );
    const [missing] = unresolved;
    if (missing !== undefined) {
      if (unresolved.length === 1) return yield* missing.error;
      return yield* new StackCommandDestroyError({
        reason: "flags",
        message: `Failed to resolve ${unresolved.length} --stack-id values.`,
        detail: unresolved
          .map(
            ({ stackId, error }) =>
              `${stackId}: ${error.message}${error.detail === undefined ? "" : `\n  ${error.detail}`}`,
          )
          .join("\n"),
        suggestion: "Run `supabase stack list` to see managed stacks and their IDs.",
        cause: unresolved,
      });
    }
    const selected = [...new Map(resolved.map((entry) => [entry.id, entry])).values()];
    const yes = yield* resolveYes;
    const tty = yield* Tty;
    if (!yes && (!tty.stdinIsTty || !output.interactive || output.format !== "text"))
      return yield* new StackCommandDestroyError({
        reason: "confirmation",
        message: "Destroying a stack requires confirmation; rerun with --yes.",
        suggestion: "Pass --yes when running non-interactively or in a machine-readable format.",
      });
    const scope = selected.map((entry) => entry.scope).join("; ");
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
    const batch = flags.stackId.length > 1;
    const [failed, destroyed] = yield* Effect.partition(selected, ({ id, deleted }) =>
      Effect.gen(function* () {
        const stack = Option.isSome(deleted)
          ? deleted.value
          : yield* api.open({ ...locations, id }).pipe(Effect.mapError(destroyError(id)));
        const destroying = yield* output.task(`Destroying stack ${id}...`);
        yield* stack.destroy.pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit)
              ? destroying.clear
              : Cause.hasInterruptsOnly(exit.cause)
                ? destroying.cancel()
                : destroying.fail(Option.getOrUndefined(Exit.findErrorOption(exit))?.message),
          ),
          Effect.mapError(destroyError(id)),
        );
        if (!batch) yield* Effect.annotateCurrentSpan({ "stack.prompted": !yes });
        if (output.format === "text")
          yield* output.raw(
            Option.isSome(deleted)
              ? `Removed the containers stack ${id} left behind.\n`
              : `Stack ${id} destroyed.\n`,
          );
        else if (!batch) yield* output.success("", { destroyed: true, id });
        return { id };
      }).pipe(
        Effect.scoped,
        Effect.mapError((error) => ({ id, error })),
      ),
    );
    if (batch)
      yield* Effect.annotateCurrentSpan({
        "stack.prompted": !yes,
        "stack.count": selected.length,
        "stack.destroyed_count": destroyed.length,
      });
    const [failure] = failed;
    if (failure !== undefined) {
      if (!batch) return yield* failure.error;
      const machineErrorContext = yield* Effect.serviceOption(MachineErrorContext);
      if (Option.isSome(machineErrorContext))
        yield* machineErrorContext.value.set({ destroyed_stacks: destroyed });
      const retry = `"supabase stack destroy ${failed.map(({ id }) => `--stack-id ${id}`).join(" ")} --yes"`;
      const runtime = failed.every(({ error }) => error.reason === "runtime");
      return yield* new StackCommandDestroyError({
        reason: runtime ? "runtime" : "unknown",
        message: `Failed to destroy ${failed.length} managed stack(s).`,
        detail: failed.map(({ id, error }) => `${id}: ${error.message}`).join("\n"),
        suggestion: runtime
          ? `Start the container engine, then run ${retry} again; nothing was removed for those stacks.`
          : `Resolve each error, then run ${retry} to retry the stacks that failed.`,
        cause: failed,
      });
    }
    if (batch && output.format !== "text")
      yield* output.success("", { destroyed: true, stacks: destroyed });
  });
  return yield* body.pipe(Effect.ensuring(telemetryState.flush));
});
