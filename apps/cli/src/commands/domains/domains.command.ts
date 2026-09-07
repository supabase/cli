import { Command } from "effect/unstable/cli";
import { legacyDomainsActivateCommand } from "./activate/activate.command.ts";
import { legacyDomainsCreateCommand } from "./create/create.command.ts";
import { legacyDomainsDeleteCommand } from "./delete/delete.command.ts";
import { legacyDomainsGetCommand } from "./get/get.command.ts";
import { legacyDomainsReverifyCommand } from "./reverify/reverify.command.ts";

export const legacyDomainsCommand = Command.make("domains").pipe(
  Command.withDescription(
    "Manage custom domain names for Supabase projects. Use of custom domains and vanity subdomains is mutually exclusive.",
  ),
  Command.withShortDescription("Manage custom domain names for Supabase projects"),
  Command.withSubcommands([
    legacyDomainsCreateCommand,
    legacyDomainsGetCommand,
    legacyDomainsReverifyCommand,
    legacyDomainsActivateCommand,
    legacyDomainsDeleteCommand,
  ]),
);
