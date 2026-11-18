import { Effect, Option, Path, Result } from "effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { OutputFlag } from "../../../../command-internal/global-flags.ts";
import { CommandSettings } from "../../../../config/command-settings.service.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import {
  isStackId,
  mapTargetError,
  rejectStackOutput,
  selectStack,
  StackApi,
  StackTargetResolver,
  unmatchedStackIdAdvice,
} from "../../../../command-internal/stack-target.ts";
import { destroyScope, destroyStacks, stackLocations } from "../stack-destroy.ts";
import type { StackDestroyFlags } from "./destroy.command.ts";
import { StackCommandDestroyError } from "./destroy.errors.ts";

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
    /* `SUPABASE_STACK` stands in for `--stack`, resolved up front so it picks the stack to destroy. */
    const selector = yield* selectStack(Option.fromNullishOr(flags.stack[0]));

    const resolver = yield* StackTargetResolver;
    const path = yield* Path.Path;
    const locations = stackLocations(path, settings.supabaseHome);
    const select = Effect.fnUntraced(function* (stack: string | undefined) {
      const resolved = yield* Effect.result(
        resolver.resolve({
          projectRoot: settings.workdir,
          ...(stack === undefined ? {} : { stack }),
          ...(selector.fromEnv === true ? { fromEnv: true } : {}),
          runtime: "auto",
        }),
      );
      if (Result.isSuccess(resolved) && resolved.success.id !== undefined)
        return {
          id: resolved.success.id,
          deleted: Option.none(),
          scope: destroyScope(resolved.success.id, resolved.success.projectRoot),
        };
      /* A deleted stack carries no project, so only an explicit full ID no live stack matches
         reaches its leftovers, even when the project root is missing. */
      const lookup =
        stack !== undefined && isStackId(stack) && selector.fromEnv !== true
          ? yield* Effect.result(api.findDeleted({ ...locations, id: stack }))
          : Result.succeedNone;
      const deleted = Result.getOrElse(lookup, Option.none);
      if (Option.isSome(deleted))
        return {
          id: deleted.value.id,
          deleted,
          scope: `the containers deleted stack ${deleted.value.id} left behind`,
        };
      const detail = Result.isFailure(lookup) ? { detail: lookup.failure.message } : {};
      if (Result.isFailure(resolved))
        return yield* mapTargetError(
          (props) => new StackCommandDestroyError({ ...props, ...detail }),
        )(resolved.failure);
      return yield* new StackCommandDestroyError({
        reason: "flags",
        message:
          resolved.success.name === undefined
            ? "No managed stack was found for this project."
            : (unmatchedStackIdAdvice(resolved.success.name)?.message ??
              `No managed stack named "${resolved.success.name}" was found for this project.`),
        ...detail,
        suggestion: "Run `supabase stack list` to see managed stacks and their IDs.",
      });
    });
    /* Every stack resolves before the prompt, so a missing one destroys nothing. */
    const [resolved, unresolved] = yield* Effect.partition(
      flags.stack.length === 0 ? [selector.stack] : flags.stack,
      (stack) => select(stack).pipe(Effect.mapError((error) => ({ stack, error }))),
    );
    const [missing] = unresolved;
    if (missing !== undefined) {
      if (unresolved.length === 1) return yield* missing.error;
      return yield* new StackCommandDestroyError({
        reason: "flags",
        message: `Failed to resolve ${unresolved.length} --stack values.`,
        detail: unresolved
          .map(
            ({ stack, error }) =>
              `${stack}: ${error.message}${error.detail === undefined ? "" : `\n  ${error.detail}`}`,
          )
          .join("\n"),
        suggestion: "Run `supabase stack list` to see managed stacks and their IDs.",
        cause: unresolved,
      });
    }
    const selected = [...new Map(resolved.map((entry) => [entry.id, entry])).values()];
    const batch = flags.stack.length > 1;
    const destroyed = yield* destroyStacks(selected, { batch });
    if (output.format !== "text")
      yield* output.success(
        "",
        batch ? { destroyed: true, stacks: destroyed } : { destroyed: true, id: destroyed[0]?.id },
      );
  });
  return yield* body.pipe(Effect.ensuring(telemetryState.flush));
});
