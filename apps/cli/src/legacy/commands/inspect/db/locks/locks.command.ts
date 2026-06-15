import { Command } from "effect/unstable/cli";
import { legacyInspectDbLocks } from "./locks.handler.ts";
import {
  LEGACY_INSPECT_DB_FLAGS,
  legacyInspectDbCommandHandler,
} from "../legacy-inspect-db-command.ts";
import { legacyInspectDbRuntimeLayer } from "../db.layers.ts";

export const legacyInspectDbLocksCommand = Command.make("locks", LEGACY_INSPECT_DB_FLAGS).pipe(
  Command.withDescription("Show queries which have taken out an exclusive lock on a relation."),
  Command.withShortDescription("Show exclusive locks"),
  Command.withHandler(legacyInspectDbCommandHandler(legacyInspectDbLocks)),
  Command.provide(legacyInspectDbRuntimeLayer("locks")),
);
