import { Command } from "effect/unstable/cli";
import { legacyVanitySubdomainsActivateCommand } from "./activate/activate.command.ts";
import { legacyVanitySubdomainsCheckAvailabilityCommand } from "./check-availability/check-availability.command.ts";
import { legacyVanitySubdomainsDeleteCommand } from "./delete/delete.command.ts";
import { legacyVanitySubdomainsGetCommand } from "./get/get.command.ts";

export const legacyVanitySubdomainsCommand = Command.make("vanity-subdomains").pipe(
  Command.withDescription("Manage vanity subdomains for Supabase projects."),
  Command.withShortDescription("Manage vanity subdomains"),
  Command.withSubcommands([
    legacyVanitySubdomainsGetCommand,
    legacyVanitySubdomainsCheckAvailabilityCommand,
    legacyVanitySubdomainsActivateCommand,
    legacyVanitySubdomainsDeleteCommand,
  ]),
);
