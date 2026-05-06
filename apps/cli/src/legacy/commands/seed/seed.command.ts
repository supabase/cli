import { Command } from "effect/unstable/cli";
import { legacyBucketsCommand } from "./buckets/buckets.command.ts";

export const legacySeedCommand = Command.make("seed").pipe(
  Command.withDescription("Seed a Supabase project from supabase/config.toml."),
  Command.withShortDescription("Seed a Supabase project"),
  Command.withSubcommands([legacyBucketsCommand]),
);
