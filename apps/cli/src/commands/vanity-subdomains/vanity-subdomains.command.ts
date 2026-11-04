import { Command } from "effect/cli";
import { vanitySubdomainsActivateCommand } from "./activate/activate.command.ts";
import { vanitySubdomainsCheckAvailabilityCommand } from "./check-availability/check-availability.command.ts";
import { vanitySubdomainsDeleteCommand } from "./delete/delete.command.ts";
import { vanitySubdomainsGetCommand } from "./get/get.command.ts";

export const vanitySubdomainsCommand = Command.make("vanity-subdomains").pipe(
  Command.withDescription("Give your project a branded hostname under the Supabase domain instead of the project ref. Vanity subdomains and custom domains are mutually exclusive."),
  Command.withShortDescription("Manage vanity subdomains"),
  Command.withSubcommands([
    vanitySubdomainsGetCommand,
    vanitySubdomainsCheckAvailabilityCommand,
    vanitySubdomainsActivateCommand,
    vanitySubdomainsDeleteCommand,
  ]),
);
