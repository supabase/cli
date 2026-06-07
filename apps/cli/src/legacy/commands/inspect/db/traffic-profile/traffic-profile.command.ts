import { Command, Flag } from "effect/unstable/cli";
import { legacyInspectDbTrafficProfile } from "./traffic-profile.handler.ts";

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

export const legacyInspectDbTrafficProfileCommand = Command.make("traffic-profile", config).pipe(
  Command.withDescription(
    "Show read/write activity ratio for tables based on block I/O operations.",
  ),
  Command.withShortDescription("Show traffic profile"),
  Command.withHandler((flags) => legacyInspectDbTrafficProfile(flags)),
);
