import { Command } from "effect/unstable/cli";
import { legacyInspectDbBlocking } from "./blocking.handler.ts";
import {
  LEGACY_INSPECT_DB_FLAGS,
  legacyInspectDbCommandHandler,
} from "../legacy-inspect-db-command.ts";
import { legacyInspectDbRuntimeLayer } from "../db.layers.ts";

export const legacyInspectDbBlockingCommand = Command.make(
  "blocking",
  LEGACY_INSPECT_DB_FLAGS,
).pipe(
  Command.withDescription(
    "Show queries that are holding locks and the queries that are waiting for them to be released.",
  ),
  Command.withShortDescription("Show blocking queries"),
  Command.withHandler(legacyInspectDbCommandHandler(legacyInspectDbBlocking)),
  Command.provide(legacyInspectDbRuntimeLayer("blocking")),
);
