import { withSidebar } from "../../command-internal/command-sidebar.ts";
import { Command } from "effect/cli";

import { seedTargetGlobalFlags } from "../../command-internal/target/target-flags.ts";
import { STACK_SELECTOR_FLAGS } from "../../command-internal/stack-target.ts";
import { bucketsCommand } from "./buckets/buckets.command.ts";

export const seedCommand = Command.make("seed").pipe(
  withSidebar({ category: "seed" }),
  Command.withDescription("Seed a Supabase project from its config file."),
  Command.withShortDescription("Seed a Supabase project"),
  Command.withSubcommands([bucketsCommand]),
  // The selector flags are persistent, accepted before or after the subcommand. Kept after
  // `withSubcommands` so it discharges the subcommands' flag requirements.
  Command.withGlobalFlags([
    seedTargetGlobalFlags.remote,
    seedTargetGlobalFlags.linked,
    seedTargetGlobalFlags.local,
    seedTargetGlobalFlags.projectRef,
    ...STACK_SELECTOR_FLAGS,
  ]),
);
