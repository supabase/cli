import { Command } from "effect/unstable/cli";
import { legacyEncryptionGetRootKeyCommand } from "./get-root-key/get-root-key.command.ts";
import { legacyEncryptionUpdateRootKeyCommand } from "./update-root-key/update-root-key.command.ts";

export const legacyEncryptionCommand = Command.make("encryption").pipe(
  Command.withDescription("Manage encryption keys of Supabase projects."),
  Command.withShortDescription("Manage encryption keys"),
  Command.withSubcommands([
    legacyEncryptionGetRootKeyCommand,
    legacyEncryptionUpdateRootKeyCommand,
  ]),
);
