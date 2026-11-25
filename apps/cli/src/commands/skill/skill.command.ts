import { Command } from "effect/cli";

import { withSidebar } from "../../command-internal/command-sidebar.ts";
import { skillDisplayCommand } from "./display/display.command.ts";

export const skillCommand = Command.make("skill").pipe(
  withSidebar({ category: "general", title: "Agent skill guidance" }),
  Command.withDescription("Agent skill guidance for the installed Supabase CLI version."),
  Command.withShortDescription("Agent skill guidance for this CLI"),
  Command.withSubcommands([skillDisplayCommand]),
);
