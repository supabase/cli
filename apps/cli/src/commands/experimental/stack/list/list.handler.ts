import { Effect, Path } from "effect";
import { CommandSettings } from "../../../../config/command-settings.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { OutputFlag } from "../../../../command-internal/global-flags.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import { StackApi, rejectStackOutput } from "../../../../command-internal/stack-target.ts";
import { renderStackListTable, stackListEntries } from "../stack-list.format.ts";
import { StackCommandListError } from "./list.errors.ts";

export const stackList = Effect.fn("experimental.stack.list")(function* () {
  const telemetry = yield* TelemetryState;
  return yield* Effect.gen(function* () {
    const output = yield* Output;
    const settings = yield* CommandSettings;
    const path = yield* Path.Path;
    const api = yield* StackApi;
    yield* rejectStackOutput(yield* Effect.serviceOption(OutputFlag)).pipe(
      Effect.mapError(
        (cause) =>
          new StackCommandListError({
            reason: cause.reason,
            message: cause.message,
            ...(cause.suggestion === undefined ? {} : { suggestion: cause.suggestion }),
            cause,
          }),
      ),
    );
    const discovered = yield* api
      .discover({
        stateRoot: path.join(settings.supabaseHome, "stacks"),
        onInvalidState: (id, error) =>
          output.raw(`Warning: skipping invalid stack ${id}: ${error.message}\n`, "stderr"),
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new StackCommandListError({
              reason: "invalid-config",
              message: cause.message,
              suggestion:
                "Inspect the stack registry under $SUPABASE_HOME/stacks or ~/.supabase/stacks.",
              cause,
            }),
        ),
      );
    const stacks = stackListEntries(discovered);
    yield* Effect.annotateCurrentSpan({ "stack.count": stacks.length });
    if (output.format === "text") {
      yield* output.raw(
        stacks.length === 0 ? "No managed stacks found.\n" : `${renderStackListTable(stacks)}\n`,
      );
    } else yield* output.success("", { stacks });
    return stacks;
  }).pipe(Effect.ensuring(telemetry.flush));
});
