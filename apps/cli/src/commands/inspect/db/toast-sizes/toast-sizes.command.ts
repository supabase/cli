import { Command } from "effect/unstable/cli";
import { INSPECT_DB_FLAGS, inspectDbCommandHandler } from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";
import { inspectDbToastSizes } from "./toast-sizes.handler.ts";

export const inspectDbToastSizesCommand = Command.make("toast-sizes", INSPECT_DB_FLAGS).pipe(
  Command.withDescription(
    "Displays TOAST table sizes and dead chunk counts for every user table that has a TOAST table. " +
      "Tables with TEXT, JSONB, or bytea columns store overflow values in a separate TOAST relation. " +
      "Autovacuum runs on the TOAST table independently, so it can accumulate dead chunks even when " +
      "the main heap looks healthy. A table that appears fine by dead-tuple count alone can still " +
      "have significant TOAST bloat that wastes disk and slows queries.",
  ),
  Command.withShortDescription("Show TOAST table sizes and dead chunk counts"),
  Command.withHandler(inspectDbCommandHandler(inspectDbToastSizes)),
  Command.provide(inspectDbRuntimeLayer("toast-sizes")),
);
