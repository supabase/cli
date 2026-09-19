import { Effect, Path } from "effect";
import { CommandSettings } from "../../../../config/command-settings.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { OutputFlag } from "../../../../command-internal/global-flags.ts";
import { renderGlamourTable } from "../../../../output/glamour-table.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import { StackApi, rejectStackOutput } from "../stack.shared.ts";
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
      .discover({ stateRoot: path.join(settings.supabaseHome, "stacks") })
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
    const stacks = discovered
      .map(({ definition, host }) => ({
        id: definition.id,
        project_root: definition.identity.projectRoot,
        name: definition.identity.stackName,
        branch_context: definition.identity.branchContext,
        runtime: definition.runtime,
        owner: host === undefined ? "unavailable" : "reachable",
      }))
      .sort((left, right) => {
        for (const field of ["project_root", "name", "id"] as const) {
          if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1;
        }
        return 0;
      });
    if (output.format === "text") {
      yield* output.raw(
        stacks.length === 0
          ? "No managed stacks found.\n"
          : `${renderGlamourTable(
              ["NAME", "PROJECT", "BRANCH", "RUNTIME", "OWNER", "ID"],
              stacks.map((stack) => [
                stack.name,
                stack.project_root,
                stack.branch_context,
                stack.runtime,
                stack.owner,
                stack.id.slice(0, 8),
              ]),
            ).trimEnd()}\n`,
      );
    } else yield* output.success("", { stacks });
    return stacks;
  }).pipe(Effect.ensuring(telemetry.flush));
});
