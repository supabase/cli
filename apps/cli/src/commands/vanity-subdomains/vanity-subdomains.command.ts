import { Command } from "effect/unstable/cli";
import { vanitySubdomainsActivateCommand } from "./activate/activate.command.ts";
import { vanitySubdomainsCheckAvailabilityCommand } from "./check-availability/check-availability.command.ts";
import { vanitySubdomainsDeleteCommand } from "./delete/delete.command.ts";
import { vanitySubdomainsGetCommand } from "./get/get.command.ts";

export const vanitySubdomainsCommand = Command.make("vanity-subdomains").pipe(
  Command.withDescription("Manage vanity subdomains for Supabase projects."),
  Command.withShortDescription("Manage vanity subdomains"),
  Command.withSubcommands([
    vanitySubdomainsGetCommand,
    vanitySubdomainsCheckAvailabilityCommand,
    vanitySubdomainsActivateCommand,
    vanitySubdomainsDeleteCommand,
  ]),
);
