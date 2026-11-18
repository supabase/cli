import { Command } from "effect/cli";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { inspectDbLocks } from "./locks.handler.ts";
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

export const inspectDbLocksCommand = makeCommand("locks", INSPECT_DB_FLAGS).pipe(
  Command.withDescription("Show queries which have taken out an exclusive lock on a relation."),
  Command.withShortDescription("Show exclusive locks"),
  Command.withExamples([
    {
      command: "supabase inspect db locks",
      description: "Show exclusive locks on the local database",
    },
    {
      command: "supabase inspect db locks --remote",
      description: "Show exclusive locks on the linked project",
    },
  ]),
  withPermissions(INSPECT_DB_PERMISSIONS),
  Command.withHandler(inspectDbCommandHandler(inspectDbLocks)),
  Command.provide(inspectDbRuntimeLayer("locks")),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(INSPECT_DB_FLAGS),
  withInspectDbTargetPolicy,
);
