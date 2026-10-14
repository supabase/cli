import { Command } from "effect/cli";

import { bucketsCommand } from "./buckets/buckets.command.ts";
import { SeedLinkedFlag, SeedLocalFlag } from "./seed.flags.ts";

export const seedCommand = Command.make("seed").pipe(
  Command.withDescription("Seed a Supabase project from supabase/config.toml."),
  Command.withShortDescription("Seed a Supabase project"),
  Command.withSubcommands([bucketsCommand]),
  // Persistent `--linked`/`--local` (Go `seedCmd.PersistentFlags()`), accepted
  // before or after the subcommand. See `seed.flags.ts`. Kept after
  // `withSubcommands` so it discharges the subcommands' flag requirements.
  Command.withGlobalFlags([SeedLinkedFlag, SeedLocalFlag]),
);
