import { Effect, FileSystem, Option, Path } from "effect";
import { CommandSettings } from "../../../../config/command-settings.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { OutputFlag } from "../../../../command-internal/global-flags.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import {
  StackApi,
  mapTargetError,
  rejectStackOutput,
} from "../../../../command-internal/stack-target.ts";
import type { StackCommandDestroyError } from "../destroy/destroy.errors.ts";
import { destroyScope, destroyStacks } from "../stack-destroy.ts";
import { renderStackListTable, stackListEntries } from "../stack-list.format.ts";
import type { StackPruneFlags } from "./prune.command.ts";
import { StackCommandPruneError } from "./prune.errors.ts";

const pruneError = (error: StackCommandDestroyError) =>
  new StackCommandPruneError({
    reason: error.reason,
    message: error.message,
    ...(error.targetIssue === undefined ? {} : { targetIssue: error.targetIssue }),
    ...(error.detail === undefined ? {} : { detail: error.detail }),
    ...(error.suggestion === undefined ? {} : { suggestion: error.suggestion }),
    ...(error.cause === undefined ? {} : { cause: error.cause }),
  });

export const stackPrune = Effect.fn("experimental.stack.prune")(function* (flags: StackPruneFlags) {
  const telemetry = yield* TelemetryState;
  return yield* Effect.gen(function* () {
    const output = yield* Output;
    const settings = yield* CommandSettings;
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const api = yield* StackApi;
    yield* rejectStackOutput(yield* Effect.serviceOption(OutputFlag)).pipe(
      Effect.mapError(mapTargetError((props) => new StackCommandPruneError(props))),
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
            new StackCommandPruneError({
              reason: "invalid-config",
              targetIssue: "stack-discovery",
              message: cause.message,
              suggestion:
                "Inspect the stack registry under $SUPABASE_HOME/stacks or ~/.supabase/stacks.",
              cause,
            }),
        ),
      );
    /* Only a project root reported as not found is orphaned; one that cannot be checked is kept. */
    const orphaned = yield* Effect.filter(discovered, ({ definition }) =>
      fs.exists(definition.identity.projectRoot).pipe(
        Effect.map((exists) => !exists),
        Effect.catchTag("PlatformError", (error) =>
          output
            .raw(
              `Warning: keeping stack ${definition.id}; its project directory could not be checked: ${error.message}\n`,
              "stderr",
            )
            .pipe(Effect.as(false)),
        ),
      ),
    );
    const stacks = stackListEntries(orphaned);
    yield* Effect.annotateCurrentSpan({
      "stack.discovered_count": discovered.length,
      "stack.orphaned_count": stacks.length,
      "stack.dry_run": flags.dryRun,
    });
    if (output.format === "text")
      yield* output.raw(
        stacks.length === 0
          ? "No stacks found whose project directory no longer exists.\n"
          : `Found ${stacks.length} ${stacks.length === 1 ? "stack" : "stacks"} whose project directory no longer exists:\n${renderStackListTable(stacks)}\n`,
      );
    if (flags.dryRun || stacks.length === 0) {
      if (output.format !== "text") yield* output.success("", { dry_run: flags.dryRun, stacks });
      return stacks;
    }
    /* Checked again right before each destroy, so a directory that came back keeps its stack. */
    const recheck = (id: string, projectRoot: string) =>
      fs.exists(projectRoot).pipe(
        Effect.map((exists) =>
          exists
            ? Option.some(`Warning: keeping stack ${id}; its project directory exists again.`)
            : Option.none(),
        ),
        Effect.catchTag("PlatformError", (error) =>
          Effect.succeedSome(
            `Warning: keeping stack ${id}; its project directory could not be checked: ${error.message}`,
          ),
        ),
      );
    /* Always a batch, so a failure names each stack and lists the ones destroyed. */
    const destroyed = yield* destroyStacks(
      stacks.map((stack) => ({
        id: stack.id,
        deleted: Option.none(),
        scope: destroyScope(stack.id, stack.project_root),
        recheck: recheck(stack.id, stack.project_root),
      })),
      {
        batch: true,
        tolerateConcurrentDestroy: true,
      },
    ).pipe(Effect.mapError(pruneError));
    const pruned = stacks.filter((stack) => destroyed.some(({ id }) => id === stack.id));
    if (output.format !== "text") yield* output.success("", { dry_run: false, stacks: pruned });
    return pruned;
  }).pipe(Effect.ensuring(telemetry.flush));
});
