import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyGenSigningKey } from "./signing-key.handler.ts";

const ALGORITHM_VALUES = ["ES256", "RS256"] as const;

const config = {
  algorithm: Flag.choice("algorithm", ALGORITHM_VALUES).pipe(
    Flag.withDescription("Algorithm for signing key generation."),
    Flag.optional,
  ),
  append: Flag.boolean("append").pipe(
    Flag.withDescription("Append new key to existing keys file instead of overwriting."),
  ),
} as const;

export type LegacyGenSigningKeyFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyGenSigningKeyCommand = Command.make("signing-key", config).pipe(
  Command.withDescription("Generate a JWT signing key."),
  Command.withShortDescription("Generate a JWT signing key"),
  Command.withHandler((flags) => legacyGenSigningKey(flags)),
);
