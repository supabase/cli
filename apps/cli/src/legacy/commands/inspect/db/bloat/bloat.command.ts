import { Command } from "effect/unstable/cli";
import { legacyInspectDbBloat } from "./bloat.handler.ts";
import {
  LEGACY_INSPECT_DB_FLAGS,
  legacyInspectDbCommandHandler,
} from "../legacy-inspect-db-command.ts";
import { legacyInspectDbRuntimeLayer } from "../db.layers.ts";

export const legacyInspectDbBloatCommand = Command.make("bloat", LEGACY_INSPECT_DB_FLAGS).pipe(
  Command.withDescription("Estimates space allocated to a relation that is full of dead tuples."),
  Command.withShortDescription("Show relation bloat"),
  Command.withHandler(legacyInspectDbCommandHandler(legacyInspectDbBloat)),
  Command.provide(legacyInspectDbRuntimeLayer("bloat")),
);
