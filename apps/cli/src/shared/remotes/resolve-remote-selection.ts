import { Effect, Option } from "effect";
import { RemoteFlagConflictError } from "./remotes.errors.ts";

export interface RemoteSelectionInputs {
  /** The parsed `--remote` global flag value. */
  readonly remoteFlag: Option.Option<string>;
  /** Raw `SUPABASE_REMOTE` env value, or `undefined` if unset. */
  readonly remoteEnv: string | undefined;
  /** Whether a competing ref-selecting flag (`--project-ref`, …) was explicitly given, non-empty. */
  readonly conflictingRefFlagExplicit: boolean;
}

/**
 * Resolves precedence between `--remote`, `SUPABASE_REMOTE`, and a competing
 * explicit ref flag, WITHOUT doing the actual name→ref registry lookup.
 * Precedence: `--remote` > `SUPABASE_REMOTE`. A blank/whitespace-only `SUPABASE_REMOTE`
 * is treated as unset. Returns `None` when neither source names a remote.
 */
export function resolveRequestedRemoteName(
  inputs: RemoteSelectionInputs,
): Effect.Effect<Option.Option<string>, RemoteFlagConflictError> {
  const fromFlag =
    Option.isSome(inputs.remoteFlag) && inputs.remoteFlag.value.length > 0
      ? inputs.remoteFlag.value
      : undefined;
  const envTrimmed = inputs.remoteEnv?.trim();
  const fromEnv = envTrimmed !== undefined && envTrimmed.length > 0 ? envTrimmed : undefined;
  const requested = fromFlag ?? fromEnv;

  if (requested === undefined) {
    return Effect.succeed(Option.none());
  }

  if (inputs.conflictingRefFlagExplicit) {
    return Effect.fail(
      new RemoteFlagConflictError({
        message: "--remote cannot be combined with an explicit --project-ref",
      }),
    );
  }

  return Effect.succeed(Option.some(requested));
}
