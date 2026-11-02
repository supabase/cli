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
    "Lists user tables with their transaction ID (XID) age, oldest first. " +
      "Transactions remaining is the headroom to a 2 billion threshold, below PostgreSQL's ~2.1 billion wraparound limit. " +
      "Autovacuum forces a freeze once a table passes autovacuum_freeze_max_age, and PostgreSQL stops assigning XIDs near the limit. " +
      "Tables older than 1.5 billion transactions should be treated as urgent.",
  ),
  Command.withShortDescription("Show XID age for user tables"),
  withPermissions(INSPECT_DB_PERMISSIONS),
  Command.withHandler(inspectDbCommandHandler(inspectDbXidAge)),
  Command.provide(inspectDbRuntimeLayer("xid-age")),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(INSPECT_DB_FLAGS),
  withInspectDbTargetPolicy,
);
