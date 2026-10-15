import { Effect } from "effect";
import { Flag } from "effect/cli";

import { compose, withCondition } from "../../command-internal/command-permissions/model.ts";
import { changedLinkedLocalFlags } from "../../command-internal/db-target-flags.ts";
import { storageCredentials } from "../../command-internal/storage-credentials.ts";
import { linkedProjectCache } from "../../telemetry/linked-project-cache.layer.ts";
import { StorageMutuallyExclusiveFlagsError } from "./storage.errors.ts";

/**
 * `--local`'s value decides local vs linked: true clears the project ref, false
 * resolves it via the linked project. Declared per-leaf rather than as a
 * `storage`-scoped global because Effect CLI requires unique global-flag names
 * tree-wide and `seed` already owns `linked`/`local`, so these must follow the
 * subcommand token (`storage ls --local`, not `storage --local ls`).
 */
export const StorageLinkedFlagDef = Flag.Boolean("linked").pipe(
  Flag.withDescription("Connects to Storage API of the linked project."),
  Flag.withDefault(true),
);

export const StorageLocalFlagDef = Flag.Boolean("local").pipe(
  Flag.withDescription("Connects to Storage API of the local database."),
  Flag.withDefault(false),
);

// Overrides the project ref for the linked target; declared once since all four
// storage leaves share the identical flag.
export const StorageProjectRefFlagDef = Flag.String("project-ref").pipe(
  Flag.withDescription("Project ref of the Supabase project."),
  Flag.optional,
);

/** The Management API calls every `storage` subcommand makes on the linked project. */
export const STORAGE_PERMISSIONS = compose(
  { operations: [], noApiEffectFlags: ["linked", "project-ref", "recursive"] },
  withCondition(compose(storageCredentials, linkedProjectCache), { flag: "local", is: false }),
);

/**
 * Mutual-exclusion check for `--linked`/`--local`, rejected before the handler body
 * so it never fires `cli_command_executed`. Each leaf must call this before
 * `withCommandTelemetry`.
 */
export const assertStorageTargetsExclusive = Effect.fnUntraced(function* (
  args: ReadonlyArray<string>,
) {
  const setFlags = changedLinkedLocalFlags(args);
  if (setFlags.length > 1) {
    return yield* new StorageMutuallyExclusiveFlagsError({
      message: `if any flags in the group [linked local] are set none of the others can be; [${setFlags.join(" ")}] were all set`,
    });
  }
});
