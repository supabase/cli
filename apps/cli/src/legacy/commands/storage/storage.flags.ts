import { Effect } from "effect";
import { Flag } from "effect/unstable/cli";

import { legacyChangedLinkedLocalFlags } from "../../shared/legacy-db-target-flags.ts";
import { LegacyStorageMutuallyExclusiveFlagsError } from "./storage.errors.ts";

/**
 * `--linked` / `--local` mirror Go's `storageCmd.PersistentFlags()`
 * (`apps/cli-go/cmd/storage.go:96-99`): `--linked` defaults to `true`, `--local`
 * to `false`, and the two are mutually exclusive. The routing reads the **value**
 * of `--local` (Go's `GetBool("local")`, `storage.go:21-32`): when true the
 * project ref is cleared (local stack), otherwise the linked path resolves it.
 *
 * These are declared **per-leaf** rather than as `storage`-group scoped globals
 * because Effect CLI requires global-flag names to be unique across the whole
 * command tree (`Command.runWith` builds one registry from every declared
 * global), and `seed` already owns scoped globals named `linked`/`local` with
 * different defaults/descriptions. The only behavioural cost vs Go's persistent
 * flags is that `--linked`/`--local` must follow the subcommand token
 * (`storage ls --local`, not `storage --local ls`) — the same shape the `db`
 * family uses for its per-leaf `--linked`/`--local`.
 */
export const LegacyStorageLinkedFlagDef = Flag.boolean("linked").pipe(
  Flag.withDescription("Connects to Storage API of the linked project."),
  Flag.withDefault(true),
);

export const LegacyStorageLocalFlagDef = Flag.boolean("local").pipe(
  Flag.withDescription("Connects to Storage API of the local database."),
);

/** Changed `--linked`/`--local` set (cobra `pflag.Changed`), for the exclusivity check. */
export function legacyStorageChangedTargetFlags(
  args: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return legacyChangedLinkedLocalFlags(args);
}

/**
 * Reproduce cobra's `MarkFlagsMutuallyExclusive("linked", "local")`
 * (`apps/cli-go/cmd/storage.go:99`). Go rejects this at flag validation — before
 * `RunE`/`PersistentPostRun` — so it must NOT emit `cli_command_executed`; each
 * leaf calls this BEFORE `withLegacyCommandInstrumentation`.
 */
export const legacyAssertStorageTargetsExclusive = Effect.fnUntraced(function* (
  args: ReadonlyArray<string>,
) {
  const setFlags = legacyStorageChangedTargetFlags(args);
  if (setFlags.length > 1) {
    return yield* new LegacyStorageMutuallyExclusiveFlagsError({
      message: `if any flags in the group [linked local] are set none of the others can be; [${setFlags.join(" ")}] were all set`,
    });
  }
});
