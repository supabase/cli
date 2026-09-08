import { Command } from "effect/unstable/cli";
import { INSPECT_DB_FLAGS, inspectDbCommandHandler } from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";
import { inspectDbToastSizes } from "./toast-sizes.handler.ts";

export const inspectDbToastSizesCommand = Command.make("toast-sizes", INSPECT_DB_FLAGS).pipe(
  Command.withDescription(
    "Displays TOAST table sizes and dead chunk counts for every user table that has overflow storage. " +
      "Autovacuum runs on TOAST relations independently, so dead chunks can accumulate even when the " +
      "main heap looks healthy.",
  ),
  Command.withShortDescription("Show TOAST table sizes and dead chunk counts"),
  Command.withHandler(inspectDbCommandHandler(inspectDbToastSizes)),
  Command.provide(inspectDbRuntimeLayer("toast-sizes")),
);
