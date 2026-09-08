import { Command } from "effect/unstable/cli";
import { inspectDbBloat } from "./bloat.handler.ts";
import { INSPECT_DB_FLAGS, inspectDbCommandHandler } from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";

export const inspectDbBloatCommand = Command.make("bloat", INSPECT_DB_FLAGS).pipe(
  Command.withDescription("Estimates space allocated to a relation that is full of dead tuples."),
  Command.withShortDescription("Show relation bloat"),
  Command.withHandler(inspectDbCommandHandler(inspectDbBloat)),
  Command.provide(inspectDbRuntimeLayer("bloat")),
);
