import { Command } from "effect/cli";
import { storageLsCommand } from "./ls/ls.command.ts";
import { storageCpCommand } from "./cp/cp.command.ts";
import { storageMvCommand } from "./mv/mv.command.ts";
import { storageRmCommand } from "./rm/rm.command.ts";

export const storageCommand = Command.make("storage").pipe(
  Command.withDescription(
    "List, copy, move and remove objects in Storage buckets using `ss:///bucket/path` URLs.\n\nThese commands are experimental and require the `--experimental` flag.",
  ),
  Command.withShortDescription("Manage Storage objects"),
  // `--remote` and its aliases are declared per-leaf (see `storage.flags.ts`), not as
  // group scoped globals, because Effect CLI requires global-flag names to be
  // unique tree-wide and `seed` already owns `remote`/`linked`/`local`.
  Command.withSubcommands([storageLsCommand, storageCpCommand, storageMvCommand, storageRmCommand]),
);
