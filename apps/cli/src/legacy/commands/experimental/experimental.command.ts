import { Command } from "effect/unstable/cli";
import { legacyWorkersCommand } from "./workers/workers.command.ts";

/**
 * `supabase experimental` — the parent for command families that are not yet
 * covered by the CLI's compatibility promise. Registered with
 * `Command.unlisted` in `legacy/cli/root.ts`, so the family and everything
 * under it stays out of `--help`, shell completions, the wizard, and the
 * generated docs reference while remaining fully invocable.
 *
 * Graduating a family out of here is a breaking rename of its invocation path,
 * so keep the "experimental" wording in every user-facing string a subtree
 * command prints (suggestions, examples) pointing at the full
 * `supabase experimental <family> ...` path.
 */
export const legacyExperimentalCommand = Command.make("experimental").pipe(
  Command.withDescription(
    "Experimental commands. These are unstable: their flags, output, and invocation path can change or be removed in any release, and they are excluded from the CLI's compatibility promise.",
  ),
  Command.withShortDescription("Experimental, unstable commands"),
  Command.withSubcommands([legacyWorkersCommand]),
);
