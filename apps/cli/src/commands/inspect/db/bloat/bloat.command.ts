import { Command } from "effect/cli";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { inspectDbBloat } from "./bloat.handler.ts";
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

export const inspectDbBloatCommand = makeCommand("bloat", INSPECT_DB_FLAGS).pipe(
  Command.withDescription("Estimates space allocated to a relation that is full of dead tuples."),
  Command.withShortDescription("Show relation bloat"),
  Command.withExamples([
    {
      command: "supabase inspect db bloat",
      description: "Estimate dead-tuple bloat on the local database",
    },
    {
      command: "supabase inspect db bloat --remote",
      description: "Estimate bloat on the linked project",
    },
  ]),
  withPermissions(INSPECT_DB_PERMISSIONS),
  Command.withHandler(inspectDbCommandHandler(inspectDbBloat)),
  Command.provide(inspectDbRuntimeLayer("bloat")),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(INSPECT_DB_FLAGS),
  withInspectDbTargetPolicy,
);
