import { Command } from "effect/unstable/cli";

import { legacyBucketsCommand } from "./buckets/buckets.command.ts";
import { LegacySeedLinkedFlag, LegacySeedLocalFlag } from "./seed.flags.ts";

export const legacySeedCommand = Command.make("seed").pipe(
  Command.withDescription("Seed a Supabase project from supabase/config.toml."),
  Command.withShortDescription("Seed a Supabase project"),
  // Persistent `--linked`/`--local` (Go `seedCmd.PersistentFlags()`), accepted
  // before or after the subcommand. See `seed.flags.ts`.
  Command.withGlobalFlags([LegacySeedLinkedFlag, LegacySeedLocalFlag]),
  Command.withSubcommands([legacyBucketsCommand]),
);
