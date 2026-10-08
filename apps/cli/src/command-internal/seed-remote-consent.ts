import { Effect } from "effect";

import { Output } from "../shared/output/output.service.ts";
import { Tty } from "../shared/runtime/tty.service.ts";
import { promptYesNo } from "./prompt-yes-no.ts";

export const SEED_CONSENT_SUGGESTION =
  "Pass --yes (or set SUPABASE_YES) to seed a project that matched a [remotes.*] block.";

/**
 * Asks before seeding a database whose target matched a `[remotes.*]` block, defaulting to no.
 * Unattended runs without `--yes` decline rather than proceed.
 */
export const confirmSeedIntoMatchedRemote = Effect.fnUntraced(function* (
  yes: boolean,
  remote: string,
) {
  const output = yield* Output;
  const tty = yield* Tty;
  if (!yes && tty.stdinIsTty && !output.interactive) return false;
  return yield* promptYesNo(
    output,
    yes,
    `The target matched [remotes.${remote}]. Seed data into this database?`,
    false,
    true,
    { readMachineStdin: true },
  );
});
