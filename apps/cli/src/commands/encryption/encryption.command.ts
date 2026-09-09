import { Command } from "effect/unstable/cli";
import { encryptionGetRootKeyCommand } from "./get-root-key/get-root-key.command.ts";
import { encryptionUpdateRootKeyCommand } from "./update-root-key/update-root-key.command.ts";

export const encryptionCommand = Command.make("encryption").pipe(
  Command.withDescription("Manage encryption keys of Supabase projects"),
  Command.withShortDescription("Manage encryption keys"),
  Command.withSubcommands([encryptionGetRootKeyCommand, encryptionUpdateRootKeyCommand]),
);
