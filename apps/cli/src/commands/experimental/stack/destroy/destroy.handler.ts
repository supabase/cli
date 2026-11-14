import { Effect, Option, Path, Result } from "effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { OutputFlag } from "../../../../command-internal/global-flags.ts";
import { CommandSettings } from "../../../../config/command-settings.service.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import {
  isStackId,
  StackApi,
  rejectStackOutput,
  StackTargetResolver,
  mapTargetError,
  validateStackTarget,
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
    yield* validateStackTarget({
      stack: Option.getOrUndefined(flags.stack),
      stackId: flags.stackId[0],
    }).pipe(Effect.mapError(mapTargetError((props) => new StackCommandDestroyError(props))));

    const resolver = yield* StackTargetResolver;
    const path = yield* Path.Path;
    const locations = stackLocations(path, settings.supabaseHome);
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
        scope: destroyScope(target.id, target.projectRoot),
      };
    });
    /* Every id resolves before the prompt, so a missing one destroys nothing. */
    const [resolved, unresolved] = yield* Effect.partition(
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
    const batch = flags.stackId.length > 1;
    const destroyed = yield* destroyStacks(selected, { batch });
    if (output.format !== "text")
      yield* output.success(
        "",
        batch ? { destroyed: true, stacks: destroyed } : { destroyed: true, id: destroyed[0]?.id },
      );
  });
  return yield* body.pipe(Effect.ensuring(telemetryState.flush));
});
