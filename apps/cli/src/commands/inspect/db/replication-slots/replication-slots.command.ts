import { Command } from "effect/unstable/cli";
import { legacyInspectDbReplicationSlots } from "./replication-slots.handler.ts";
import {
  LEGACY_INSPECT_DB_FLAGS,
  legacyInspectDbCommandHandler,
} from "../legacy-inspect-db-command.ts";
import { legacyInspectDbRuntimeLayer } from "../db.layers.ts";

export const legacyInspectDbReplicationSlotsCommand = Command.make(
  "replication-slots",
  LEGACY_INSPECT_DB_FLAGS,
).pipe(
  Command.withDescription("Show information about replication slots on the database."),
  Command.withShortDescription("Show replication slots"),
  Command.withHandler(legacyInspectDbCommandHandler(legacyInspectDbReplicationSlots)),
  Command.provide(legacyInspectDbRuntimeLayer("replication-slots")),
);
