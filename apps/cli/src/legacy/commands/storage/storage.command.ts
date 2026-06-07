import { Command } from "effect/unstable/cli";
import { legacyStorageLsCommand } from "./ls/ls.command.ts";
import { legacyStorageCpCommand } from "./cp/cp.command.ts";
import { legacyStorageMvCommand } from "./mv/mv.command.ts";
import { legacyStorageRmCommand } from "./rm/rm.command.ts";

export const legacyStorageCommand = Command.make("storage").pipe(
  Command.withDescription("Manage Supabase Storage objects."),
  Command.withShortDescription("Manage Supabase Storage objects"),
  Command.withSubcommands([
    legacyStorageLsCommand,
    legacyStorageCpCommand,
    legacyStorageMvCommand,
    legacyStorageRmCommand,
  ]),
);
