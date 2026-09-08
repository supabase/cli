import { Command } from "effect/unstable/cli";
import { inspectDbReplicationSlots } from "./replication-slots.handler.ts";
import { INSPECT_DB_FLAGS, inspectDbCommandHandler } from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";

export const inspectDbReplicationSlotsCommand = Command.make(
  "replication-slots",
  INSPECT_DB_FLAGS,
).pipe(
  Command.withDescription("Show information about replication slots on the database."),
  Command.withShortDescription("Show replication slots"),
  Command.withHandler(inspectDbCommandHandler(inspectDbReplicationSlots)),
  Command.provide(inspectDbRuntimeLayer("replication-slots")),
);
