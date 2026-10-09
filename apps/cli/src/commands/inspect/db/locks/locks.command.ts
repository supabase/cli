import { Command } from "effect/unstable/cli";
import { inspectDbLocks } from "./locks.handler.ts";
import { INSPECT_DB_FLAGS, inspectDbCommandHandler } from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";
import { cliConfigValuesLayer } from "../../../../config/cli-config-values.layer.ts";
import { withCliConfigFlags } from "../../../../config/cli-config-flags.ts";

export const inspectDbLocksCommand = Command.make("locks", INSPECT_DB_FLAGS).pipe(
  Command.withDescription("Show queries which have taken out an exclusive lock on a relation."),
  Command.withShortDescription("Show exclusive locks"),
  Command.withHandler(inspectDbCommandHandler(inspectDbLocks)),
  Command.provide(inspectDbRuntimeLayer("locks")),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(INSPECT_DB_FLAGS),
);
