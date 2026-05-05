import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyInspectDbBloat } from "./bloat.handler.ts";

const config = {
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription(
      "Inspect the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.boolean("linked").pipe(Flag.withDescription("Inspect the linked project.")),
  local: Flag.boolean("local").pipe(Flag.withDescription("Inspect the local database.")),
} as const;

export type LegacyInspectDbBloatFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyInspectDbBloatCommand = Command.make("bloat", config).pipe(
  Command.withDescription("Estimates space allocated to a relation that is full of dead tuples."),
  Command.withShortDescription("Show relation bloat"),
  Command.withHandler((flags) => legacyInspectDbBloat(flags)),
);
