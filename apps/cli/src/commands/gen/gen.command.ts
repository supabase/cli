import { Command } from "effect/unstable/cli";
import { genTypesCommand } from "./types/types.command.ts";
import { genSigningKeyCommand } from "./signing-key/signing-key.command.ts";
import { genBearerJwtCommand } from "./bearer-jwt/bearer-jwt.command.ts";
import { genKeysCommand } from "./keys/keys.command.ts";

export const genCommand = Command.make("gen").pipe(
  Command.withDescription("Run code generation tools."),
  Command.withShortDescription("Run code generation tools"),
  Command.withSubcommands([
    genTypesCommand,
    genSigningKeyCommand,
    genBearerJwtCommand,
    genKeysCommand,
  ]),
);
