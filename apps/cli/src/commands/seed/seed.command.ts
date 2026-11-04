import { Command } from "effect/cli";

import { withGlobalParams } from "../../shared/cli/cli-params.ts";
import { seedTargetGlobalFlags } from "../../command-internal/target/target-flags.ts";
import { bucketsCommand } from "./buckets/buckets.command.ts";

export const seedCommand = Command.make("seed").pipe(
  Command.withDescription(
    "Populate a local or hosted project with the data described in supabase/config.toml.",
  ),
  Command.withShortDescription("Seed a project from config.toml"),
  Command.withSubcommands([bucketsCommand]),
  // The selector flags are persistent, accepted before or after the subcommand. Kept after
  // `withSubcommands` so it discharges the subcommands' flag requirements.
  withGlobalParams([
    seedTargetGlobalFlags.remote,
    seedTargetGlobalFlags.linked,
    seedTargetGlobalFlags.local,
    seedTargetGlobalFlags.projectRef,
  ]),
);
