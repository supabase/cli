import { Command } from "effect/cli";
import { storageLsCommand } from "./ls/ls.command.ts";
import { storageCpCommand } from "./cp/cp.command.ts";
import { storageMvCommand } from "./mv/mv.command.ts";
import { storageRmCommand } from "./rm/rm.command.ts";
import { STACK_SELECTOR_FLAGS } from "../../command-internal/stack-target.ts";

export const storageCommand = Command.make("storage").pipe(
  Command.withDescription("Manage Supabase Storage objects."),
  Command.withShortDescription("Manage Supabase Storage objects"),
  // `--remote` and its aliases are declared per-leaf (see `storage.flags.ts`), not as
  // group scoped globals, because Effect CLI requires global-flag names to be
  // unique tree-wide and `seed` already owns `remote`/`linked`/`local`.
  Command.withSubcommands([storageLsCommand, storageCpCommand, storageMvCommand, storageRmCommand]),
  Command.withGlobalFlags(STACK_SELECTOR_FLAGS),
);
