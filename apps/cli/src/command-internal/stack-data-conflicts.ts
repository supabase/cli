import { findDataConflicts } from "@supabase/stack/effect";
import type { ArtifactSelection } from "@supabase/stack/internal/artifacts";
import { Cause, Effect, Path } from "effect";

import { CommandSettings } from "../config/command-settings.service.ts";
import type { Output } from "../shared/output/output.service.ts";

/**
 * Warns once per data conflict a start at `selection` would meet in the project's saved stacks, and
 * returns how many it found; state that cannot be read warns of nothing and is only logged.
 */
export const warnDataConflicts = Effect.fn("StackLock.dataConflicts")(
  function* (options: {
    readonly projectRoot: string;
    readonly selection: ArtifactSelection;
    readonly output: Output["Service"];
  }) {
    const path = yield* Path.Path;
    const { supabaseHome } = yield* CommandSettings;
    const conflicts = yield* findDataConflicts({
      stateRoot: path.join(supabaseHome, "stacks"),
      projectRoot: options.projectRoot,
      requested: options.selection,
    });
    yield* Effect.annotateCurrentSpan({ "stack.data_conflicts.count": conflicts.length });
    yield* Effect.forEach(
      conflicts,
      (conflict) =>
        options.output.warn(
          `stack ${conflict.stackId}: the next supabase start refuses these pins: ${conflict.message}`,
        ),
      { discard: true },
    );
    return conflicts.length;
  },
  Effect.catchCause((cause) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.interrupt
      : Effect.logDebug(`stack data conflict check skipped: ${Cause.pretty(cause)}`).pipe(
          Effect.as(0),
        ),
  ),
);
