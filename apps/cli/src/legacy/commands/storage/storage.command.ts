import { Command } from "effect/unstable/cli";
import { legacyStorageLsCommand } from "./ls/ls.command.ts";
import { legacyStorageCpCommand } from "./cp/cp.command.ts";
import { legacyStorageMvCommand } from "./mv/mv.command.ts";
import { legacyStorageRmCommand } from "./rm/rm.command.ts";

export const legacyStorageCommand = Command.make("storage").pipe(
  Command.withDescription("Manage Supabase Storage objects."),
  Command.withShortDescription("Manage Supabase Storage objects"),
  // `--linked`/`--local` are declared per-leaf (see `storage.flags.ts`), not as
  // group scoped globals, because Effect CLI requires global-flag names to be
  // unique tree-wide and `seed` already owns `linked`/`local`.
  Command.withSubcommands([
    legacyStorageLsCommand,
    legacyStorageCpCommand,
    legacyStorageMvCommand,
    legacyStorageRmCommand,
  ]),
);
