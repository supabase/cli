import { Effect, FileSystem, Option, Path } from "effect";
import { resolveStackIdentity } from "@supabase/stack/effect";
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
import { destroyScope, destroyStacks, stackLocations } from "../stack-destroy.ts";
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
        stateRoot: stackLocations(path, settings.supabaseHome).stateRoot,
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
    /*
     * Orphaned: the project root is gone, or a root outside any Git repository became its own
     * repository, so it resolves to another stack. A repository that only encloses it never counts.
     */
    const isOrphaned = (projectRoot: string, branchContext: string) =>
      Effect.gen(function* () {
        if (!(yield* fs.exists(projectRoot))) return true;
        if (branchContext !== "ordinary-workspace") return false;
        const git = path.join(projectRoot, ".git");
        if (!(yield* fs.exists(git))) return false;
        const { type } = yield* fs.stat(git);
        if (type === "Directory" ? !(yield* fs.exists(path.join(git, "HEAD"))) : type !== "File")
          return false;
        const identity = yield* resolveStackIdentity({ projectRoot }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
        return identity.branchContext !== "ordinary-workspace";
      });
    const unchecked = (id: string, error: { readonly message: string }) =>
      `Warning: keeping stack ${id}; it could not be checked: ${error.message}`;
    const orphaned = yield* Effect.filter(discovered, ({ definition: { id, identity } }) =>
      isOrphaned(identity.projectRoot, identity.branchContext).pipe(
        Effect.catch((error) =>
          output.raw(`${unchecked(id, error)}\n`, "stderr").pipe(Effect.as(false)),
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
          ? "No orphaned stacks found.\n"
          : `Found ${stacks.length} orphaned ${stacks.length === 1 ? "stack" : "stacks"}:\n${renderStackListTable(stacks)}\n`,
      );
    if (flags.dryRun || stacks.length === 0) {
      if (output.format !== "text") yield* output.success("", { dry_run: flags.dryRun, stacks });
      return stacks;
    }
    /* Checked again right before each destroy, so a stack no longer orphaned is kept. */
    const recheck = (id: string, projectRoot: string, branchContext: string) =>
      isOrphaned(projectRoot, branchContext).pipe(
        Effect.map((orphan) =>
          orphan
            ? Option.none()
            : Option.some(`Warning: keeping stack ${id}; it is no longer orphaned.`),
        ),
        Effect.catch((error) => Effect.succeedSome(unchecked(id, error))),
      );
    /* Always a batch, so a failure names each stack and lists the ones destroyed. */
    const destroyed = yield* destroyStacks(
      stacks.map((stack) => ({
        id: stack.id,
        deleted: Option.none(),
        scope: destroyScope(stack.id, stack.project_root),
        recheck: recheck(stack.id, stack.project_root, stack.branch_context),
      })),
      {
        batch: true,
        question:
          stacks.length === 1
            ? "Permanently destroy the stack listed above and its owned data?"
            : `Permanently destroy the ${stacks.length} stacks listed above and their owned data?`,
        tolerateConcurrentDestroy: true,
        /* Pruning again rechecks each stack, which destroying by id would skip. */
        retry: "supabase stack prune --yes",
      },
    ).pipe(Effect.mapError(pruneError));
    const pruned = stacks.filter((stack) => destroyed.some(({ id }) => id === stack.id));
    if (output.format !== "text") yield* output.success("", { dry_run: false, stacks: pruned });
    return pruned;
  }).pipe(Effect.ensuring(telemetry.flush));
});
