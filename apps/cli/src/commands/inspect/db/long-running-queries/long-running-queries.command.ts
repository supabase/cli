import { Command } from "effect/cli";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { inspectDbLongRunningQueries } from "./long-running-queries.handler.ts";
import {
  INSPECT_DB_FLAGS,
  INSPECT_DB_PERMISSIONS,
  inspectDbCommandHandler,
  withInspectDbTargetPolicy,
} from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";
import { cliConfigValuesLayer } from "../../../../config/cli-config-values.layer.ts";
import { withCliConfigFlags } from "../../../../config/cli-config-flags.ts";
import { makeCommand } from "../../../../shared/cli/cli-params.ts";

export const inspectDbLongRunningQueriesCommand = makeCommand(
  "long-running-queries",
  INSPECT_DB_FLAGS,
).pipe(
  Command.withDescription("Show currently running queries running for longer than 5 minutes."),
  Command.withShortDescription("Show long-running queries"),
  Command.withExamples([
    {
      command: "supabase inspect db long-running-queries",
      description: "Show long-running queries on the local database",
    },
    {
      command: "supabase inspect db long-running-queries --remote",
      description: "Show long-running queries on the linked project",
    },
  ]),
  withPermissions(INSPECT_DB_PERMISSIONS),
  Command.withHandler(inspectDbCommandHandler(inspectDbLongRunningQueries)),
  Command.provide(inspectDbRuntimeLayer("long-running-queries")),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(INSPECT_DB_FLAGS),
  withInspectDbTargetPolicy,
);
