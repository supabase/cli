import { Command } from "effect/cli";
import { encryptionGetRootKeyCommand } from "./get-root-key/get-root-key.command.ts";
import { encryptionUpdateRootKeyCommand } from "./update-root-key/update-root-key.command.ts";

export const encryptionCommand = Command.make("encryption").pipe(
  Command.withDescription("Get or update the root encryption key of a project."),
  Command.withShortDescription("Manage encryption keys"),
  Command.withSubcommands([encryptionGetRootKeyCommand, encryptionUpdateRootKeyCommand]),
);
