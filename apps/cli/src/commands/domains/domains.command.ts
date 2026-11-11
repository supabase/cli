import { Command } from "effect/cli";
import { domainsActivateCommand } from "./activate/activate.command.ts";
import { domainsCreateCommand } from "./create/create.command.ts";
import { domainsDeleteCommand } from "./delete/delete.command.ts";
import { domainsGetCommand } from "./get/get.command.ts";
import { domainsReverifyCommand } from "./reverify/reverify.command.ts";

export const domainsCommand = Command.make("domains").pipe(
  Command.withDescription(
    "Serve your project on your own domain name instead of the Supabase-provisioned subdomain. Custom domains and vanity subdomains are mutually exclusive.",
  ),
  Command.withShortDescription("Manage custom domain names for Supabase projects"),
  Command.withSubcommands([
    domainsCreateCommand,
    domainsGetCommand,
    domainsReverifyCommand,
    domainsActivateCommand,
    domainsDeleteCommand,
  ]),
);
