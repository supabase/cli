import { Command } from "effect/cli";
import { genTypesCommand } from "./types/types.command.ts";
import { genSigningKeyCommand } from "./signing-key/signing-key.command.ts";
import { genBearerJwtCommand } from "./bearer-jwt/bearer-jwt.command.ts";
import { genKeysCommand } from "./keys/keys.command.ts";

export const genCommand = Command.make("gen").pipe(
  Command.withDescription(
    "Generate typed definitions from your database schema, JWT signing keys and Bearer tokens.",
  ),
  Command.withShortDescription("Generate types, keys and tokens"),
  Command.withSubcommands([
    genTypesCommand,
    genSigningKeyCommand,
    genBearerJwtCommand,
    genKeysCommand.pipe(Command.unlisted),
  ]),
);
