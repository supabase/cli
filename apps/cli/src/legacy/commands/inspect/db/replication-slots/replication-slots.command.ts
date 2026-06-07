import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyInspectDbReplicationSlots } from "./replication-slots.handler.ts";

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

export type LegacyInspectDbReplicationSlotsFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyInspectDbReplicationSlotsCommand = Command.make(
  "replication-slots",
  config,
).pipe(
  Command.withDescription("Show information about replication slots on the database."),
  Command.withShortDescription("Show replication slots"),
  Command.withHandler((flags) => legacyInspectDbReplicationSlots(flags)),
);
