import { Command } from "effect/unstable/cli";
import { INSPECT_DB_FLAGS, inspectDbCommandHandler } from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";
import { inspectDbXidAge } from "./xid-age.handler.ts";

export const inspectDbXidAgeCommand = Command.make("xid-age", INSPECT_DB_FLAGS).pipe(
  Command.withDescription(
    "Lists user tables with their transaction ID (XID) age, ordered from oldest to newest. " +
      "PostgreSQL wraps around at ~2 billion transactions; as a table's age approaches that limit " +
      "an emergency autovacuum freeze is forced, which can make the database temporarily unavailable. " +
      "Tables older than 1.5 billion transactions should be treated as urgent.",
  ),
  Command.withShortDescription("Show XID age for all tables"),
  Command.withHandler(inspectDbCommandHandler(inspectDbXidAge)),
  Command.provide(inspectDbRuntimeLayer("xid-age")),
);
