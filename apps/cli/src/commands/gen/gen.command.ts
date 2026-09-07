import { Command } from "effect/unstable/cli";
import { legacyGenTypesCommand } from "./types/types.command.ts";
import { legacyGenSigningKeyCommand } from "./signing-key/signing-key.command.ts";
import { legacyGenBearerJwtCommand } from "./bearer-jwt/bearer-jwt.command.ts";
import { legacyGenKeysCommand } from "./keys/keys.command.ts";

export const legacyGenCommand = Command.make("gen").pipe(
  Command.withDescription("Run code generation tools."),
  Command.withShortDescription("Run code generation tools"),
  Command.withSubcommands([
    legacyGenTypesCommand,
    legacyGenSigningKeyCommand,
    legacyGenBearerJwtCommand,
    legacyGenKeysCommand,
  ]),
);
