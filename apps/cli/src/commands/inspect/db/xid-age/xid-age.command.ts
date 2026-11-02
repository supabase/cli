import { Command } from "effect/cli";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { inspectDbXidAge } from "./xid-age.handler.ts";
import {
  INSPECT_DB_FLAGS,
  INSPECT_DB_PERMISSIONS,
  inspectDbCommandHandler,
  withInspectDbTargetPolicy,
} from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";
import { cliConfigValuesLayer } from "../../../../config/cli-config-values.layer.ts";
import { withCliConfigFlags } from "../../../../config/cli-config-flags.ts";

export const inspectDbXidAgeCommand = Command.make("xid-age", INSPECT_DB_FLAGS).pipe(
  Command.withDescription(
    "Lists user tables with their transaction ID (XID) age, ordered from oldest to newest. " +
      "PostgreSQL wraps around at ~2 billion transactions; as a table's age approaches that limit " +
      "an emergency autovacuum freeze is forced, which can make the database temporarily unavailable. " +
      "Tables older than 1.5 billion transactions should be treated as urgent.",
  ),
  Command.withShortDescription("Show XID age for all tables"),
  withPermissions(INSPECT_DB_PERMISSIONS),
  Command.withHandler(inspectDbCommandHandler(inspectDbXidAge)),
  Command.provide(inspectDbRuntimeLayer("xid-age")),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(INSPECT_DB_FLAGS),
  withInspectDbTargetPolicy,
);
